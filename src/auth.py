"""
auth.py — Google OAuth + JWT session management
------------------------------------------------
Fixes applied:
  #2  stripe added to requirements / guarded import
  #3  _upsert_user re-fetches after UPDATE so returned data is fresh
  #4  /auth/me syncs Stripe at most once every 5 minutes (not every poll)
  #6  check_quota accepts effective_tier computed by caller
  #7  login_required checks X-Requested-With to mitigate CSRF
  #8  server refuses to start with default SECRET_KEY in non-debug mode
  #10 uses shared db.connect_db / db.db_lock
  #12 auth DB writes protected by shared db_lock
  #14 stripe imported lazily inside functions
"""

import os
import time
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path
from uuid import uuid4

import jwt
import requests
from flask import Blueprint, jsonify, redirect, request, make_response

from db import connect_db, db_lock

# ── Constants ────────────────────────────────────────────────────────────────

GOOGLE_CLIENT_ID     = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
SECRET_KEY           = os.getenv("SECRET_KEY", "change-me-in-production")

GOOGLE_AUTH_URL     = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL    = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

REDIRECT_URI    = os.getenv("OAUTH_REDIRECT_URI", "http://localhost:5000/auth/google/callback")
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")

JWT_ALGORITHM   = "HS256"
JWT_EXPIRY_DAYS = 30
COOKIE_NAME     = "yt_session"

TRIAL_DAYS = 7
FREE_DAILY_DOWNLOAD_LIMIT = 5
FREE_HISTORY_LIMIT        = 20
FREE_QUEUE_LIMIT          = 2
PRO_QUEUE_LIMIT           = 5
PRO_STATUSES = {"trialing", "active"}

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")

# ── FIX #8: refuse to start with the placeholder key outside debug mode ──────
_DEBUG = os.getenv("FLASK_DEBUG", "0").strip() in {"1", "true", "yes"}
if SECRET_KEY == "change-me-in-production" and not _DEBUG:
    raise RuntimeError(
        "SECRET_KEY is still the default placeholder value. "
        "Set a real SECRET_KEY environment variable before running in production."
    )


# ── DB helpers ───────────────────────────────────────────────────────────────

def init_auth_db():
    """Create users, quota, and subscriptions tables if they don't exist."""
    with db_lock:
        with connect_db() as conn:
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

            conn.execute("""
                CREATE TABLE IF NOT EXISTS subscriptions (
                    user_id                TEXT PRIMARY KEY,
                    stripe_customer_id     TEXT UNIQUE,
                    stripe_subscription_id TEXT UNIQUE,
                    stripe_price_id        TEXT,
                    status                 TEXT,
                    trial_end              TEXT,
                    current_period_end     TEXT,
                    cancel_at_period_end   INTEGER NOT NULL DEFAULT 0,
                    trial_used_at          TEXT,
                    last_synced_at         TEXT,
                    updated_at             TEXT NOT NULL
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_subs_customer    ON subscriptions(stripe_customer_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_subs_subscription ON subscriptions(stripe_subscription_id)")

            # Migration-safe: add last_synced_at if upgrading from older schema
            existing = {row[1] for row in conn.execute("PRAGMA table_info(subscriptions)")}
            if "last_synced_at" not in existing:
                conn.execute("ALTER TABLE subscriptions ADD COLUMN last_synced_at TEXT")

            # Migration-safe: add user_id to jobs if needed
            existing_jobs = {row[1] for row in conn.execute("PRAGMA table_info(jobs)")}
            if "user_id" not in existing_jobs:
                conn.execute("ALTER TABLE jobs ADD COLUMN user_id TEXT")


def _upsert_user(google_id: str, email: str, name: str, avatar_url: str) -> dict:
    """Insert or update a user row and return the *current* data (never stale)."""
    now = datetime.now(timezone.utc).isoformat()
    with db_lock:
        with connect_db() as conn:
            existing = conn.execute(
                "SELECT user_id FROM users WHERE google_id = ?", (google_id,)
            ).fetchone()

            if existing:
                # FIX #3: UPDATE first, then re-fetch — don't return the pre-update row
                conn.execute(
                    "UPDATE users SET email=?, name=?, avatar_url=?, updated_at=? WHERE google_id=?",
                    (email, name, avatar_url, now, google_id),
                )
            else:
                user_id = str(uuid4())
                conn.execute(
                    """INSERT INTO users
                       (user_id, google_id, email, name, avatar_url, tier, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, 'pro', ?, ?)""",
                    (user_id, google_id, email, name, avatar_url, now, now),
                )

            row = conn.execute("SELECT * FROM users WHERE google_id = ?", (google_id,)).fetchone()
    return dict(row)


def get_user_by_id(user_id: str):
    with db_lock:
        with connect_db() as conn:
            row = conn.execute("SELECT * FROM users WHERE user_id = ?", (user_id,)).fetchone()
    return dict(row) if row else None



def _from_unix_ts(ts):
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _parse_iso(value: str):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def get_subscription(user_id: str) -> dict:
    with db_lock:
        with connect_db() as conn:
            row = conn.execute(
                "SELECT * FROM subscriptions WHERE user_id = ?", (user_id,)
            ).fetchone()
    return dict(row) if row else {}


def _upsert_subscription(user_id: str, patch: dict):
    """Thread-safe subscription upsert protected by shared db_lock (#12)."""
    now = datetime.now(timezone.utc).isoformat()
    with db_lock:
        with connect_db() as conn:
            current_row = conn.execute(
                "SELECT * FROM subscriptions WHERE user_id = ?", (user_id,)
            ).fetchone()
            current = dict(current_row) if current_row else {}

            merged = {
                "stripe_customer_id":     current.get("stripe_customer_id"),
                "stripe_subscription_id": current.get("stripe_subscription_id"),
                "stripe_price_id":        current.get("stripe_price_id"),
                "status":                 current.get("status"),
                "trial_end":              current.get("trial_end"),
                "current_period_end":     current.get("current_period_end"),
                "cancel_at_period_end":   int(current.get("cancel_at_period_end") or 0),
                "trial_used_at":          current.get("trial_used_at"),
                "last_synced_at":         patch.get("last_synced_at", current.get("last_synced_at")),
            }
            for k, v in patch.items():
                if k in merged:
                    merged[k] = v

            conn.execute("""
                INSERT INTO subscriptions (
                    user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
                    status, trial_end, current_period_end, cancel_at_period_end,
                    trial_used_at, last_synced_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    stripe_customer_id=excluded.stripe_customer_id,
                    stripe_subscription_id=excluded.stripe_subscription_id,
                    stripe_price_id=excluded.stripe_price_id,
                    status=excluded.status,
                    trial_end=excluded.trial_end,
                    current_period_end=excluded.current_period_end,
                    cancel_at_period_end=excluded.cancel_at_period_end,
                    trial_used_at=excluded.trial_used_at,
                    last_synced_at=excluded.last_synced_at,
                    updated_at=excluded.updated_at
            """, (
                user_id,
                merged["stripe_customer_id"],
                merged["stripe_subscription_id"],
                merged["stripe_price_id"],
                merged["status"],
                merged["trial_end"],
                merged["current_period_end"],
                int(merged["cancel_at_period_end"]),
                merged["trial_used_at"],
                merged["last_synced_at"],
                now,
            ))

def get_effective_tier(user_id: str, fallback_tier: str = "free") -> str:
    # All users now have pro tier - no subscription system
    return "pro"


def get_plan_snapshot(user_id: str, fallback_tier: str = "free") -> dict:
    # All users have pro tier - no subscription needed
    return {
        "tier": "pro",
        "status": "active",
        "provider": "none",
        "trial_end": None,
        "current_period_end": None,
        "cancel_at_period_end": False,
    }

# ── Quota helpers ─────────────────────────────────────────────────────────────

def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def get_quota(user_id: str, effective_tier: str) -> dict:
    """Return today's usage. All users have unlimited downloads."""
    today = _today_utc()
    with db_lock:
        with connect_db() as conn:
            row = conn.execute(
                "SELECT count FROM download_quota WHERE user_id=? AND date=?",
                (user_id, today),
            ).fetchone()
    used = row["count"] if row else 0
    return {"used": used, "limit": None, "date": today}


def increment_quota(user_id: str) -> int:
    """Atomically increment today's download count (ON CONFLICT is inherently safe, #12)."""
    today = _today_utc()
    with db_lock:
        with connect_db() as conn:
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


def check_quota(user_id: str, effective_tier: str) -> bool:
    """All users have unlimited downloads - always return True."""
    return True


# ── JWT helpers ───────────────────────────────────────────────────────────────

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
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    payload = _decode_token(token)
    if not payload:
        return None
    return get_user_by_id(payload["sub"])


def login_required(f):
    """
    Decorator: returns 401 if no valid session.
    FIX #7: also requires X-Requested-With header on state-changing methods
    to mitigate cross-origin form POST CSRF (Lax cookies don't cover all vectors).
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        user = get_current_user()
        if not user:
            return jsonify({"error": "Authentication required."}), 401
        # CSRF guard for mutating methods
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            if request.headers.get("X-Requested-With") != "XMLHttpRequest":
                return jsonify({"error": "Missing X-Requested-With header."}), 403
        return f(*args, **kwargs)
    return decorated


# ── OAuth routes ──────────────────────────────────────────────────────────────

@auth_bp.get("/google")
def google_login():
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
    return redirect(GOOGLE_AUTH_URL + "?" + urllib.parse.urlencode(params))


@auth_bp.get("/google/callback")
def google_callback():
    error = request.args.get("error")
    if error:
        return redirect(f"{FRONTEND_ORIGIN}?auth_error={error}")

    code = request.args.get("code")
    if not code:
        return redirect(f"{FRONTEND_ORIGIN}?auth_error=missing_code")

    try:
        token_resp = requests.post(
            GOOGLE_TOKEN_URL,
            data={
                "code": code, "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": REDIRECT_URI, "grant_type": "authorization_code",
            },
            timeout=10,
        )
        token_resp.raise_for_status()
        tokens = token_resp.json()
    except Exception:
        return redirect(f"{FRONTEND_ORIGIN}?auth_error=token_exchange_failed")

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

    user = _upsert_user(
        google_id=userinfo["sub"],
        email=userinfo.get("email", ""),
        name=userinfo.get("name", ""),
        avatar_url=userinfo.get("picture", ""),
    )

    token = _mint_token(user["user_id"])
    response = make_response(redirect(FRONTEND_ORIGIN))
    response.set_cookie(
        COOKIE_NAME, token,
        httponly=True, secure=False, samesite="Lax",
        max_age=JWT_EXPIRY_DAYS * 86400, path="/",
    )
    return response


@auth_bp.get("/me")
def me():
    user = get_current_user()
    if not user:
        return jsonify({"error": "Not authenticated."}), 401

    plan = get_plan_snapshot(user["user_id"], fallback_tier=user["tier"])
    quota = get_quota(user["user_id"], plan["tier"])

    return jsonify({
        "user_id": user["user_id"],
        "email": user["email"],
        "name": user["name"],
        "avatar_url": user["avatar_url"],
    })

@auth_bp.post("/dev/subscribe")
@login_required
def dev_subscribe():
    # Dev endpoint disabled - all users already have pro privileges
    return jsonify({"message": "Already on Pro plan"})

@auth_bp.post("/dev/cancel")
@login_required
def dev_cancel():
    # Dev endpoint disabled - all users must remain on pro plan
    return jsonify({"message": "Cannot cancel - all users have Pro privileges"})

@auth_bp.post("/dev/downgrade")
@login_required
def dev_downgrade():
    # Dev endpoint disabled - all users must remain on pro plan
    return jsonify({"message": "Cannot downgrade - all users have Pro privileges"})

@auth_bp.post("/logout")
def logout():
    # Logout is browser-initiated via direct link/form, exempt from CSRF guard
    response = make_response(jsonify({"ok": True}))
    response.delete_cookie(COOKIE_NAME, path="/")
    return response
