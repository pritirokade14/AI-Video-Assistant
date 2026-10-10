import os
import uuid
import shutil
import traceback
from datetime import datetime
from enum import Enum
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from utils.audio_processor import process_input
from core.transcriber import transcribe_all
from core.summarizer import summarize, generate_title
from core.extractor import extract_action_items, extract_key_decisions, extract_questions
from core.rag_engine import build_rag_chain, ask_question

load_dotenv()

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
os.makedirs(UPLOAD_DIR, exist_ok=True)

app = FastAPI(title="AI Video Assistant API", version="1.0.0")

if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class JobStatus(str, Enum):
    QUEUED = "queued"
    PROCESSING = "processing"
    DONE = "done"
    ERROR = "error"

jobs: dict[str, dict] = {}

def _new_job() -> str:
    job_id = str(uuid.uuid4())
    jobs[job_id] = {
        "id": job_id,
        "status": JobStatus.QUEUED,
        "stage": "queued",
        "created_at": datetime.utcnow().isoformat(),
        "error": None,
        "result": None,
        "rag_chain": None,  
    }
    return job_id


def _set_stage(job_id: str, stage: str):
    if job_id in jobs:
        jobs[job_id]["stage"] = stage


def _run_pipeline_job(job_id: str, source: str, language: str):
    """Runs the full pipeline and stores results in the job dict."""
    try:
        jobs[job_id]["status"] = JobStatus.PROCESSING

        _set_stage(job_id, "processing_input")
        chunks = process_input(source)

        _set_stage(job_id, "transcribing")
        transcript = transcribe_all(chunks, language)

        _set_stage(job_id, "generating_title")
        title = generate_title(transcript)

        _set_stage(job_id, "summarizing")
        summary = summarize(transcript)

        _set_stage(job_id, "extracting_action_items")
        action_items = extract_action_items(transcript)

        _set_stage(job_id, "extracting_decisions")
        decisions = extract_key_decisions(transcript)

        _set_stage(job_id, "extracting_questions")
        questions = extract_questions(transcript)

        _set_stage(job_id, "building_rag_chain")
        rag_chain = build_rag_chain(transcript)

        jobs[job_id]["result"] = {
            "title": title,
            "transcript": transcript,
            "summary": summary,
            "action_items": action_items,
            "key_decisions": decisions,
            "open_questions": questions,
        }
        jobs[job_id]["rag_chain"] = rag_chain
        jobs[job_id]["status"] = JobStatus.DONE
        jobs[job_id]["stage"] = "done"

    except Exception as exc:  
        jobs[job_id]["status"] = JobStatus.ERROR
        jobs[job_id]["error"] = f"{exc}"
        jobs[job_id]["stage"] = "error"
        traceback.print_exc()

class ProcessURLRequest(BaseModel):
    source: str
    language: str = "english"


class ChatRequest(BaseModel):
    question: str

class JobResponse(BaseModel):
    job_id: str
    status: JobStatus

@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/process/url", response_model=JobResponse)
def process_url(req: ProcessURLRequest, background_tasks: BackgroundTasks):
    """Kick off processing for a YouTube URL (or any source your
    process_input() supports that isn't a local upload)."""
    if not req.source.strip():
        raise HTTPException(status_code=400, detail="source is required")

    job_id = _new_job()
    background_tasks.add_task(_run_pipeline_job, job_id, req.source, req.language)
    return JobResponse(job_id=job_id, status=JobStatus.QUEUED)


@app.post("/api/process/upload", response_model=JobResponse)
def process_upload(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    language: str = Form("english"),
):
    """Kick off processing for a locally uploaded video/audio file."""
    job_id = _new_job()
    dest_path = os.path.join(UPLOAD_DIR, f"{job_id}_{file.filename}")

    with open(dest_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    background_tasks.add_task(_run_pipeline_job, job_id, dest_path, language)
    return JobResponse(job_id=job_id, status=JobStatus.QUEUED)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")

    response = {
        "id": job["id"],
        "status": job["status"],
        "stage": job["stage"],
        "created_at": job["created_at"],
        "error": job["error"],
    }
    if job["status"] == JobStatus.DONE:
        response["result"] = job["result"]
    return response


@app.post("/api/jobs/{job_id}/chat")
def chat(job_id: str, req: ChatRequest):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    if job["status"] != JobStatus.DONE:
        raise HTTPException(status_code=409, detail="job is not ready yet")
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="question is required")

    try:
        answer = ask_question(job["rag_chain"], req.question)
    except Exception as exc:  
        raise HTTPException(status_code=500, detail=f"chat failed: {exc}") from exc

    return {"question": req.question, "answer": answer}


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="job not found")
    del jobs[job_id]
    return {"deleted": job_id}


