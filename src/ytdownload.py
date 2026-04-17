import yt_dlp
import os
from pathlib import Path
from typing import Callable, Optional

import yt_dlp

ProgressCallback = Optional[Callable[[str], None]]

def download_video(url: str, output_path: str = "downloads", progress_callback: ProgressCallback = None):
    if not url or not url.strip():
        raise ValueError("A valid YouTube URL is required.")

    output_dir = Path(output_path)
    output_dir.mkdir(parents=True, exist_ok=True)

    def emit(message: str):
        if progress_callback:
            progress_callback(message)

    def progress_hook(data):
        status = data.get("status")
        if status == "downloading":
            percent = data.get("_percent_str", "").strip()
            speed = data.get("_speed_str", "").strip()
            eta = data.get("_eta_str", "").strip()
            emit(f"Downloading... {percent} | Speed: {speed or 'N/A'} | ETA: {eta or 'N/A'}")
        elif status == "finished":
            emit("Download finished. Merging audio and video...")

    ydl_opts = {
        "outtmpl": str(output_dir / "%(title)s.%(ext)s"),
        "format": "bestvideo+bestaudio/best",
        "ffmpeg_location": r"ffmpeg",
        "progress_hooks": [progress_hook],
        "noplaylist": True,
    }

    emit("Starting download...")

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            file_path = ydl.prepare_filename(info)
            if info.get("requested_downloads"):
                candidate = info["requested_downloads"][0].get("filepath")
                if candidate:
                    file_path = candidate

        emit("Download completed successfully!")
        return {
            "title": info.get("title", "Unknown title"),
            "file_path": str(Path(file_path).resolve()),
        }
    except Exception as exc:
        raise RuntimeError(f"Download failed: {exc}") from exc
