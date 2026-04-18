"""
auth.py — Google OAuth + JWT session management
------------------------------------------------
Flow:
  1. Frontend calls GET /auth/google  → redirected to Google consent screen
  2. Google redirects to GET /auth/google/callback
  3. We exchange the code, upsert the user in SQLite, mint a signed JWT,
     set it as an HTTP-only cookie, then redirect back to the frontend.
  4. Every protected endpoint calls `get_current_user()` which validates
     the cookie and returns the user row (or None).

Tier limits (free vs pro):
  FREE_DAILY_DOWNLOAD_LIMIT  — max downloads per UTC day for free users
  FREE_HISTORY_LIMIT         — max history rows returned for free users
  FREE_QUEUE_LIMIT           — max concurrent queued/running jobs for free users
"""

import os
import sqlite3
import time
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from uuid import uuid4

import jwt
import requests
from flask import Blueprint, jsonify, redirect, request, make_response, current_app

# ── Constants ────────────────────────────────────────────────────────────────

GOOGLE_CLIENT_ID     = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
SECRET_KEY           = os.getenv("SECRET_KEY", "change-me-in-production")

GOOGLE_AUTH_URL  = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

# Where Google should redirect after consent.
# Must exactly match what you registered in Google Cloud Console.
REDIRECT_URI = os.getenv("OAUTH_REDIRECT_URI", "http://localhost:5000/auth/google/callback")

# Where to send the browser after login completes (your Vite dev server or prod origin).
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")

JWT_ALGORITHM  = "HS256"
JWT_EXPIRY_DAYS = 30          # token lifetime
COOKIE_NAME     = "yt_session"

# Tier limits — edit freely
FREE_DAILY_DOWNLOAD_LIMIT = 5
FREE_HISTORY_LIMIT        = 20
FREE_QUEUE_LIMIT          = 2
PRO_QUEUE_LIMIT           = 5

DB_PATH = Path(__file__).resolve().parent / "jobs.db"

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")


# ── DB helpers ───────────────────────────────────────────────────────────────

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_auth_db():
    """Create users and quota tables if they don't exist."""
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                user_id    TEXT PRIMARY KEY,
                google_id  TEXT UNIQUE NOT NULL,
                email      TEXT NOT NULL,
                name       TEXT NOT NULL,
                avatar_url TEXT,
                tier       TEXT NOT NULL DEFAULT 'free',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)")

        conn.execute("""
            CREATE TABLE IF NOT EXISTS download_quota (
                user_id TEXT NOT NULL,
                date    TEXT NOT NULL,
                count   INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, date)
            )
        """)

        # Add user_id column to jobs if it doesn't exist yet (migration-safe)
        existing = {row[1] for row in conn.execute("PRAGMA table_info(jobs)")}
        if "user_id" not in existing:
            conn.execute("ALTER TABLE jobs ADD COLUMN user_id TEXT")


def _upsert_user(google_id: str, email: str, name: str, avatar_url: str) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE google_id = ?", (google_id,)
        ).fetchone()

        if row:
            conn.execute(
                """UPDATE users SET email=?, name=?, avatar_url=?, updated_at=?
                   WHERE google_id=?""",
                (email, name, avatar_url, now, google_id),
            )
            return dict(row)
        else:
            user_id = str(uuid4())
            conn.execute(
                """INSERT INTO users
                   (user_id, google_id, email, name, avatar_url, tier, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, 'free', ?, ?)""",
                (user_id, google_id, email, name, avatar_url, now, now),
            )
            return {
                "user_id": user_id, "google_id": google_id,
                "email": email, "name": name, "avatar_url": avatar_url,
                "tier": "free", "created_at": now, "updated_at": now,
            }


def get_user_by_id(user_id: str):
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM users WHERE user_id = ?", (user_id,)
        ).fetchone()
    return dict(row) if row else None


# ── Quota helpers ────────────────────────────────────────────────────────────

def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def get_quota(user_id: str, tier: str) -> dict:
    """Return today's usage and the applicable limit."""
    limit = FREE_DAILY_DOWNLOAD_LIMIT if tier == "free" else None  # None = unlimited
    today = _today_utc()
    with _connect() as conn:
        row = conn.execute(
            "SELECT count FROM download_quota WHERE user_id=? AND date=?",
            (user_id, today),
        ).fetchone()
    used = row["count"] if row else 0
    return {"used": used, "limit": limit, "date": today}


def increment_quota(user_id: str) -> int:
    """Atomically increment today's download count. Returns new count."""
    today = _today_utc()
    with _connect() as conn:
        conn.execute(
            """INSERT INTO download_quota (user_id, date, count) VALUES (?, ?, 1)
               ON CONFLICT(user_id, date) DO UPDATE SET count = count + 1""",
            (user_id, today),
        )
        row = conn.execute(
            "SELECT count FROM download_quota WHERE user_id=? AND date=?",
            (user_id, today),
        ).fetchone()
    return row["count"]


def check_quota(user_id: str, tier: str) -> bool:
    """Return True if the user is allowed to start another download."""
    if tier == "pro":
        return True
    q = get_quota(user_id, tier)
    return q["used"] < FREE_DAILY_DOWNLOAD_LIMIT


# ── JWT helpers ──────────────────────────────────────────────────────────────

def _mint_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "iat": int(time.time()),
        "exp": int(time.time()) + JWT_EXPIRY_DAYS * 86400,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALGORITHM)


def _decode_token(token: str):
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None


def get_current_user():
    """Extract and validate the session cookie. Returns user dict or None."""
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    payload = _decode_token(token)
    if not payload:
        return None
    return get_user_by_id(payload["sub"])


def login_required(f):
    """Decorator — returns 401 JSON if the request has no valid session."""
    @wraps(f)
    def decorated(*args, **kwargs):
        user = get_current_user()
        if not user:
            return jsonify({"error": "Authentication required."}), 401
        return f(*args, **kwargs)
    return decorated


# ── OAuth routes ─────────────────────────────────────────────────────────────

@auth_bp.get("/google")
def google_login():
    """Redirect the browser to Google's consent screen."""
    if not GOOGLE_CLIENT_ID:
        return jsonify({"error": "GOOGLE_CLIENT_ID is not configured."}), 500

    import urllib.parse
    params = {
        "client_id":     GOOGLE_CLIENT_ID,
        "redirect_uri":  REDIRECT_URI,
        "response_type": "code",
        "scope":         "openid email profile",
        "access_type":   "online",
        "prompt":        "select_account",
    }
    url = GOOGLE_AUTH_URL + "?" + urllib.parse.urlencode(params)
    return redirect(url)


@auth_bp.get("/google/callback")
def google_callback():
    """Handle the OAuth callback from Google."""
    error = request.args.get("error")
    if error:
        return redirect(f"{FRONTEND_ORIGIN}?auth_error={error}")

    code = request.args.get("code")
    if not code:
        return redirect(f"{FRONTEND_ORIGIN}?auth_error=missing_code")

    # Exchange auth code for tokens
    try:
        token_resp = requests.post(
            GOOGLE_TOKEN_URL,
            data={
                "code":          code,
                "client_id":     GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri":  REDIRECT_URI,
                "grant_type":    "authorization_code",
            },
            timeout=10,
        )
        token_resp.raise_for_status()
        tokens = token_resp.json()
    except Exception:
        return redirect(f"{FRONTEND_ORIGIN}?auth_error=token_exchange_failed")

    # Fetch user info
    try:
        userinfo_resp = requests.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
            timeout=10,
        )
        userinfo_resp.raise_for_status()
        userinfo = userinfo_resp.json()
    except Exception:
        return redirect(f"{FRONTEND_ORIGIN}?auth_error=userinfo_failed")

    # Upsert user in DB
    user = _upsert_user(
        google_id  = userinfo["sub"],
        email      = userinfo.get("email", ""),
        name       = userinfo.get("name", ""),
        avatar_url = userinfo.get("picture", ""),
    )

    # Mint JWT and set HTTP-only cookie
    token = _mint_token(user["user_id"])
    response = make_response(redirect(FRONTEND_ORIGIN))
    response.set_cookie(
        COOKIE_NAME,
        token,
        httponly=True,
        secure=False,          # set True in production (HTTPS)
        samesite="Lax",
        max_age=JWT_EXPIRY_DAYS * 86400,
        path="/",
    )
    return response


@auth_bp.get("/me")
def me():
    """Return the current user's profile, or 401."""
    user = get_current_user()
    if not user:
        return jsonify({"error": "Not authenticated."}), 401
    quota = get_quota(user["user_id"], user["tier"])
    return jsonify({
        "user_id":    user["user_id"],
        "email":      user["email"],
        "name":       user["name"],
        "avatar_url": user["avatar_url"],
        "tier":       user["tier"],
        "quota":      quota,
        "limits": {
            "daily_downloads": FREE_DAILY_DOWNLOAD_LIMIT if user["tier"] == "free" else None,
            "history":         FREE_HISTORY_LIMIT        if user["tier"] == "free" else None,
            "queue":           FREE_QUEUE_LIMIT          if user["tier"] == "free" else PRO_QUEUE_LIMIT,
        },
    })


@auth_bp.post("/logout")
def logout():
    """Clear the session cookie."""
    response = make_response(jsonify({"ok": True}))
    response.delete_cookie(COOKIE_NAME, path="/")
    return response
