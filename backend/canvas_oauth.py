# backend/canvas_oauth.py
"""Canvas OAuth2 (authorization code flow) for connecting a user's Canvas account.

Canvas's API policy requires apps used by multiple people to obtain tokens
through OAuth with a developer key issued by the school, rather than asking
users to paste personal access tokens. This module is inert until the
CANVAS_OAUTH_* settings are present.

Flow: /api/auth/canvas/start redirects to Canvas with a signed `state`;
Canvas redirects back to /api/auth/canvas/callback with a code, which is
exchanged for an access token (about an hour) and a refresh token (long-lived,
reused across refreshes). Both are stored encrypted in canvas_tokens.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Optional
from urllib.parse import urlencode

import requests
from sqlalchemy.orm import Session

from auth import TOKEN_ENCRYPTION_KEY, CanvasToken, decrypt_token, encrypt_token

logger = logging.getLogger(__name__)

CANVAS_BASE_URL = os.getenv("CANVAS_BASE_URL", "https://northeastern.instructure.com").rstrip("/")
CLIENT_ID = os.getenv("CANVAS_OAUTH_CLIENT_ID", "").strip()
CLIENT_SECRET = os.getenv("CANVAS_OAUTH_CLIENT_SECRET", "").strip()
REDIRECT_URI = os.getenv("CANVAS_OAUTH_REDIRECT_URI", "").strip()
# Space-separated "url:GET|/api/v1/..." scopes; only needed if the key enforces scopes.
SCOPES = " ".join(os.getenv("CANVAS_OAUTH_SCOPES", "").split())

OAUTH_ENABLED = bool(CLIENT_ID and CLIENT_SECRET and REDIRECT_URI)
# Pasted tokens are allowed only until OAuth is configured, unless explicitly overridden.
_allow_personal = os.getenv("CANVAS_ALLOW_PERSONAL_TOKENS", "").strip().lower()
PERSONAL_TOKENS_ALLOWED = (_allow_personal == "true") if _allow_personal else not OAUTH_ENABLED

STATE_COOKIE = "canvas_oauth_nonce"
STATE_TTL_SECONDS = 10 * 60
_REFRESH_MARGIN = timedelta(minutes=2)
_HTTP_TIMEOUT = 10

_STATE_KEY = hashlib.sha256(b"canvassist-canvas-oauth-state:" + TOKEN_ENCRYPTION_KEY.encode()).digest()
_refresh_locks: dict[int, Lock] = {}
_refresh_locks_guard = Lock()


class OAuthError(Exception):
    """The Canvas OAuth exchange failed; `reason` is safe to show in a redirect."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _utcnow() -> datetime:
    # canvas_tokens timestamps are naive UTC.
    return datetime.now(timezone.utc).replace(tzinfo=None)


# --- state -------------------------------------------------------------------

def _sign(payload: str) -> str:
    return hmac.new(_STATE_KEY, payload.encode(), hashlib.sha256).hexdigest()


def new_state(user_id: int) -> tuple[str, str]:
    """Return (state for Canvas, nonce for the browser cookie)."""
    nonce = secrets.token_urlsafe(16)
    payload = f"{user_id}.{int(time.time()) + STATE_TTL_SECONDS}.{nonce}"
    return f"{payload}.{_sign(payload)}", nonce


def verify_state(state: str, nonce_cookie: Optional[str], user_id: int) -> bool:
    """The state must be ours, unexpired, issued to this user, and started in this browser."""
    try:
        uid, expires, nonce, sig = state.split(".")
    except (AttributeError, ValueError):
        return False
    payload = f"{uid}.{expires}.{nonce}"
    return (
        hmac.compare_digest(sig, _sign(payload))
        and expires.isdigit()
        and int(expires) >= time.time()
        and uid == str(user_id)
        and bool(nonce_cookie)
        and hmac.compare_digest(nonce, nonce_cookie)
    )


def authorize_url(state: str) -> str:
    params = {
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "state": state,
        "purpose": "CanvAssist",
    }
    if SCOPES:
        params["scope"] = SCOPES
    return f"{CANVAS_BASE_URL}/login/oauth2/auth?{urlencode(params)}"


# --- token exchange ------------------------------------------------------------

def _token_request(data: dict) -> dict:
    try:
        r = requests.post(
            f"{CANVAS_BASE_URL}/login/oauth2/token",
            data={"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET, **data},
            timeout=_HTTP_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise OAuthError("unreachable") from exc
    if r.status_code in (400, 401):
        raise OAuthError("rejected")
    if r.status_code != 200:
        raise OAuthError("failed")
    body = r.json()
    if not body.get("access_token"):
        raise OAuthError("failed")
    return body


def _expiry(body: dict) -> Optional[datetime]:
    seconds = body.get("expires_in")
    return _utcnow() + timedelta(seconds=int(seconds)) if seconds else None


def exchange_code(user_id: int, code: str, db: Session) -> None:
    """Trade an authorization code for tokens and store them for the user."""
    body = _token_request({
        "grant_type": "authorization_code",
        "redirect_uri": REDIRECT_URI,
        "code": code,
    })
    if not body.get("refresh_token"):
        raise OAuthError("failed")

    row = db.query(CanvasToken).filter(CanvasToken.user_id == user_id).first()
    previous_access = _decrypt_or_none(row.token_encrypted) if row and row.auth_type == "oauth" else None
    if row is None:
        row = CanvasToken(user_id=user_id)
        db.add(row)
    row.auth_type = "oauth"
    row.token_encrypted = encrypt_token(body["access_token"])
    row.refresh_token_encrypted = encrypt_token(body["refresh_token"])
    row.expires_at = _expiry(body)
    row.updated_at = datetime.now(timezone.utc)
    db.commit()

    if previous_access:
        revoke_remote(previous_access)  # reconnecting replaces the old grant


def _decrypt_or_none(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    try:
        return decrypt_token(value)
    except Exception:
        logger.error("Canvas token decryption failed", exc_info=True)
        return None


def _lock_for(user_id: int) -> Lock:
    with _refresh_locks_guard:
        return _refresh_locks.setdefault(user_id, Lock())


def get_canvas_token(user_id: int, db: Session) -> Optional[str]:
    """Return a usable Canvas access token for the user, refreshing OAuth tokens as needed.

    Returns None when the user has no usable token, so callers respond with
    "Canvas token required" and the app asks them to connect Canvas.
    """
    row = db.query(CanvasToken).filter(CanvasToken.user_id == user_id).first()
    if row is None:
        return None

    if row.auth_type != "oauth":
        if not PERSONAL_TOKENS_ALLOWED:
            return None  # must reconnect through OAuth
        return _decrypt_or_none(row.token_encrypted)

    if row.expires_at is None or row.expires_at - _REFRESH_MARGIN > _utcnow():
        return _decrypt_or_none(row.token_encrypted)

    with _lock_for(user_id):
        db.refresh(row)  # another request may have refreshed while we waited
        if row.expires_at and row.expires_at - _REFRESH_MARGIN > _utcnow():
            return _decrypt_or_none(row.token_encrypted)

        refresh_token = _decrypt_or_none(row.refresh_token_encrypted)
        if not refresh_token:
            return None
        try:
            body = _token_request({"grant_type": "refresh_token", "refresh_token": refresh_token})
        except OAuthError as exc:
            if exc.reason == "rejected":
                # The grant was revoked (e.g. removed in Canvas); forget it so the user reconnects.
                logger.info("Canvas refresh token rejected for user %s; removing connection", user_id)
                db.delete(row)
                db.commit()
                return None
            logger.warning("Canvas token refresh failed for user %s: %s", user_id, exc.reason)
            return _decrypt_or_none(row.token_encrypted)

        row.token_encrypted = encrypt_token(body["access_token"])
        if body.get("refresh_token"):
            row.refresh_token_encrypted = encrypt_token(body["refresh_token"])
        row.expires_at = _expiry(body)
        db.commit()
        return body["access_token"]


def revoke_remote(access_token: str) -> None:
    """Best-effort revocation of an OAuth grant on Canvas."""
    try:
        requests.delete(
            f"{CANVAS_BASE_URL}/login/oauth2/token",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=_HTTP_TIMEOUT,
        )
    except requests.RequestException:
        logger.warning("Canvas token revocation request failed", exc_info=True)


def revoke_user_grant(user_id: int, db: Session) -> None:
    """Revoke the user's OAuth grant on Canvas, if they have one. Leaves the DB row alone."""
    row = db.query(CanvasToken).filter(CanvasToken.user_id == user_id).first()
    if row is None or row.auth_type != "oauth":
        return
    access = get_canvas_token(user_id, db)  # refresh first so the revoke is authorized
    if access:
        revoke_remote(access)
