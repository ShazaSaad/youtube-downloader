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
import stripe
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
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_PRO_PRICE_ID = os.getenv("STRIPE_PRO_PRICE_ID", "")
STRIPE_SUCCESS_URL = os.getenv("STRIPE_SUCCESS_URL", f"{FRONTEND_ORIGIN}/?checkout=success")
STRIPE_CANCEL_URL = os.getenv("STRIPE_CANCEL_URL", f"{FRONTEND_ORIGIN}/?checkout=cancelled")
TRIAL_DAYS = int(os.getenv("TRIAL_DAYS", "7"))
PRO_BILLING_STATUSES = {"trialing", "active"}

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
        conn.execute("""
            CREATE TABLE IF NOT EXISTS subscriptions (
                user_id               TEXT PRIMARY KEY,
                stripe_customer_id    TEXT UNIQUE,
                stripe_subscription_id TEXT UNIQUE,
                stripe_price_id       TEXT,
                status                TEXT,
                trial_end             TEXT,
                current_period_end    TEXT,
                cancel_at_period_end  INTEGER NOT NULL DEFAULT 0,
                trial_used_at         TEXT,
                updated_at            TEXT NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(stripe_customer_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_subscriptions_subscription ON subscriptions(stripe_subscription_id)")

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


def _ensure_stripe_configured():
    if not STRIPE_SECRET_KEY:
        raise RuntimeError("Stripe is not configured (missing STRIPE_SECRET_KEY).")
    stripe.api_key = STRIPE_SECRET_KEY


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
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM subscriptions WHERE user_id = ?",
            (user_id,),
        ).fetchone()
    return dict(row) if row else {}


def _upsert_subscription(user_id: str, patch: dict):
    now = datetime.now(timezone.utc).isoformat()
    current = get_subscription(user_id)
    merged = {
        "stripe_customer_id": current.get("stripe_customer_id"),
        "stripe_subscription_id": current.get("stripe_subscription_id"),
        "stripe_price_id": current.get("stripe_price_id"),
        "status": current.get("status"),
        "trial_end": current.get("trial_end"),
        "current_period_end": current.get("current_period_end"),
        "cancel_at_period_end": int(current.get("cancel_at_period_end") or 0),
        "trial_used_at": current.get("trial_used_at"),
    }
    merged.update({k: v for k, v in patch.items() if k in merged})

    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO subscriptions (
                user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
                status, trial_end, current_period_end, cancel_at_period_end, trial_used_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                stripe_customer_id=excluded.stripe_customer_id,
                stripe_subscription_id=excluded.stripe_subscription_id,
                stripe_price_id=excluded.stripe_price_id,
                status=excluded.status,
                trial_end=excluded.trial_end,
                current_period_end=excluded.current_period_end,
                cancel_at_period_end=excluded.cancel_at_period_end,
                trial_used_at=excluded.trial_used_at,
                updated_at=excluded.updated_at
            """,
            (
                user_id,
                merged["stripe_customer_id"],
                merged["stripe_subscription_id"],
                merged["stripe_price_id"],
                merged["status"],
                merged["trial_end"],
                merged["current_period_end"],
                int(merged["cancel_at_period_end"]),
                merged["trial_used_at"],
                now,
            ),
        )


def sync_subscription_from_stripe(user_id: str) -> dict:
    sub = get_subscription(user_id)
    customer_id = sub.get("stripe_customer_id")
    if not customer_id or not STRIPE_SECRET_KEY:
        return sub

    _ensure_stripe_configured()
    subscriptions = stripe.Subscription.list(customer=customer_id, limit=3).get("data", [])
    if not subscriptions:
        _upsert_subscription(user_id, {
            "status": "canceled",
            "stripe_subscription_id": None,
            "stripe_price_id": sub.get("stripe_price_id"),
            "trial_end": None,
            "current_period_end": None,
            "cancel_at_period_end": 0,
        })
        return get_subscription(user_id)

    latest = subscriptions[0]
    patch = {
        "stripe_subscription_id": latest.get("id"),
        "stripe_price_id": ((latest.get("items") or {}).get("data") or [{}])[0].get("price", {}).get("id"),
        "status": latest.get("status"),
        "trial_end": _from_unix_ts(latest.get("trial_end")),
        "current_period_end": _from_unix_ts(latest.get("current_period_end")),
        "cancel_at_period_end": int(bool(latest.get("cancel_at_period_end"))),
    }
    if patch["trial_end"] and not sub.get("trial_used_at"):
        patch["trial_used_at"] = datetime.now(timezone.utc).isoformat()
    _upsert_subscription(user_id, patch)
    return get_subscription(user_id)


def get_effective_tier(user_id: str, fallback_tier: str = "free") -> str:
    sub = get_subscription(user_id)
    status = (sub.get("status") or "").strip().lower()
    if status in PRO_BILLING_STATUSES:
        return "pro"
    trial_end = _parse_iso(sub.get("trial_end"))
    if trial_end and trial_end > datetime.now(timezone.utc):
        return "pro"
    return fallback_tier if fallback_tier == "pro" else "free"


def get_plan_snapshot(user_id: str, fallback_tier: str = "free") -> dict:
    sub = get_subscription(user_id)
    tier = get_effective_tier(user_id, fallback_tier=fallback_tier)
    status = (sub.get("status") or ("active" if tier == "pro" else "free")).lower()
    return {
        "tier": tier,
        "status": status,
        "provider": "stripe",
        "trial_end": sub.get("trial_end"),
        "current_period_end": sub.get("current_period_end"),
        "cancel_at_period_end": bool(sub.get("cancel_at_period_end") or 0),
        "stripe_customer_id": sub.get("stripe_customer_id"),
        "stripe_subscription_id": sub.get("stripe_subscription_id"),
    }


def create_checkout_session(user: dict) -> dict:
    if not STRIPE_PRO_PRICE_ID:
        raise RuntimeError("Stripe is not configured (missing STRIPE_PRO_PRICE_ID).")
    _ensure_stripe_configured()
    sub = get_subscription(user["user_id"])
    customer_id = sub.get("stripe_customer_id")
    if not customer_id:
        customer = stripe.Customer.create(
            email=user.get("email") or None,
            name=user.get("name") or None,
            metadata={"user_id": user["user_id"]},
        )
        customer_id = customer.get("id")
        _upsert_subscription(user["user_id"], {"stripe_customer_id": customer_id})

    trial_eligible = TRIAL_DAYS > 0 and not sub.get("trial_used_at")
    subscription_data = {"metadata": {"user_id": user["user_id"]}}
    if trial_eligible:
        subscription_data["trial_period_days"] = TRIAL_DAYS

    session = stripe.checkout.Session.create(
        mode="subscription",
        customer=customer_id,
        client_reference_id=user["user_id"],
        line_items=[{"price": STRIPE_PRO_PRICE_ID, "quantity": 1}],
        success_url=STRIPE_SUCCESS_URL,
        cancel_url=STRIPE_CANCEL_URL,
        subscription_data=subscription_data,
    )
    return {
        "checkout_url": session.get("url"),
        "session_id": session.get("id"),
        "trial_eligible": trial_eligible,
    }


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
    if STRIPE_SECRET_KEY:
        sync_subscription_from_stripe(user["user_id"])
    plan = get_plan_snapshot(user["user_id"], fallback_tier=user["tier"])
    quota = get_quota(user["user_id"], plan["tier"])
    return jsonify({
        "user_id":    user["user_id"],
        "email":      user["email"],
        "name":       user["name"],
        "avatar_url": user["avatar_url"],
        "tier":       plan["tier"],
        "plan":       plan,
        "quota":      quota,
        "limits": {
            "daily_downloads": FREE_DAILY_DOWNLOAD_LIMIT if plan["tier"] == "free" else None,
            "history":         FREE_HISTORY_LIMIT        if plan["tier"] == "free" else None,
            "queue":           FREE_QUEUE_LIMIT          if plan["tier"] == "free" else PRO_QUEUE_LIMIT,
        },
    })


@auth_bp.post("/logout")
def logout():
    """Clear the session cookie."""
    response = make_response(jsonify({"ok": True}))
    response.delete_cookie(COOKIE_NAME, path="/")
    return response
