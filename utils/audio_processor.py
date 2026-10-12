import yt_dlp
from pydub import AudioSegment
import os
import shutil
import tempfile
import glob

DOWNLOAD_DIR = 'downloades'
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

def download_youtube_audio(url: str) -> str:
    cookies_path = "/etc/secrets/cookies.txt"

    if not os.path.isfile(cookies_path):
        raise RuntimeError(
            "Render cookie secret not found at /etc/secrets/cookies.txt. "
            "Check the secret file name and mount path."
        )

    # Validate the cookie file format without printing cookie contents.
    with open(cookies_path, "r", encoding="utf-8-sig") as f:
        first_line = f.readline().strip()

    if first_line not in (
        "# HTTP Cookie File",
        "# Netscape HTTP Cookie File",
    ):
        raise RuntimeError(
            "Invalid cookies.txt format. Export cookies in "
            "Mozilla/Netscape format and redeploy."
        )

    # Use a unique directory for each download.
    job_dir = os.path.join(DOWNLOAD_DIR, os.urandom(8).hex())
    os.makedirs(job_dir, exist_ok=True)

    output_template = os.path.join(job_dir, "audio.%(ext)s")

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": output_template,
        "cookiefile": cookies_path,
        "noplaylist": True,
        "quiet": False,
        "socket_timeout": 30,
        "retries": 2,
        "extractor_retries": 2,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "wav",
            }
        ],
    }

    try:
        print("Starting YouTube audio extraction...")

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.extract_info(url, download=True)

        wav_files = glob.glob(os.path.join(job_dir, "*.wav"))

        if not wav_files:
            raise RuntimeError(
                "Download completed but no WAV file was generated. "
                "Check the FFmpeg installation and Render logs."
            )

        wav_path = wav_files[0]
        print("YouTube audio downloaded and converted successfully.")

        return wav_path

    except yt_dlp.utils.DownloadError as exc:
        message = str(exc).lower()

        if (
            "sign in to confirm" in message
            or "not a bot" in message
        ):
            raise RuntimeError(
                "YouTube blocked the request with a verification check. "
                "Check cookie validity and retry later, or upload "
                "the audio/video file directly."
            ) from exc

        raise RuntimeError(
            f"YouTube download failed: {exc}"
        ) from exc


def convert_to_wav(input_path: str) -> str:
    output_path = os.path.splitext(input_path)[0] + "_converted.wav"
    audio = AudioSegment.from_file(input_path)
    audio = audio.set_channels(1).set_frame_rate(16000)
    audio.export(output_path, format="wav")
    return output_path

def chunk_audio(wav_path: str, chunk_minutes: int = 10) -> list:
    audio = AudioSegment.from_wav(wav_path)
    chunk_ms = chunk_minutes * 60 * 1000 
    chunks = []

    for i, start in enumerate(range(0, len(audio), chunk_ms)):
        chunk = audio[start : start + chunk_ms]
        chunk_path = f"{wav_path}_chunk_{i}.wav"
        chunk.export(chunk_path, format="wav")
        chunks.append(chunk_path)
    
    return chunks

def process_input(source: str) -> list:
    if source.startswith("http://") or source.startswith("https://"):
        print("Detected YouTube URL. Downloading audio...")
        wav_path = download_youtube_audio(source)
    else:
        print("Detected local file. Converting to WAV...")
        wav_path = convert_to_wav(source)

    print("Chunking audio...")
    chunks = chunk_audio(wav_path)
    print(f"Audio ready — {len(chunks)} chunk(s) created.")
    return chunks