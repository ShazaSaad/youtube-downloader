from pathlib import Path
from typing import Any, Callable, Dict, Optional

import yt_dlp

ProgressCallback = Optional[Callable[[str], None]]

# Keys must match API / frontend `quality` values.
FORMAT_PRESETS: Dict[str, Dict[str, Any]] = {
    "best_mp4": {
        "format": "bestvideo+bestaudio/best",
        "merge_output_format": "mp4",
    },
    "1080": {
        "format": "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        "merge_output_format": "mp4",
    },
    "720": {
        "format": "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
        "merge_output_format": "mp4",
    },
    "480": {
        "format": "bestvideo[height<=480]+bestaudio/best[height<=480]/best",
        "merge_output_format": "mp4",
    },
    "audio_mp3": {
        "format": "bestaudio/best",
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ],
    },
}

DEFAULT_QUALITY = "best_mp4"


def get_video_preview(url: str):
    if not url or not url.strip():
        raise ValueError("A valid YouTube URL is required.")

    ydl_opts = {
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

        return {
            "title": info.get("title", "Unknown title"),
            "channel": info.get("uploader") or info.get("channel") or "Unknown channel",
            "duration": info.get("duration"),
            "view_count": info.get("view_count"),
            "thumbnail": info.get("thumbnail"),
            "webpage_url": info.get("webpage_url") or url.strip(),
        }
    except Exception as exc:
        raise RuntimeError(f"Preview failed: {exc}") from exc

def download_video(
    url: str,
    output_path: str = "downloads",
    progress_callback: ProgressCallback = None,
    quality: str = DEFAULT_QUALITY,
):
    if not url or not url.strip():
        raise ValueError("A valid YouTube URL is required.")

    preset = FORMAT_PRESETS.get(quality)
    if preset is None:
        raise ValueError(f"Unknown quality preset: {quality!r}")

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
            if quality == "audio_mp3":
                emit("Download finished. Converting to MP3...")
            else:
                emit("Download finished. Merging audio and video...")

    ydl_opts = {
        "outtmpl": str(output_dir / "%(title)s.%(ext)s"),
        "ffmpeg_location": r"ffmpeg",
        "progress_hooks": [progress_hook],
        "noplaylist": True,
        **preset,
    }

    emit("Starting download...")

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            file_path = ydl.prepare_filename(info)
            if info.get("filepath"):
                file_path = info["filepath"]
            elif info.get("requested_downloads"):
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
