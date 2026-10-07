# backend/analytics.py
"""Lightweight first-party usage analytics.

No extra cookies or client-side tracking: activity is derived from the session
cookie the API already sets. "Online now" is kept in memory (the service runs a
single worker, so a restart just resets it); daily activity is one row per
visitor per day in `activity_days`, pruned after RETENTION_DAYS.
"""
from __future__ import annotations

import hashlib
import logging
import time
from datetime import date, datetime, timedelta, timezone
from threading import Lock
from typing import Optional
from zoneinfo import ZoneInfo

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from auth import ActivityDay, CanvasToken, SessionLocal, User, get_session_user_id

logger = logging.getLogger(__name__)

# Days roll over on Boston time, since the users are Northeastern students.
STATS_TZ = ZoneInfo("America/New_York")
ONLINE_WINDOW_SECONDS = 5 * 60
RETENTION_DAYS = 90
SERIES_DAYS = 30
_SESSION_CACHE_SECONDS = 10 * 60
_SESSION_CACHE_MAX = 10_000

_lock = Lock()
_last_seen: dict[str, float] = {}  # visitor -> unix time of last request
_recorded: set[tuple[date, str]] = set()  # (day, visitor) rows already written
_session_cache: dict[str, tuple[Optional[str], float]] = {}  # session hash -> (visitor, cached at)
_last_prune_day: Optional[date] = None


def _today() -> date:
    return datetime.now(STATS_TZ).date()


def _resolve_visitor(session_id: str, is_demo: bool, admin_emails: set[str]) -> Optional[str]:
    """Map a session cookie to a visitor key, or None for invalid sessions and admins."""
    digest = hashlib.sha256(session_id.encode()).hexdigest()
    if is_demo:
        # Demo tokens are stateless; each one is a separate demo session.
        return "d:" + digest[:16]

    now = time.time()
    with _lock:
        cached = _session_cache.get(digest)
    if cached and now - cached[1] < _SESSION_CACHE_SECONDS:
        return cached[0]

    visitor = None
    db = SessionLocal()
    try:
        user_id = get_session_user_id(session_id, db)
        if user_id is not None:
            user = db.get(User, user_id)
            if user and (user.email or "").lower() not in admin_emails:
                visitor = f"u:{user_id}"
    finally:
        db.close()

    with _lock:
        if len(_session_cache) >= _SESSION_CACHE_MAX:
            _session_cache.clear()
        _session_cache[digest] = (visitor, now)
    return visitor


def _store_day(day: date, visitor: str) -> None:
    global _last_prune_day
    db = SessionLocal()
    try:
        if _last_prune_day != day:
            cutoff = day - timedelta(days=RETENTION_DAYS)
            db.query(ActivityDay).filter(ActivityDay.day < cutoff).delete(synchronize_session=False)
            db.commit()
            _last_prune_day = day
        db.add(ActivityDay(day=day, visitor=visitor, kind="demo" if visitor.startswith("d:") else "user"))
        db.commit()
    except IntegrityError:
        db.rollback()  # already recorded before a restart
    except SQLAlchemyError:
        db.rollback()
        logger.warning("Failed to record activity", exc_info=True)
        with _lock:
            _recorded.discard((day, visitor))  # retry on the next request
    finally:
        db.close()


def record_activity(session_id: str, is_demo: bool, admin_emails: set[str]) -> None:
    """Note that this session made a request. Cheap after the first call per session."""
    visitor = _resolve_visitor(session_id, is_demo, admin_emails)
    if not visitor:
        return
    today = _today()
    with _lock:
        _last_seen[visitor] = time.time()
        if (today, visitor) in _recorded:
            return
        if any(d != today for d, _ in _recorded):
            _recorded.difference_update({k for k in _recorded if k[0] != today})
        _recorded.add((today, visitor))
    _store_day(today, visitor)


def forget_user(user_id: int) -> None:
    """Drop in-memory traces of a deleted user."""
    visitor = f"u:{user_id}"
    with _lock:
        _last_seen.pop(visitor, None)
        _recorded.difference_update({k for k in _recorded if k[1] == visitor})
        for digest, (cached_visitor, _) in list(_session_cache.items()):
            if cached_visitor == visitor:
                del _session_cache[digest]


def usage_stats(db: Session) -> dict:
    now = time.time()
    with _lock:
        for visitor, seen in list(_last_seen.items()):
            if now - seen > ONLINE_WINDOW_SECONDS:
                del _last_seen[visitor]
        online_users = sum(1 for v in _last_seen if v.startswith("u:"))
        online_demo = len(_last_seen) - online_users

    today = _today()

    def active(kind: str, days: int) -> int:
        since = today - timedelta(days=days - 1)
        return (
            db.query(func.count(func.distinct(ActivityDay.visitor)))
            .filter(ActivityDay.kind == kind, ActivityDay.day >= since)
            .scalar()
            or 0
        )

    first_day = today - timedelta(days=SERIES_DAYS - 1)
    counts = {
        (day, kind): n
        for day, kind, n in db.query(ActivityDay.day, ActivityDay.kind, func.count())
        .filter(ActivityDay.day >= first_day)
        .group_by(ActivityDay.day, ActivityDay.kind)
    }
    series = []
    for i in range(SERIES_DAYS):
        day = first_day + timedelta(days=i)
        series.append({
            "day": day.isoformat(),
            "users": counts.get((day, "user"), 0),
            "demo": counts.get((day, "demo"), 0),
        })

    # created_at columns are naive UTC.
    week_ago = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=7)
    return {
        "online": {"users": online_users, "demo": online_demo, "window_minutes": ONLINE_WINDOW_SECONDS // 60},
        "users": {"day": active("user", 1), "week": active("user", 7), "month": active("user", 30)},
        "demo": {"day": active("demo", 1), "week": active("demo", 7), "month": active("demo", 30)},
        "accounts": {
            "total": db.query(func.count(User.id)).scalar() or 0,
            "new_this_week": db.query(func.count(User.id)).filter(User.created_at >= week_ago).scalar() or 0,
            "canvas_connected": db.query(func.count(CanvasToken.id)).scalar() or 0,
        },
        "series": series,
        "timezone": "America/New_York",
    }
