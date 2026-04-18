import json
import os
import sqlite3
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock, Semaphore, Thread
from uuid import uuid4

from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from auth import (
    auth_bp,
    FREE_HISTORY_LIMIT,
    FREE_QUEUE_LIMIT,
    PRO_QUEUE_LIMIT,
    check_quota,
    get_current_user,
    increment_quota,
    init_auth_db,
    login_required,
)
from ytdownload import DEFAULT_OUTPUT_DIR, DEFAULT_QUALITY, FORMAT_PRESETS, download_video, get_video_preview

app = Flask(__name__)
app.register_blueprint(auth_bp)
CORS(app, supports_credentials=True, origins=[os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")])

MAX_CONCURRENT_DOWNLOADS = int(os.getenv("MAX_CONCURRENT_DOWNLOADS", "3"))
AUTO_UPDATE_YTDLP = os.getenv("YTDLP_AUTO_UPDATE", "false").strip().lower() in {"1", "true", "yes", "on"}
DB_PATH = Path(__file__).resolve().parent / "jobs.db"

db_lock = Lock()
download_slots = Semaphore(MAX_CONCURRENT_DOWNLOADS)


class YtDlpState:
    version = "unknown"
    auto_update_enabled = AUTO_UPDATE_YTDLP
    auto_update_attempted = False
    auto_update_result = "disabled"


FRIENDLY_ERROR_PATTERNS = [
    ("Sign in to confirm you're not a bot", "YouTube asked for bot verification. Please try again later, use a different network, or update yt-dlp."),
    ("Video unavailable", "This video is unavailable. It may be private, deleted, or region-restricted."),
    ("Private video", "This video is private and cannot be downloaded."),
    ("This live event will begin", "This livestream has not started yet. Try again once it is live or available as a replay."),
    ("Unsupported URL", "This URL is not supported. Please paste a valid YouTube video, short, or playlist link."),
    ("HTTP Error 429", "Too many requests were sent to YouTube. Wait a bit and retry."),
    ("requested format not available", "The selected quality is not available for this video. Try a different quality option."),
    ("Unable to extract", "YouTube changed something recently. Try updating yt-dlp or retrying shortly."),
]


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _sanitize_error(error) -> str:
    raw = str(error)
    cleaned = raw.replace("Download failed:", "").replace("Preview failed:", "").strip()
    for pattern, message in FRIENDLY_ERROR_PATTERNS:
        if pattern.lower() in cleaned.lower():
            return message
    return cleaned or "Unexpected error while processing this request."


def _connect_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _json_dump(value):
    return json.dumps(value, ensure_ascii=False)


def _json_load(value, fallback):
    if value in (None, ""):
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def _init_db():
    with db_lock:
        with _connect_db() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS jobs (
                    job_id TEXT PRIMARY KEY,
                    user_id TEXT,
                    url TEXT NOT NULL,
                    quality TEXT NOT NULL,
                    output_path TEXT NOT NULL,
                    playlist_mode INTEGER NOT NULL,
                    playlist_items TEXT NOT NULL,
                    download_subtitles INTEGER NOT NULL,
                    subtitle_languages TEXT NOT NULL,
                    save_thumbnail_only INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    logs TEXT NOT NULL,
                    result TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs(updated_at DESC)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON jobs(user_id)")


def _row_to_job(row: sqlite3.Row) -> dict:
    return {
        "job_id":             row["job_id"],
        "user_id":            row["user_id"],
        "url":                row["url"],
        "quality":            row["quality"],
        "output_path":        row["output_path"],
        "playlist_mode":      bool(row["playlist_mode"]),
        "playlist_items":     _json_load(row["playlist_items"], []),
        "download_subtitles": bool(row["download_subtitles"]),
        "subtitle_languages": _json_load(row["subtitle_languages"], ["en"]),
        "save_thumbnail_only":bool(row["save_thumbnail_only"]),
        "status":             row["status"],
        "logs":               _json_load(row["logs"], []),
        "result":             _json_load(row["result"], None),
        "error":              row["error"],
        "created_at":         row["created_at"],
        "updated_at":         row["updated_at"],
    }


def _insert_job(job: dict):
    with db_lock:
        with _connect_db() as conn:
            conn.execute(
                """INSERT INTO jobs (
                    job_id, user_id, url, quality, output_path, playlist_mode,
                    playlist_items, download_subtitles, subtitle_languages,
                    save_thumbnail_only, status, logs, result, error, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    job["job_id"], job.get("user_id"), job["url"], job["quality"],
                    job["output_path"], int(job["playlist_mode"]),
                    _json_dump(job["playlist_items"]), int(job["download_subtitles"]),
                    _json_dump(job["subtitle_languages"]), int(job["save_thumbnail_only"]),
                    job["status"], _json_dump(job["logs"]), _json_dump(job["result"]),
                    job["error"], job["created_at"], job["updated_at"],
                ),
            )


def _get_job(job_id: str, user_id: str = None):
    with db_lock:
        with _connect_db() as conn:
            if user_id:
                row = conn.execute(
                    "SELECT * FROM jobs WHERE job_id=? AND user_id=?", (job_id, user_id)
                ).fetchone()
            else:
                row = conn.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
    return _row_to_job(row) if row else None


def _list_jobs(user_id: str, limit: int = 100):
    with db_lock:
        with _connect_db() as conn:
            rows = conn.execute(
                "SELECT * FROM jobs WHERE user_id=? ORDER BY datetime(created_at) DESC LIMIT ?",
                (user_id, limit),
            ).fetchall()
    return [_row_to_job(row) for row in rows]


def _count_active_jobs(user_id: str) -> int:
    with db_lock:
        with _connect_db() as conn:
            row = conn.execute(
                "SELECT COUNT(*) as c FROM jobs WHERE user_id=? AND status IN ('queued','running')",
                (user_id,),
            ).fetchone()
    return row["c"] if row else 0


def _append_log(job_id: str, message: str):
    timestamped = f"[{datetime.now().strftime('%H:%M:%S')}] {message}"
    with db_lock:
        with _connect_db() as conn:
            row = conn.execute("SELECT logs FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            if not row:
                return
            logs = _json_load(row["logs"], [])
            logs.append(timestamped)
            conn.execute(
                "UPDATE jobs SET logs=?, updated_at=? WHERE job_id=?",
                (_json_dump(logs), _now_iso(), job_id),
            )


def _set_status(job_id: str, status: str, result=None, error=None):
    with db_lock:
        with _connect_db() as conn:
            conn.execute(
                "UPDATE jobs SET status=?, result=?, error=?, updated_at=? WHERE job_id=?",
                (status, _json_dump(result), error, _now_iso(), job_id),
            )


def _run_command(cmd: list) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=30)


def _determine_ytdlp_version() -> str:
    probes = [
        ["yt-dlp", "--version"],
        ["python", "-m", "yt_dlp", "--version"],
        ["python3", "-m", "yt_dlp", "--version"],
    ]
    for cmd in probes:
        try:
            proc = _run_command(cmd)
            version = (proc.stdout or proc.stderr).strip()
            if proc.returncode == 0 and version:
                return version.splitlines()[0].strip()
        except Exception:
            continue
    return "unknown"


def _auto_update_ytdlp_if_enabled():
    YtDlpState.auto_update_attempted = AUTO_UPDATE_YTDLP
    if not AUTO_UPDATE_YTDLP:
        return
    for cmd in [["yt-dlp", "-U"], ["python", "-m", "yt_dlp", "-U"], ["python3", "-m", "yt_dlp", "-U"]]:
        try:
            proc = _run_command(cmd)
            if proc.returncode == 0:
                YtDlpState.auto_update_result = "success"
                return
        except Exception:
            continue
    YtDlpState.auto_update_result = "failed"


def _run_download(job_id, url, quality, output_path, playlist_mode,
                  playlist_items, download_subtitles, subtitle_languages,
                  save_thumbnail_only, user_id):
    with download_slots:
        _set_status(job_id, "running")
        try:
            result = download_video(
                url, output_path=output_path,
                progress_callback=lambda msg: _append_log(job_id, msg),
                quality=quality, playlist_mode=playlist_mode,
                playlist_items=playlist_items, download_subtitles=download_subtitles,
                subtitle_languages=subtitle_languages, save_thumbnail_only=save_thumbnail_only,
            )
            _set_status(job_id, "success", result=result)
            # Only increment quota on success so failed attempts don't count
            if user_id:
                increment_quota(user_id)
        except Exception as exc:
            friendly = _sanitize_error(exc)
            _set_status(job_id, "error", error=friendly)
            _append_log(job_id, friendly)


def _initialize_runtime_state():
    _init_db()
    init_auth_db()
    _auto_update_ytdlp_if_enabled()
    YtDlpState.version = _determine_ytdlp_version()


_initialize_runtime_state()


# ── API routes ───────────────────────────────────────────────────────────────

@app.get("/api/health")
def health_check():
    return jsonify({
        "status": "ok",
        "max_concurrent_downloads": MAX_CONCURRENT_DOWNLOADS,
        "yt_dlp": {
            "version":              YtDlpState.version,
            "auto_update_enabled":  YtDlpState.auto_update_enabled,
            "auto_update_attempted":YtDlpState.auto_update_attempted,
            "auto_update_result":   YtDlpState.auto_update_result,
        },
    })


@app.post("/api/preview")
@login_required
def preview_video():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    playlist_mode = bool(data.get("playlist_mode"))
    if not url:
        return jsonify({"error": "The 'url' field is required."}), 400
    try:
        preview = get_video_preview(url, playlist_mode=playlist_mode)
        return jsonify(preview)
    except Exception as exc:
        return jsonify({"error": _sanitize_error(exc)}), 400


@app.post("/api/download")
@login_required
def create_download_job():
    user = get_current_user()
    data = request.get_json(silent=True) or {}
    url              = (data.get("url") or "").strip()
    quality          = (data.get("quality") or DEFAULT_QUALITY).strip()
    output_path      = (data.get("output_path") or "").strip()
    playlist_mode    = bool(data.get("playlist_mode"))
    playlist_items   = data.get("playlist_items") or []
    download_subtitles = bool(data.get("download_subtitles"))
    subtitle_languages = data.get("subtitle_languages") or ["en"]
    save_thumbnail_only = bool(data.get("save_thumbnail_only"))

    if not url:
        return jsonify({"error": "The 'url' field is required."}), 400
    if quality not in FORMAT_PRESETS:
        return jsonify({"error": "Invalid quality preset."}), 400

    # Quota check
    if not check_quota(user["user_id"], user["tier"]):
        from auth import FREE_DAILY_DOWNLOAD_LIMIT
        return jsonify({
            "error": f"Daily download limit reached ({FREE_DAILY_DOWNLOAD_LIMIT} downloads/day on the free plan). Upgrade to Pro for unlimited downloads."
        }), 429

    # Queue depth check (per-tier)
    queue_limit = FREE_QUEUE_LIMIT if user["tier"] == "free" else PRO_QUEUE_LIMIT
    active = _count_active_jobs(user["user_id"])
    if active >= queue_limit:
        return jsonify({
            "error": f"You already have {active} active job(s). Your plan allows {queue_limit} concurrent jobs."
        }), 429

    resolved_output = output_path or str(DEFAULT_OUTPUT_DIR)
    job_id = str(uuid4())
    new_job = {
        "job_id": job_id, "user_id": user["user_id"], "url": url, "quality": quality,
        "output_path": resolved_output, "playlist_mode": playlist_mode,
        "playlist_items": playlist_items, "download_subtitles": download_subtitles,
        "subtitle_languages": subtitle_languages, "save_thumbnail_only": save_thumbnail_only,
        "status": "queued",
        "logs": [f"[{datetime.now().strftime('%H:%M:%S')}] Added to queue. Waiting for an open slot..."],
        "result": None, "error": None, "created_at": _now_iso(), "updated_at": _now_iso(),
    }
    _insert_job(new_job)

    Thread(target=_run_download, args=(
        job_id, url, quality, resolved_output, playlist_mode, playlist_items,
        download_subtitles, subtitle_languages, save_thumbnail_only, user["user_id"],
    ), daemon=True).start()

    return jsonify({"job_id": job_id, "status": "queued"}), 202


@app.get("/api/jobs/<job_id>")
@login_required
def get_job(job_id: str):
    user = get_current_user()
    job = _get_job(job_id, user_id=user["user_id"])
    if not job:
        return jsonify({"error": "Job not found."}), 404
    return jsonify(job)


@app.get("/api/jobs")
@login_required
def list_jobs():
    user = get_current_user()
    limit_raw = request.args.get("limit", "50")
    try:
        limit = max(1, min(int(limit_raw), 250))
    except ValueError:
        limit = 50
    # Free users get capped history
    if user["tier"] == "free":
        limit = min(limit, FREE_HISTORY_LIMIT)
    return jsonify({"jobs": _list_jobs(user["user_id"], limit)})


@app.get("/api/quota")
@login_required
def get_quota_route():
    from auth import get_quota
    user = get_current_user()
    return jsonify(get_quota(user["user_id"], user["tier"]))


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
