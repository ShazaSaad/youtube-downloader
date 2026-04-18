from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

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
DEFAULT_OUTPUT_DIR = Path.home() / "Downloads"


def _parse_playlist_items(playlist_items: Optional[List[int]]) -> Optional[str]:
    if not playlist_items:
        return None
    valid_items = sorted({item for item in playlist_items if isinstance(item, int) and item > 0})
    if not valid_items:
        return None
    return ",".join(str(item) for item in valid_items)


def get_video_preview(url: str, playlist_mode: bool = False):
    if not url or not url.strip():
        raise ValueError("A valid YouTube URL is required.")

    ydl_opts = {
        "noplaylist": not playlist_mode,
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

        payload = {
            "title": info.get("title", "Unknown title"),
            "channel": info.get("uploader") or info.get("channel") or "Unknown channel",
            "duration": info.get("duration"),
            "view_count": info.get("view_count"),
            "thumbnail": info.get("thumbnail"),
            "webpage_url": info.get("webpage_url") or url.strip(),
        }
        if playlist_mode and info.get("_type") == "playlist":
            entries = [entry for entry in (info.get("entries") or []) if entry]
            payload["playlist"] = {
                "title": info.get("title", "Playlist"),
                "count": len(entries),
                "entries": [
                    {
                        "index": idx + 1,
                        "id": entry.get("id"),
                        "title": entry.get("title", f"Video {idx + 1}"),
                        "thumbnail": entry.get("thumbnail"),
                        "duration": entry.get("duration"),
                        "channel": entry.get("uploader") or entry.get("channel"),
                        "url": entry.get("webpage_url"),
                    }
                    for idx, entry in enumerate(entries[:25])
                ],
            }
        return payload
    except Exception as exc:
        raise RuntimeError(f"Preview failed: {exc}") from exc

def download_video(
    url: str,
    output_path: str = "",
    progress_callback: ProgressCallback = None,
    quality: str = DEFAULT_QUALITY,
    playlist_mode: bool = False,
    playlist_items: Optional[List[int]] = None,
    download_subtitles: bool = False,
    subtitle_languages: Optional[List[str]] = None,
    save_thumbnail_only: bool = False,
):
    if not url or not url.strip():
        raise ValueError("A valid YouTube URL is required.")

    preset = FORMAT_PRESETS.get(quality)
    if preset is None:
        raise ValueError(f"Unknown quality preset: {quality!r}")

    output_dir = Path(output_path).expanduser() if output_path and output_path.strip() else DEFAULT_OUTPUT_DIR
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
        "noplaylist": not playlist_mode,
        **preset,
    }
    if save_thumbnail_only:
        ydl_opts["skip_download"] = True
        ydl_opts["writethumbnail"] = True
    elif download_subtitles:
        ydl_opts["writesubtitles"] = True
        ydl_opts["writeautomaticsub"] = True
        ydl_opts["subtitleslangs"] = subtitle_languages or ["en"]

    playlist_items_spec = _parse_playlist_items(playlist_items)
    if playlist_items_spec:
        ydl_opts["playlist_items"] = playlist_items_spec

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
        result = {
            "title": info.get("title", "Unknown title"),
            "file_path": str(Path(file_path).resolve()),
        }
        if playlist_mode and info.get("_type") == "playlist":
            entries = [entry for entry in (info.get("entries") or []) if entry]
            result["playlist_count"] = len(entries)
            result["playlist_title"] = info.get("title", "Playlist")
        return result
    except Exception as exc:
        raise RuntimeError(f"Download failed: {exc}") from exc
