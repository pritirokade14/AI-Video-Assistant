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
            "cookies.txt not found at /etc/secrets/cookies.txt. "
            "Check your Render Secret Files configuration."
        )

    # Create a writable temporary copy of the read-only secret.
    writable_cookies_path = os.path.join(
        tempfile.gettempdir(),
        f"cookies_{os.urandom(8).hex()}.txt"
    )

    try:
        shutil.copyfile(cookies_path, writable_cookies_path)

        # Validate the copied cookie file.
        with open(
            writable_cookies_path, "r", encoding="utf-8-sig"
        ) as f:
            first_line = f.readline().strip()

        if first_line not in (
            "# HTTP Cookie File",
            "# Netscape HTTP Cookie File",
        ):
            raise RuntimeError(
                "Invalid cookies.txt format. Use a valid "
                "Mozilla/Netscape-format cookie export."
            )

        job_dir = os.path.join(
            DOWNLOAD_DIR, os.urandom(8).hex()
        )
        os.makedirs(job_dir, exist_ok=True)

        output_template = os.path.join(
            job_dir, "audio.%(ext)s"
        )

        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": output_template,
            "cookiefile": writable_cookies_path,
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

        print("Starting YouTube audio extraction...")

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.extract_info(url, download=True)

        wav_files = glob.glob(
            os.path.join(job_dir, "*.wav")
        )

        if not wav_files:
            raise RuntimeError(
                "No WAV file was generated. Check FFmpeg "
                "installation and Render logs."
            )

        print("YouTube audio downloaded successfully.")
        return wav_files[0]

    except yt_dlp.utils.DownloadError as exc:
        message = str(exc).lower()

        if (
            "sign in to confirm" in message
            or "not a bot" in message
        ):
            raise RuntimeError(
                "YouTube requires verification. The cookies may "
                "be expired or rejected by YouTube, or the Render "
                "server may be blocked. Try uploading the audio "
                "or video file directly."
            ) from exc

        raise RuntimeError(
            f"YouTube download failed: {exc}"
        ) from exc

    finally:
        # Remove the temporary cookie copy after processing.
        try:
            if os.path.exists(writable_cookies_path):
                os.remove(writable_cookies_path)
        except OSError:
            print("Warning: Could not remove temporary cookie copy.")


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