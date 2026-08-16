/* =========================================================
   AI Video Assistant — script.js
   Vanilla JS. Talks to the FastAPI backend only.
   ========================================================= */

// ---------------------------------------------------------
// Configuration
// ---------------------------------------------------------
const API_BASE_URL = "http://127.0.0.1:8000";

// Backend stage -> overall progress percentage
const STAGE_PROGRESS = {
  queued: 5,
  processing_input: 15,
  transcribing: 30,
  generating_title: 45,
  summarizing: 55,
  extracting_action_items: 65,
  extracting_decisions: 72,
  extracting_questions: 80,
  building_rag_chain: 92,
  done: 100,
  error: 100,
};

// Ordered timeline shown on the processing screen
const TIMELINE_STAGES = [
  { key: "processing_input", label: "Processing Input" },
  { key: "transcribing", label: "Transcribing" },
  { key: "generating_title", label: "Generating Title" },
  { key: "summarizing", label: "Summarizing" },
  { key: "extracting_action_items", label: "Extracting Action Items" },
  { key: "extracting_decisions", label: "Extracting Key Decisions" },
  { key: "extracting_questions", label: "Extracting Open Questions" },
  { key: "building_rag_chain", label: "Building AI Assistant" },
];

const POLL_INTERVAL_MS = 2500;

// ---------------------------------------------------------
// State
// ---------------------------------------------------------
const state = {
  currentJobId: localStorage.getItem("currentJobId") || null,
  currentJob: null,
  jobsMeta: loadJobsMeta(), // { [jobId]: { title, sourceType, language, createdAt } }
  pollHandle: null,
  chatMessages: [], // { role: 'user' | 'ai', text: string }
  transcriptSearchTerm: "",
  uploadFile: null,
};

// ---------------------------------------------------------
// Local storage helpers (job metadata only — results always
// come from the backend, never cached as fake data)
// ---------------------------------------------------------
function loadJobsMeta() {
  try {
    return JSON.parse(localStorage.getItem("jobsMeta") || "{}");
  } catch {
    return {};
  }
}

function saveJobsMeta() {
  localStorage.setItem("jobsMeta", JSON.stringify(state.jobsMeta));
}

function rememberJob(jobId, meta) {
  state.jobsMeta[jobId] = { ...(state.jobsMeta[jobId] || {}), ...meta };
  saveJobsMeta();
}

function forgetJob(jobId) {
  delete state.jobsMeta[jobId];
  saveJobsMeta();
}

// ---------------------------------------------------------
// Generic API request helper
// ---------------------------------------------------------
async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, options);
  } catch (err) {
    throw new ApiError(
      "Unable to connect to the AI Video Assistant server. Please make sure the backend is running.",
      0
    );
  }

  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      detail = body.detail || detail;
    } catch {
      /* ignore parse errors */
    }
    throw new ApiError(detail, response.status);
  }

  if (response.status === 204) return null;
  return response.json();
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------
// Toasts / error surface
// ---------------------------------------------------------
function showToast(message, type = "info", title = "") {
  const stack = document.getElementById("toastStack");
  const icons = { info: "fa-circle-info", success: "fa-circle-check", error: "fa-circle-exclamation" };
  const titles = { info: title || "Notice", success: title || "Success", error: title || "Something went wrong" };

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <i class="fa-solid ${icons[type]}"></i>
    <div><strong>${escapeHtml(titles[type])}</strong>${escapeHtml(message)}</div>
  `;
  stack.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 300ms ease";
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

function showError(message) {
  showToast(message, "error");
}

// ---------------------------------------------------------
// Utilities
// ---------------------------------------------------------
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function wordCount(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function timeAgo(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Parses a numbered/bulleted plain-text list returned by the LLM
 * (e.g. "1. Do X\n2. Do Y") into a clean array of strings.
 * Falls back to splitting on newlines if no numbering is found.
 */
function parseListText(text) {
  if (!text) return [];
  if (Array.isArray(text)) return text.filter(Boolean);

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const items = [];
  let buffer = "";

  const startsNewItem = (line) => /^(\d+[\.\)]|[-*•])\s+/.test(line);

  for (const line of lines) {
    if (startsNewItem(line)) {
      if (buffer) items.push(buffer.trim());
      buffer = line.replace(/^(\d+[\.\)]|[-*•])\s+/, "");
    } else if (buffer) {
      buffer += " " + line;
    } else {
      buffer = line;
    }
  }
  if (buffer) items.push(buffer.trim());

  // If nothing looked like a list, treat non-empty lines as items
  if (items.length === 0) return lines;
  return items;
}

function isNoneFound(text) {
  if (!text) return true;
  const t = text.trim().toLowerCase();
  return (
    t.startsWith("no action items") ||
    t.startsWith("no key decisions") ||
    t.startsWith("no open questions") ||
    t.length === 0
  );
}

// ---------------------------------------------------------
// Navigation / view switching
// ---------------------------------------------------------
function switchView(viewName, opts = {}) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const target = document.getElementById(`view-${viewName}`);
  if (target) target.classList.add("active");

  document.querySelectorAll(".nav-item").forEach((n) => {
    n.classList.toggle("active", n.dataset.view === viewName);
  });

  closeSidebarMobile();
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });

  if (viewName !== "processing" && state.pollHandle) {
    // Leaving the processing screen — no need to keep polling in the background
    // unless the user is actively viewing the results of the same job.
  }

  if (viewName === "jobs") renderJobsList();
  if (viewName === "chat") renderChat();
  if (!opts.silent) window.location.hash = viewName;
}

function initNav() {
  document.querySelectorAll(".nav-item[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
}

// ---------------------------------------------------------
// Mobile sidebar
// ---------------------------------------------------------
function openSidebarMobile() {
  document.getElementById("sidebar").classList.add("open");
  document.getElementById("sidebarOverlay").classList.add("open");
}
function closeSidebarMobile() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebarOverlay").classList.remove("open");
}

// ---------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------
function initTheme() {
  const saved = localStorage.getItem("theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);

  const toggles = [document.getElementById("darkModeToggle"), document.getElementById("darkModeToggleSettings")];
  toggles.forEach((t) => t && (t.checked = saved === "dark"));

  const applyTheme = (isDark) => {
    const theme = isDark ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
    toggles.forEach((t) => t && (t.checked = isDark));
  };

  toggles.forEach((t) => t && t.addEventListener("change", () => applyTheme(t.checked)));
}

// ---------------------------------------------------------
// Dashboard — YouTube URL submission
// ---------------------------------------------------------
function isLikelyYoutubeUrl(url) {
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(url.trim());
}

async function processYouTubeURL() {
  const input = document.getElementById("youtubeUrlInput");
  const langSelect = document.getElementById("youtubeLangSelect");
  const btn = document.getElementById("youtubeSubmitBtn");
  const url = input.value.trim();

  if (!url || !isLikelyYoutubeUrl(url)) {
    showError("Please enter a valid YouTube URL.");
    return;
  }

  const language = langSelect.value;
  setBtnLoading(btn, true, "Starting…");

  try {
    const data = await apiRequest("/api/process/url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: url, language }),
    });

    startJob(data.job_id, {
      title: url,
      sourceType: "YouTube",
      language,
      createdAt: new Date().toISOString(),
    });
    input.value = "";
  } catch (err) {
    showError(err.message);
  } finally {
    setBtnLoading(btn, false, "Process Video");
  }
}

// ---------------------------------------------------------
// Dashboard — Upload
// ---------------------------------------------------------
function initDropzone() {
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");

  dropzone.addEventListener("click", () => fileInput.click());

  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag-over");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag-over");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files?.[0];
    if (file) setSelectedFile(file);
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files?.[0]) setSelectedFile(fileInput.files[0]);
  });
}

function setSelectedFile(file) {
  const validTypes = /\.(mp4|mp3|wav|mov|m4a|webm|avi|mkv)$/i;
  if (!validTypes.test(file.name)) {
    showError("Please choose a supported video or audio file (MP4, MP3, WAV, MOV).");
    return;
  }
  state.uploadFile = file;
  const dz = document.getElementById("dropzone");
  dz.innerHTML = `
    <i class="fa-solid fa-circle-check" style="color: var(--success);"></i>
    <div class="dz-file">${escapeHtml(file.name)}</div>
    <div class="dz-sub">${(file.size / (1024 * 1024)).toFixed(1)} MB · click to change</div>
  `;
}

function resetDropzone() {
  state.uploadFile = null;
  document.getElementById("fileInput").value = "";
  const dz = document.getElementById("dropzone");
  dz.innerHTML = `
    <i class="fa-solid fa-cloud-arrow-up"></i>
    <div class="dz-title">Drag & drop your file here</div>
    <div class="dz-sub">or click to browse</div>
    <div class="dz-types">MP4 &nbsp;•&nbsp; MP3 &nbsp;•&nbsp; WAV &nbsp;•&nbsp; MOV</div>
  `;
}

async function uploadFile() {
  const langSelect = document.getElementById("uploadLangSelect");
  const btn = document.getElementById("uploadSubmitBtn");

  if (!state.uploadFile) {
    showError("Please choose a video or audio file first.");
    return;
  }

  const language = langSelect.value;
  const formData = new FormData();
  formData.append("file", state.uploadFile);
  formData.append("language", language);

  setBtnLoading(btn, true, "Uploading…");

  try {
    const data = await apiRequest("/api/process/upload", {
      method: "POST",
      body: formData,
    });

    startJob(data.job_id, {
      title: state.uploadFile.name,
      sourceType: "Upload",
      language,
      createdAt: new Date().toISOString(),
    });
    resetDropzone();
  } catch (err) {
    showError(err.message);
  } finally {
    setBtnLoading(btn, false, "Upload & Process");
  }
}

function setBtnLoading(btn, loading, label) {
  btn.disabled = loading;
  btn.innerHTML = loading
    ? `<i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(label)}`
    : `${escapeHtml(label)} <i class="fa-solid fa-arrow-right"></i>`;
}

// ---------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------
function startJob(jobId, meta) {
  state.currentJobId = jobId;
  localStorage.setItem("currentJobId", jobId);
  rememberJob(jobId, { ...meta, status: "queued", stage: "queued" });

  renderProcessingHeader(meta, jobId);
  switchView("processing");
  startPolling(jobId);
}

function startPolling(jobId) {
  stopPolling();
  getJobStatus(jobId); // immediate check
  state.pollHandle = setInterval(() => getJobStatus(jobId), POLL_INTERVAL_MS);
}

function stopPolling() {
  if (state.pollHandle) {
    clearInterval(state.pollHandle);
    state.pollHandle = null;
  }
}

async function getJobStatus(jobId) {
  try {
    const job = await apiRequest(`/api/jobs/${jobId}`);
    state.currentJob = job;
    rememberJob(jobId, {
      status: job.status,
      stage: job.stage,
      title: job.result?.title || state.jobsMeta[jobId]?.title,
    });

    updateProcessingUI(job);

    if (job.status === "done") {
      stopPolling();
      setTimeout(() => showResults(job), 500);
    } else if (job.status === "error") {
      stopPolling();
      showProcessingError(job.error);
    }
  } catch (err) {
    stopPolling();
    showError(err.message);
  }
}

// ---------------------------------------------------------
// Processing UI
// ---------------------------------------------------------
function renderProcessingHeader(meta, jobId) {
  document.getElementById("procJobTitle").textContent = meta.title || "Processing job";
  document.getElementById("procJobSource").innerHTML = `<i class="fa-solid ${
    meta.sourceType === "YouTube" ? "fa-brands fa-youtube" : "fa-file-video"
  }"></i> ${escapeHtml(meta.sourceType)}`;
  document.getElementById("procJobId").innerHTML = `<i class="fa-solid fa-hashtag"></i> Job ID: ${jobId.slice(0, 8)}…`;
  document.getElementById("procJobLang").innerHTML = `<i class="fa-solid fa-language"></i> Language: ${escapeHtml(
    capitalize(meta.language)
  )}`;

  document.getElementById("processingError").classList.add("hidden");
  document.getElementById("processingContent").classList.remove("hidden");
  buildTimeline();
}

function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function buildTimeline() {
  const container = document.getElementById("timelineList");
  container.innerHTML = TIMELINE_STAGES.map(
    (s) => `
    <div class="timeline-step" data-stage="${s.key}">
      <div class="tl-line"></div>
      <div class="tl-dot"><i class="fa-solid fa-circle" style="font-size:6px;"></i></div>
      <div class="tl-text">
        <div class="tl-title">${escapeHtml(s.label)}</div>
      </div>
    </div>`
  ).join("");
}

function updateProcessingUI(job) {
  const pct = STAGE_PROGRESS[job.stage] ?? STAGE_PROGRESS[job.status] ?? 5;
  document.getElementById("progressFill").style.width = `${pct}%`;
  document.getElementById("progressPercent").textContent = `${pct}%`;

  const currentIndex = TIMELINE_STAGES.findIndex((s) => s.key === job.stage);

  document.querySelectorAll(".timeline-step").forEach((el, idx) => {
    el.classList.remove("done", "active");
    const icon = el.querySelector(".tl-dot i");
    if (job.status === "done" || idx < currentIndex) {
      el.classList.add("done");
      icon.className = "fa-solid fa-check";
    } else if (idx === currentIndex && job.status !== "done") {
      el.classList.add("active");
      icon.className = "fa-solid fa-spinner fa-spin";
    } else {
      icon.className = "fa-solid fa-circle";
      icon.style.fontSize = "6px";
    }
  });
}

function showProcessingError(errorMessage) {
  document.getElementById("processingContent").classList.add("hidden");
  const errBox = document.getElementById("processingError");
  errBox.classList.remove("hidden");
  document.getElementById("processingErrorMsg").textContent =
    errorMessage || "Video processing failed. Please try again.";
}

function retryProcessing() {
  const jobId = state.currentJobId;
  const meta = state.jobsMeta[jobId];
  if (!meta) {
    switchView("dashboard");
    return;
  }
  document.getElementById("processingError").classList.add("hidden");
  document.getElementById("processingContent").classList.remove("hidden");
  startPolling(jobId);
}

// ---------------------------------------------------------
// Results page
// ---------------------------------------------------------
function showResults(job) {
  state.currentJob = job;
  const result = job.result || {};
  const meta = state.jobsMeta[job.id] || {};

  document.getElementById("resultsTitle").textContent = result.title || meta.title || "Untitled video";

  // Overview: detail grid
  document.getElementById("detailTitle").textContent = result.title || meta.title || "—";
  document.getElementById("detailLanguage").textContent = capitalize(meta.language) || "—";
  document.getElementById("detailProcessed").textContent = formatDate(job.created_at);
  document.getElementById("detailStatus").textContent = "Completed";

  // Summary preview (overview) + full summary tab
  const summaryText = result.summary || "";
  document.getElementById("overviewSummaryPreview").textContent = summaryText || "No summary available.";
  document.getElementById("summaryFullContent").textContent = summaryText || "No summary available.";

  // Stats
  const actionItems = parseListText(result.action_items);
  const decisions = parseListText(result.key_decisions);
  const questions = parseListText(result.open_questions);
  const words = wordCount(result.transcript);

  document.getElementById("statActionItems").textContent = isNoneFound(result.action_items) ? 0 : actionItems.length;
  document.getElementById("statDecisions").textContent = isNoneFound(result.key_decisions) ? 0 : decisions.length;
  document.getElementById("statQuestions").textContent = isNoneFound(result.open_questions) ? 0 : questions.length;
  document.getElementById("statWords").textContent = words.toLocaleString();

  // Transcript
  document.getElementById("transcriptWordCount").textContent = `${words.toLocaleString()} words`;
  state.transcriptSearchTerm = "";
  document.getElementById("transcriptSearchInput").value = "";
  renderTranscript(result.transcript || "");

  // Action items
  renderActionItems(actionItems, result.action_items);

  // Decisions
  renderDecisions(decisions, result.key_decisions);

  // Questions
  renderQuestions(questions, result.open_questions);

  switchTab("overview");
  switchView("results");
}

function renderTranscript(transcript) {
  const box = document.getElementById("transcriptBox");
  if (!transcript) {
    box.innerHTML = `<div class="empty-state"><i class="fa-solid fa-file-lines"></i>No transcript available.</div>`;
    return;
  }
  const term = state.transcriptSearchTerm.trim();
  if (!term) {
    box.textContent = transcript;
    return;
  }
  const escaped = escapeHtml(transcript);
  const safeTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${safeTerm})`, "gi");
  box.innerHTML = escaped.replace(regex, "<mark class='hl'>$1</mark>");
}

function renderActionItems(items, raw) {
  const container = document.getElementById("actionItemsList");
  if (isNoneFound(raw) || items.length === 0) {
    container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-list-check"></i>No action items found.</div>`;
    return;
  }
  container.innerHTML = items
    .map(
      (item) => `
    <div class="checklist-item card">
      <i class="fa-solid fa-circle-check"></i>
      <p>${escapeHtml(item)}</p>
    </div>`
    )
    .join("");
}

function renderDecisions(items, raw) {
  const container = document.getElementById("decisionsList");
  if (isNoneFound(raw) || items.length === 0) {
    container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-gavel"></i>No key decisions found.</div>`;
    return;
  }
  container.innerHTML = items
    .map(
      (item, i) => `
    <div class="decision-item card">
      <div class="decision-num">${String(i + 1).padStart(2, "0")}</div>
      <p>${escapeHtml(item)}</p>
    </div>`
    )
    .join("");
}

function renderQuestions(items, raw) {
  const container = document.getElementById("questionsList");
  if (isNoneFound(raw) || items.length === 0) {
    container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-circle-question"></i>No open questions found.</div>`;
    return;
  }
  container.innerHTML = items
    .map(
      (item) => `
    <div class="question-item card">
      <div class="question-mark">?</div>
      <p>${escapeHtml(item)}</p>
    </div>`
    )
    .join("");
}

function switchTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabName));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${tabName}`));
}

function initTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
}

// ---------------------------------------------------------
// Copy / download helpers
// ---------------------------------------------------------
async function copyText(text, label = "Content") {
  try {
    await navigator.clipboard.writeText(text || "");
    showToast(`${label} copied to clipboard.`, "success");
  } catch {
    showError("Could not copy to clipboard.");
  }
}

function downloadTranscript() {
  const job = state.currentJob;
  const transcript = job?.result?.transcript || "";
  const blob = new Blob([transcript], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `transcript-${job?.id?.slice(0, 8) || "video"}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------
// Chat
// ---------------------------------------------------------
function renderChat() {
  const job = state.currentJob;
  const panelHead = document.getElementById("chatJobTitle");
  panelHead.textContent = job?.result?.title || "Select a video to chat about it";

  const messagesBox = document.getElementById("chatMessages");
  const inputRow = document.getElementById("chatInputRow");

  if (!job || job.status !== "done") {
    messagesBox.innerHTML = `
      <div class="chat-empty">
        <i class="fa-solid fa-comments"></i>
        <h4>No video selected</h4>
        <p>Process a video first, then come back here to ask questions about it.</p>
      </div>`;
    inputRow.classList.add("hidden");
    return;
  }

  inputRow.classList.remove("hidden");
  renderChatMessages();
}

function renderChatMessages() {
  const box = document.getElementById("chatMessages");
  if (state.chatMessages.length === 0) {
    box.innerHTML = `
      <div class="chat-empty">
        <i class="fa-solid fa-sparkles"></i>
        <h4>Ask anything about this video</h4>
        <p>Try one of the suggestions on the left, or type your own question below.</p>
      </div>`;
    return;
  }

  box.innerHTML = state.chatMessages
    .map((m, i) => {
      if (m.role === "user") {
        return `
        <div class="msg msg-user">
          <div class="msg-bubble">${escapeHtml(m.text)}</div>
        </div>`;
      }
      return `
      <div class="msg msg-ai">
        <div class="msg-bubble">${escapeHtml(m.text)}</div>
        <div class="msg-meta">
          <button class="msg-copy-btn" data-copy-index="${i}"><i class="fa-solid fa-copy"></i> Copy</button>
        </div>
      </div>`;
    })
    .join("");

  box.querySelectorAll("[data-copy-index]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.copyIndex);
      copyText(state.chatMessages[idx].text, "Response");
    });
  });

  box.scrollTop = box.scrollHeight;
}

function showTypingIndicator() {
  const box = document.getElementById("chatMessages");
  const el = document.createElement("div");
  el.className = "msg msg-ai";
  el.id = "typingIndicatorMsg";
  el.innerHTML = `<div class="msg-bubble typing-indicator"><span></span><span></span><span></span></div>`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function removeTypingIndicator() {
  document.getElementById("typingIndicatorMsg")?.remove();
}

async function sendChatMessage() {
  const job = state.currentJob;
  if (!job || job.status !== "done") {
    showError("Process a video before starting a chat.");
    return;
  }

  const textarea = document.getElementById("chatInput");
  const question = textarea.value.trim();
  if (!question) return;

  state.chatMessages.push({ role: "user", text: question });
  renderChatMessages();
  textarea.value = "";
  autoGrowTextarea(textarea);

  const sendBtn = document.getElementById("chatSendBtn");
  sendBtn.disabled = true;
  showTypingIndicator();

  try {
    const data = await apiRequest(`/api/jobs/${job.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    removeTypingIndicator();
    state.chatMessages.push({ role: "ai", text: data.answer });
    renderChatMessages();
  } catch (err) {
    removeTypingIndicator();
    state.chatMessages.push({ role: "ai", text: "Unable to generate an answer. Please try again." });
    renderChatMessages();
    showError(err.message || "Unable to generate an answer. Please try again.");
  } finally {
    sendBtn.disabled = false;
  }
}

function clearChat() {
  state.chatMessages = [];
  renderChatMessages();
}

function autoGrowTextarea(el) {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}

function initChatInput() {
  const textarea = document.getElementById("chatInput");
  textarea.addEventListener("input", () => autoGrowTextarea(textarea));
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
  document.getElementById("chatSendBtn").addEventListener("click", sendChatMessage);
  document.getElementById("clearChatBtn").addEventListener("click", clearChat);

  document.querySelectorAll(".suggestion-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      textarea.value = btn.textContent.trim();
      autoGrowTextarea(textarea);
      sendChatMessage();
    });
  });
}

function openChatForCurrentJob() {
  if (!state.currentJob || state.currentJob.status !== "done") {
    showError("This video isn't ready for chat yet.");
    return;
  }
  state.chatMessages = [];
  switchView("chat");
}

// ---------------------------------------------------------
// My Jobs page
// ---------------------------------------------------------
let jobsFilter = "all";

function initJobsFilters() {
  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".filter-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      jobsFilter = chip.dataset.filter;
      renderJobsList();
    });
  });
}

function statusBadge(status) {
  const map = {
    done: { cls: "badge-success", icon: "fa-circle-check", label: "Completed" },
    processing: { cls: "badge-warning", icon: "fa-spinner fa-spin", label: "Processing" },
    queued: { cls: "badge-neutral", icon: "fa-clock", label: "Queued" },
    error: { cls: "badge-danger", icon: "fa-circle-exclamation", label: "Error" },
  };
  const s = map[status] || map.queued;
  return `<span class="badge ${s.cls}"><i class="fa-solid ${s.icon}"></i> ${s.label}</span>`;
}

function renderJobsList() {
  const container = document.getElementById("jobsList");
  const entries = Object.entries(state.jobsMeta).sort(
    (a, b) => new Date(b[1].createdAt || 0) - new Date(a[1].createdAt || 0)
  );

  const filtered = entries.filter(([, meta]) => jobsFilter === "all" || meta.status === jobsFilter);

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state card card-pad">
        <i class="fa-solid fa-folder-open"></i>
        No jobs yet. Process a video from the dashboard to see it here.
      </div>`;
    return;
  }

  container.innerHTML = filtered
    .map(([jobId, meta]) => {
      const icon = meta.sourceType === "YouTube" ? "fa-brands fa-youtube" : "fa-file-video";
      return `
      <div class="job-row card card-hover" data-job-id="${jobId}">
        <div class="thumb"><i class="fa-solid ${icon}"></i></div>
        <div class="job-row-info">
          <div class="job-row-title">${escapeHtml(meta.title || "Untitled job")}</div>
          <div class="job-row-sub">${escapeHtml(meta.sourceType || "")} · ${escapeHtml(capitalize(meta.language || ""))}</div>
        </div>
        <div class="job-row-right">
          ${statusBadge(meta.status)}
          <span class="job-row-time">${timeAgo(meta.createdAt)}</span>
          <button class="btn btn-ghost btn-sm" data-open-job="${jobId}" title="Open"><i class="fa-solid fa-arrow-right"></i></button>
        </div>
      </div>`;
    })
    .join("");

  container.querySelectorAll("[data-open-job]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openJobFromList(btn.dataset.openJob);
    });
  });
  container.querySelectorAll(".job-row").forEach((row) => {
    row.addEventListener("click", () => openJobFromList(row.dataset.jobId));
  });
}

async function openJobFromList(jobId) {
  const meta = state.jobsMeta[jobId];
  if (!meta) return;

  state.currentJobId = jobId;
  localStorage.setItem("currentJobId", jobId);

  if (meta.status === "done") {
    try {
      const job = await apiRequest(`/api/jobs/${jobId}`);
      showResults(job);
    } catch (err) {
      showError(err.message);
    }
  } else if (meta.status === "error") {
    renderProcessingHeader(meta, jobId);
    switchView("processing");
    showProcessingError("Video processing failed. Please try again.");
  } else {
    renderProcessingHeader(meta, jobId);
    switchView("processing");
    startPolling(jobId);
  }
}

// ---------------------------------------------------------
// Delete job
// ---------------------------------------------------------
let jobPendingDelete = null;

function openDeleteModal(jobId) {
  jobPendingDelete = jobId || state.currentJobId;
  document.getElementById("deleteModal").classList.add("open");
}

function closeDeleteModal() {
  jobPendingDelete = null;
  document.getElementById("deleteModal").classList.remove("open");
}

async function confirmDeleteJob() {
  if (!jobPendingDelete) return;
  const jobId = jobPendingDelete;
  const btn = document.getElementById("confirmDeleteBtn");
  setBtnLoading(btn, true, "Deleting…");

  try {
    await apiRequest(`/api/jobs/${jobId}`, { method: "DELETE" });
    forgetJob(jobId);
    if (state.currentJobId === jobId) {
      state.currentJobId = null;
      state.currentJob = null;
      localStorage.removeItem("currentJobId");
    }
    showToast("Video analysis deleted.", "success");
    closeDeleteModal();
    switchView("jobs");
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `Delete`;
  }
}

// ---------------------------------------------------------
// Backend health check
// ---------------------------------------------------------
async function checkBackendHealth() {
  try {
    await apiRequest("/api/health");
  } catch {
    showError("Unable to connect to the AI Video Assistant server. Please make sure the backend is running.");
  }
}

// ---------------------------------------------------------
// Init
// ---------------------------------------------------------
function initEvents() {
  document.getElementById("menuToggle").addEventListener("click", openSidebarMobile);
  document.getElementById("sidebarOverlay").addEventListener("click", closeSidebarMobile);

  document.getElementById("youtubeSubmitBtn").addEventListener("click", processYouTubeURL);
  document.getElementById("youtubeUrlInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") processYouTubeURL();
  });
  document.getElementById("uploadSubmitBtn").addEventListener("click", uploadFile);

  document.getElementById("copySummaryBtn").addEventListener("click", () =>
    copyText(state.currentJob?.result?.summary, "Summary")
  );
  document.getElementById("copyTranscriptBtn").addEventListener("click", () =>
    copyText(state.currentJob?.result?.transcript, "Transcript")
  );
  document.getElementById("downloadTranscriptBtn").addEventListener("click", downloadTranscript);

  document.getElementById("transcriptSearchInput").addEventListener("input", (e) => {
    state.transcriptSearchTerm = e.target.value;
    renderTranscript(state.currentJob?.result?.transcript || "");
  });

  document.getElementById("viewFullSummaryLink").addEventListener("click", (e) => {
    e.preventDefault();
    switchTab("summary");
  });

  document.getElementById("chatWithAiBtn").addEventListener("click", openChatForCurrentJob);
  document.getElementById("deleteJobBtn").addEventListener("click", () => openDeleteModal(state.currentJobId));

  document.getElementById("retryProcessingBtn").addEventListener("click", retryProcessing);
  document.getElementById("backToDashboardBtn").addEventListener("click", () => switchView("dashboard"));

  document.getElementById("cancelDeleteBtn").addEventListener("click", closeDeleteModal);
  document.getElementById("confirmDeleteBtn").addEventListener("click", confirmDeleteJob);
  document.getElementById("deleteModal").addEventListener("click", (e) => {
    if (e.target.id === "deleteModal") closeDeleteModal();
  });

  document.getElementById("backToJobsLink").addEventListener("click", (e) => {
    e.preventDefault();
    switchView("jobs");
  });

  document.getElementById("clearJobHistoryBtn").addEventListener("click", () => {
    localStorage.removeItem("jobsMeta");
    state.jobsMeta = {};
    renderJobsList();
    showToast("Local job history cleared.", "success");
  });
}

function init() {
  initNav();
  initEvents();
  initDropzone();
  initTabs();
  initChatInput();
  initJobsFilters();
  initTheme();
  resetDropzone();
  checkBackendHealth();

  const initialView = window.location.hash?.replace("#", "") || "dashboard";
  switchView(["dashboard", "processing", "results", "chat", "jobs", "settings"].includes(initialView) ? initialView : "dashboard", {
    silent: true,
  });
}

document.addEventListener("DOMContentLoaded", init);