from datetime import datetime, timezone
from threading import Lock, Thread
from uuid import uuid4

from flask import Flask, jsonify, request
from flask_cors import CORS

from ytdownload import DEFAULT_QUALITY, FORMAT_PRESETS, download_video, get_video_preview

app = Flask(__name__)
CORS(app)

jobs = {}
jobs_lock = Lock()


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _append_log(job_id: str, message: str):
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            return
        job["logs"].append(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")
        job["updated_at"] = _now_iso()


def _run_download(job_id: str, url: str, quality: str):
    with jobs_lock:
        jobs[job_id]["status"] = "running"
        jobs[job_id]["updated_at"] = _now_iso()

    try:
        result = download_video(
            url,
            progress_callback=lambda msg: _append_log(job_id, msg),
            quality=quality,
        )
        with jobs_lock:
            jobs[job_id]["status"] = "success"
            jobs[job_id]["result"] = result
            jobs[job_id]["updated_at"] = _now_iso()
    except Exception as exc:
        with jobs_lock:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = str(exc)
            jobs[job_id]["updated_at"] = _now_iso()
        _append_log(job_id, str(exc))


@app.get("/api/health")
def health_check():
    return jsonify({"status": "ok"})


@app.post("/api/preview")
def preview_video():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()

    if not url:
        return jsonify({"error": "The 'url' field is required."}), 400

    try:
        preview = get_video_preview(url)
        return jsonify(preview)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.post("/api/download")
def create_download_job():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    quality = (data.get("quality") or DEFAULT_QUALITY).strip()

    if not url:
        return jsonify({"error": "The 'url' field is required."}), 400

    if quality not in FORMAT_PRESETS:
        return jsonify({"error": "Invalid quality preset."}), 400

    job_id = str(uuid4())
    new_job = {
        "job_id": job_id,
        "url": url,
        "quality": quality,
        "status": "queued",
        "logs": [],
        "result": None,
        "error": None,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }

    with jobs_lock:
        jobs[job_id] = new_job

    Thread(target=_run_download, args=(job_id, url, quality), daemon=True).start()

    return jsonify({"job_id": job_id, "status": "queued"}), 202


@app.get("/api/jobs/<job_id>")
def get_job(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)

    if not job:
        return jsonify({"error": "Job not found."}), 404

    return jsonify(job)


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)