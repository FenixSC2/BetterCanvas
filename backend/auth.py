# backend/auth.py
"""
User authentication, token storage, and encryption utilities.
"""

import os
import bcrypt
import hashlib
import secrets
import logging
import json
import time
from datetime import datetime, timezone, timedelta
from typing import Optional, Tuple
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
from sqlalchemy import Column, Integer, String, DateTime, Float, Boolean, create_engine, UniqueConstraint, inspect, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from cryptography.fernet import Fernet
from dotenv import load_dotenv
from pydantic import BaseModel, EmailStr, field_validator, model_validator

load_dotenv(Path(__file__).resolve().with_name(".env"))
logger = logging.getLogger("canvas_backend")


def _is_cloud_runtime() -> bool:
    return bool(os.getenv("AWS_REGION") or os.getenv("AWS_EXECUTION_ENV"))


def _read_secret_env(env_name: str, preferred_keys: tuple[str, ...] = ()) -> Optional[str]:
    """Read an env var and unwrap JSON secret payloads when needed."""
    raw = os.getenv(env_name)
    if raw is None:
        return None

    text = raw.strip()
    if not text:
        return None

    # Secrets Manager values are often stored as JSON blobs; support that format.
    if text.startswith("{") and text.endswith("}"):
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return text

        if isinstance(parsed, dict):
            for key in preferred_keys:
                value = parsed.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()

            # Fallback: if there is exactly one string value, use it.
            string_values = [v.strip() for v in parsed.values() if isinstance(v, str) and v.strip()]
            if len(string_values) == 1:
                return string_values[0]

    return text


def _ensure_postgres_runtime_params(url: str) -> str:
    """Ensure resilient PostgreSQL runtime params in cloud deployments."""
    if not url.startswith("postgresql+psycopg://"):
        return url

    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))

    # RDS commonly requires TLS when force_ssl is enabled.
    if _is_cloud_runtime() and "sslmode" not in query:
        query["sslmode"] = "require"

    # Keep connection failures fast so startup doesn't hang for long periods.
    if "connect_timeout" not in query:
        query["connect_timeout"] = "3"

    new_query = urlencode(query, doseq=True)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, new_query, parts.fragment))


def _default_sqlite_url() -> str:
    db_path = Path(__file__).resolve().with_name("canvas_better.db")
    return f"sqlite:///{db_path}"


def _resolve_db_url() -> str:
    """Normalize the database URL so SQLAlchemy uses the psycopg3 driver."""
    url = os.getenv("DATABASE_URL", _default_sqlite_url())
    if url.startswith("postgres://"):
        # Legacy Heroku/render scheme; also force psycopg3.
        return "postgresql+psycopg://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        # Default scheme makes SQLAlchemy try psycopg2, which is not installed.
        return "postgresql+psycopg://" + url[len("postgresql://"):]
    # Already includes driver (e.g. postgresql+psycopg://) or is sqlite.
    return url


def _resolve_database_url() -> str:
    """Resolve DB URL from common env names, falling back to local SQLite for dev."""
    raw = None
    for env_name in ("DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL", "RDS_DATABASE_URL"):
        raw = _read_secret_env(
            env_name,
            preferred_keys=(
                env_name,
                env_name.lower(),
                "DATABASE_URL",
                "database_url",
                "POSTGRES_URL",
                "postgres_url",
                "POSTGRESQL_URL",
                "postgresql_url",
                "RDS_DATABASE_URL",
                "rds_database_url",
                "url",
                "value",
            ),
        )
        if raw:
            break

    if not raw:
        return _default_sqlite_url()
    if raw.startswith("postgres://"):
        normalized = "postgresql+psycopg://" + raw[len("postgres://") :]
        return _ensure_postgres_runtime_params(normalized)
    if raw.startswith("postgresql://"):
        normalized = "postgresql+psycopg://" + raw[len("postgresql://") :]
        return _ensure_postgres_runtime_params(normalized)
    return _ensure_postgres_runtime_params(raw)


def describe_database_target(url: Optional[str] = None) -> str:
    """Return a credential-safe description of the active database target."""
    resolved = url or DATABASE_URL
    parts = urlsplit(resolved)
    host = parts.hostname or "local"
    port = parts.port or (5432 if parts.scheme.startswith("postgres") else "")
    path = parts.path.lstrip("/") or "default"
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    extras = []
    if query.get("sslmode"):
        extras.append(f"sslmode={query['sslmode']}")
    if query.get("connect_timeout"):
        extras.append(f"connect_timeout={query['connect_timeout']}")
    suffix = f" ({', '.join(extras)})" if extras else ""
    return f"{parts.scheme}://{host}:{port}/{path}{suffix}"


# Database setup
DATABASE_URL = _resolve_database_url()
if DATABASE_URL.startswith("sqlite") and _is_cloud_runtime():
    logger.warning(
        "DATABASE_URL resolved to SQLite in cloud runtime; data will not persist across redeploys. "
        "Set DATABASE_URL to your PostgreSQL endpoint."
    )
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_recycle=300,
    connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def _load_or_create_token_encryption_key() -> str:
    """Load token encryption key from env or a local persistent file."""
    env_key = _read_secret_env(
        "TOKEN_ENCRYPTION_KEY",
        preferred_keys=(
            "TOKEN_ENCRYPTION_KEY",
            "token_encryption_key",
            "key",
            "value",
        ),
    )
    if env_key:
        return env_key

    if _is_cloud_runtime():
        logger.warning(
            "TOKEN_ENCRYPTION_KEY is not set in environment. Falling back to local key file, "
            "which may rotate on redeploy and make stored Canvas tokens unreadable."
        )

    key_file = Path(__file__).resolve().parent / ".token_encryption_key"
    if key_file.exists():
        existing = key_file.read_text(encoding="utf-8").strip()
        if existing:
            return existing

    generated = Fernet.generate_key().decode()
    try:
        key_file.write_text(generated, encoding="utf-8")
    except OSError:
        # Fallback still works for current process; user can set env var later.
        pass
    return generated

# Encryption key for token storage
TOKEN_ENCRYPTION_KEY = _load_or_create_token_encryption_key()

cipher_suite = Fernet(TOKEN_ENCRYPTION_KEY.encode() if isinstance(TOKEN_ENCRYPTION_KEY, str) else TOKEN_ENCRYPTION_KEY)

# === Database Models ===
class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True)
    password_hash = Column(String)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    last_seen_announcement_id = Column(Integer, nullable=True, default=0)

class CanvasToken(Base):
    __tablename__ = "canvas_tokens"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, unique=True, index=True)  # one token per user
    token_encrypted = Column(String)  # encrypted Canvas token
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

class HiddenAssignment(Base):
    __tablename__ = "hidden_assignments"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, index=True)
    course_id = Column(Integer)
    assignment_id = Column(Integer)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    # Composite unique constraint: each user can hide each assignment once
    __table_args__ = (
        UniqueConstraint('user_id', 'course_id', 'assignment_id', name='uq_hidden_assignment'),
    )

class WorkloadEstimate(Base):
    __tablename__ = "workload_estimates"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, index=True)
    course_id = Column(Integer)
    assignment_id = Column(Integer)
    estimate_hours = Column(Float, default=0.0)
    completed_hours = Column(Float, default=0.0)
    completed = Column(Boolean, default=False)
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    __table_args__ = (
        UniqueConstraint('user_id', 'course_id', 'assignment_id', name='uq_workload_estimate'),
    )


WORKLOAD_ESTIMATE_RETENTION_DAYS = max(
    1,
    int(os.getenv("WORKLOAD_ESTIMATE_RETENTION_DAYS", "90")),
)

class AssignmentWeightOverride(Base):
    __tablename__ = "assignment_weight_overrides"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, index=True)
    course_id = Column(Integer)
    assignment_id = Column(Integer)
    weight_points = Column(Float, nullable=False)
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    __table_args__ = (
        UniqueConstraint('user_id', 'course_id', 'assignment_id', name='uq_assignment_weight_override'),
    )


class GradeScalePreference(Base):
    __tablename__ = "grade_scale_preferences"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, index=True)
    course_id = Column(Integer)
    mode = Column(String, nullable=False, default="standard")
    thresholds_json = Column(String, nullable=True)
    pass_threshold = Column(Float, nullable=True)
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    __table_args__ = (
        UniqueConstraint("user_id", "course_id", name="uq_grade_scale_preference"),
    )

class TodoItem(Base):
    __tablename__ = "todo_items"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, index=True)
    todo_id = Column(String, nullable=False)
    title = Column(String, nullable=False)
    notes = Column(String, default="")
    due_at = Column(String, nullable=True)
    completed = Column(Boolean, default=False)
    recurrence = Column(String, nullable=False, default="none")
    series_id = Column(String, nullable=True, index=True)
    occurrence_index = Column(Integer, nullable=False, default=0)
    anchor_due_at = Column(String, nullable=True)
    workload_reset_mode = Column(String, nullable=False, default="none")
    source = Column(String, nullable=True, default=None)
    created_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    __table_args__ = (
        UniqueConstraint('user_id', 'todo_id', name='uq_todo_item'),
    )

class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, index=True, nullable=False)
    token_hash = Column(String, unique=True, index=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)


class SessionToken(Base):
    __tablename__ = "session_tokens"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, index=True, nullable=False)
    token_hash = Column(String, unique=True, index=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

def _initialize_database() -> None:
    """Create database tables with retries to handle transient cloud startup issues."""
    attempts = int(os.getenv("DB_INIT_MAX_ATTEMPTS", "2" if _is_cloud_runtime() else "1"))
    delay_seconds = float(os.getenv("DB_INIT_RETRY_DELAY_SECONDS", "1" if _is_cloud_runtime() else "0"))

    for attempt in range(1, attempts + 1):
        try:
            Base.metadata.create_all(bind=engine)
            _ensure_todo_item_recurrence_columns()
            _ensure_user_announcement_columns()
            if attempt > 1:
                logger.info("Database initialization succeeded on retry %s/%s", attempt, attempts)
            return
        except Exception as exc:
            logger.error(
                "Database initialization attempt %s/%s failed for %s: %s",
                attempt,
                attempts,
                describe_database_target(),
                exc,
            )
            if attempt == attempts:
                logger.critical(
                    "Database initialization failed after %s attempts for %s. Verify DATABASE_URL, "
                    "RDS connectivity/security groups, and SSL requirements.",
                    attempts,
                    describe_database_target(),
                )
                raise RuntimeError(
                    "Database initialization failed after retries. "
                    "Verify DATABASE_URL, RDS connectivity/security groups, and SSL requirements."
                ) from exc
            time.sleep(delay_seconds)


def _ensure_todo_item_recurrence_columns() -> None:
    """Best-effort runtime migration for new recurrence columns on existing todo_items tables."""
    statements = [
        "ALTER TABLE todo_items ADD COLUMN recurrence VARCHAR",
        "ALTER TABLE todo_items ADD COLUMN series_id VARCHAR",
        "ALTER TABLE todo_items ADD COLUMN occurrence_index INTEGER",
        "ALTER TABLE todo_items ADD COLUMN anchor_due_at VARCHAR",
        "ALTER TABLE todo_items ADD COLUMN workload_reset_mode VARCHAR",
        "ALTER TABLE todo_items ADD COLUMN source VARCHAR",
    ]

    with engine.begin() as conn:
        inspector = inspect(conn)
        try:
            existing = {col["name"] for col in inspector.get_columns("todo_items")}
        except Exception:
            return

        for stmt in statements:
            col_name = stmt.split("ADD COLUMN", 1)[1].strip().split()[0]
            if col_name in existing:
                continue
            try:
                conn.execute(text(stmt))
                existing.add(col_name)
            except Exception:
                # Ignore add-column failures for portability; backfill below still runs.
                pass

        if "recurrence" in existing:
            conn.execute(
                text("UPDATE todo_items SET recurrence = 'none' WHERE recurrence IS NULL OR TRIM(recurrence) = ''")
            )
        if "occurrence_index" in existing:
            conn.execute(
                text("UPDATE todo_items SET occurrence_index = 0 WHERE occurrence_index IS NULL")
            )
        if "series_id" in existing:
            conn.execute(
                text("UPDATE todo_items SET series_id = todo_id WHERE series_id IS NULL OR TRIM(series_id) = ''")
            )
        if "anchor_due_at" in existing:
            conn.execute(
                text("UPDATE todo_items SET anchor_due_at = due_at WHERE anchor_due_at IS NULL OR TRIM(anchor_due_at) = ''")
            )
        if "workload_reset_mode" in existing:
            conn.execute(
                text("UPDATE todo_items SET workload_reset_mode = 'none' WHERE workload_reset_mode IS NULL OR TRIM(workload_reset_mode) = ''")
            )


def _ensure_user_announcement_columns() -> None:
    """Best-effort runtime migration to add last_seen_announcement_id to users table."""
    with engine.begin() as conn:
        inspector = inspect(conn)
        try:
            existing = {col["name"] for col in inspector.get_columns("users")}
        except Exception:
            return

        if "last_seen_announcement_id" not in existing:
            try:
                conn.execute(text("ALTER TABLE users ADD COLUMN last_seen_announcement_id INTEGER DEFAULT 0"))
            except Exception:
                pass


# === Password hashing ===
def hash_password(password: str) -> str:
    """Hash a password using bcrypt."""
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()

def verify_password(password: str, password_hash: str) -> bool:
    """Verify a password against its hash."""
    return bcrypt.checkpw(password.encode(), password_hash.encode())

# === Token encryption ===
def encrypt_token(token: str) -> str:
    """Encrypt a Canvas token for storage."""
    return cipher_suite.encrypt(token.encode()).decode()

def decrypt_token(encrypted_token: str) -> str:
    """Decrypt a Canvas token from storage."""
    return cipher_suite.decrypt(encrypted_token.encode()).decode()

# === Database operations ===
def get_db():
    """FastAPI dependency for database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def create_user(email: str, password: str, db: Session) -> User:
    """Create a new user."""
    db_user = User(email=email, password_hash=hash_password(password))
    db.add(db_user)
    db.commit()
    db.refresh(db_user)
    return db_user

def update_user_password(user: User, new_password: str, db: Session) -> User:
    """Update and persist a user's password hash."""
    user.password_hash = hash_password(new_password)
    db.commit()
    db.refresh(user)
    return user

def get_user_by_email(email: str, db: Session) -> Optional[User]:
    """Retrieve user by email."""
    return db.query(User).filter(User.email == email).first()

def get_user_by_id(user_id: int, db: Session) -> Optional[User]:
    """Retrieve user by ID."""
    return db.query(User).filter(User.id == user_id).first()

def store_canvas_token(user_id: int, token: str, db: Session) -> CanvasToken:
    """Store or update a Canvas token for a user."""
    existing = db.query(CanvasToken).filter(CanvasToken.user_id == user_id).first()
    encrypted = encrypt_token(token)
    
    if existing:
        existing.token_encrypted = encrypted
        existing.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(existing)
        return existing
    else:
        db_token = CanvasToken(user_id=user_id, token_encrypted=encrypted)
        db.add(db_token)
        db.commit()
        db.refresh(db_token)
        return db_token

def get_canvas_token(user_id: int, db: Session) -> Optional[str]:
    """Retrieve and decrypt a Canvas token for a user."""
    db_token = db.query(CanvasToken).filter(CanvasToken.user_id == user_id).first()
    if not db_token:
        return None
    try:
        return decrypt_token(db_token.token_encrypted)
    except Exception as e:
        logger.error(f"Failed to decrypt token for user {user_id}: {e}")
        return None

def revoke_canvas_token(user_id: int, db: Session) -> bool:
    """Delete a Canvas token for a user."""
    db_token = db.query(CanvasToken).filter(CanvasToken.user_id == user_id).first()
    if db_token:
        db.delete(db_token)
        db.commit()
        return True
    return False

def hide_assignment(user_id: int, course_id: int, assignment_id: int, db: Session) -> HiddenAssignment:
    """Add an assignment to the user's hidden list."""
    existing = db.query(HiddenAssignment).filter(
        HiddenAssignment.user_id == user_id,
        HiddenAssignment.course_id == course_id,
        HiddenAssignment.assignment_id == assignment_id
    ).first()
    
    if existing:
        return existing
    
    hidden = HiddenAssignment(
        user_id=user_id,
        course_id=course_id,
        assignment_id=assignment_id
    )
    db.add(hidden)
    db.commit()
    db.refresh(hidden)
    return hidden

def unhide_assignment(user_id: int, course_id: int, assignment_id: int, db: Session) -> bool:
    """Remove an assignment from the user's hidden list."""
    hidden = db.query(HiddenAssignment).filter(
        HiddenAssignment.user_id == user_id,
        HiddenAssignment.course_id == course_id,
        HiddenAssignment.assignment_id == assignment_id
    ).first()
    
    if hidden:
        db.delete(hidden)
        db.commit()
        return True
    return False

def get_hidden_assignments(user_id: int, db: Session) -> list:
    """Get all hidden assignments for a user as a list of (course_id, assignment_id) tuples."""
    hidden = db.query(HiddenAssignment).filter(HiddenAssignment.user_id == user_id).all()
    return [(h.course_id, h.assignment_id) for h in hidden]

# === Workload estimate CRUD ===

def get_workload_estimates(user_id: int, db: Session) -> list:
    """Get all workload estimates for a user."""
    prune_stale_workload_estimates(db, user_id=user_id)
    rows = db.query(WorkloadEstimate).filter(WorkloadEstimate.user_id == user_id).all()
    return [
        {
            "course_id": r.course_id,
            "assignment_id": r.assignment_id,
            "estimate_hours": r.estimate_hours,
            "completed_hours": r.completed_hours,
            "completed": bool(r.completed),
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        }
        for r in rows
    ]

def upsert_workload_estimate(
    user_id: int,
    course_id: int,
    assignment_id: int,
    estimate_hours: float,
    completed_hours: float,
    completed: bool,
    db: Session,
) -> WorkloadEstimate:
    """Create or update a workload estimate for a specific assignment."""
    prune_stale_workload_estimates(db, user_id=user_id)
    existing = db.query(WorkloadEstimate).filter(
        WorkloadEstimate.user_id == user_id,
        WorkloadEstimate.course_id == course_id,
        WorkloadEstimate.assignment_id == assignment_id,
    ).first()

    if existing:
        existing.estimate_hours = estimate_hours
        existing.completed_hours = completed_hours
        existing.completed = completed
        existing.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(existing)
        return existing
    else:
        row = WorkloadEstimate(
            user_id=user_id,
            course_id=course_id,
            assignment_id=assignment_id,
            estimate_hours=estimate_hours,
            completed_hours=completed_hours,
            completed=completed,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return row

def delete_workload_estimate(
    user_id: int, course_id: int, assignment_id: int, db: Session
) -> bool:
    """Delete a workload estimate for a specific assignment."""
    row = db.query(WorkloadEstimate).filter(
        WorkloadEstimate.user_id == user_id,
        WorkloadEstimate.course_id == course_id,
        WorkloadEstimate.assignment_id == assignment_id,
    ).first()
    if row:
        db.delete(row)
        db.commit()
        return True
    return False


def prune_stale_workload_estimates(
    db: Session,
    user_id: Optional[int] = None,
) -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(days=WORKLOAD_ESTIMATE_RETENTION_DAYS)
    query = db.query(WorkloadEstimate).filter(WorkloadEstimate.updated_at < cutoff)
    if user_id is not None:
        query = query.filter(WorkloadEstimate.user_id == user_id)
    deleted = query.delete(synchronize_session=False)
    if deleted:
        db.commit()
    return int(deleted or 0)


def get_assignment_weight_overrides(user_id: int, db: Session) -> list:
    """Get all assignment weight overrides for a user."""
    rows = (
        db.query(AssignmentWeightOverride)
        .filter(AssignmentWeightOverride.user_id == user_id)
        .all()
    )
    return [
        {
            "course_id": row.course_id,
            "assignment_id": row.assignment_id,
            "weight_points": row.weight_points,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        }
        for row in rows
    ]


def upsert_assignment_weight_override(
    user_id: int,
    course_id: int,
    assignment_id: int,
    weight_points: float,
    db: Session,
) -> AssignmentWeightOverride:
    """Create or update a user override for effective assignment weight/points."""
    existing = db.query(AssignmentWeightOverride).filter(
        AssignmentWeightOverride.user_id == user_id,
        AssignmentWeightOverride.course_id == course_id,
        AssignmentWeightOverride.assignment_id == assignment_id,
    ).first()

    if existing:
        existing.weight_points = weight_points
        existing.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(existing)
        return existing

    row = AssignmentWeightOverride(
        user_id=user_id,
        course_id=course_id,
        assignment_id=assignment_id,
        weight_points=weight_points,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def delete_assignment_weight_override(
    user_id: int,
    course_id: int,
    assignment_id: int,
    db: Session,
) -> bool:
    """Delete an assignment weight override for a user."""
    row = db.query(AssignmentWeightOverride).filter(
        AssignmentWeightOverride.user_id == user_id,
        AssignmentWeightOverride.course_id == course_id,
        AssignmentWeightOverride.assignment_id == assignment_id,
    ).first()
    if row:
        db.delete(row)
        db.commit()
        return True
    return False


def _normalize_grade_scale_mode(mode: Optional[str]) -> str:
    value = str(mode or "standard").strip().lower()
    if value in {"standard", "custom", "pass-fail"}:
        return value
    return "standard"


def _normalize_thresholds(thresholds: Optional[dict]) -> dict:
    if not isinstance(thresholds, dict):
        return {}
    out = {}
    for key, value in thresholds.items():
        n = float(value) if isinstance(value, (int, float, str)) and str(value).strip() else None
        if n is None:
            continue
        out[str(key)] = max(0.0, min(100.0, n))
    return out


def get_grade_scale_preferences(user_id: int, db: Session) -> list:
    rows = (
        db.query(GradeScalePreference)
        .filter(GradeScalePreference.user_id == user_id)
        .all()
    )

    out = []
    for row in rows:
        thresholds = {}
        if row.thresholds_json:
            try:
                parsed = json.loads(row.thresholds_json)
                thresholds = _normalize_thresholds(parsed)
            except json.JSONDecodeError:
                thresholds = {}
        out.append(
            {
                "course_id": row.course_id,
                "mode": _normalize_grade_scale_mode(row.mode),
                "thresholds": thresholds,
                "pass_threshold": row.pass_threshold,
                "updated_at": row.updated_at.isoformat() if row.updated_at else None,
            }
        )
    return out


def upsert_grade_scale_preference(
    user_id: int,
    course_id: int,
    mode: str,
    thresholds: Optional[dict],
    pass_threshold: Optional[float],
    db: Session,
) -> GradeScalePreference:
    safe_mode = _normalize_grade_scale_mode(mode)
    safe_thresholds = _normalize_thresholds(thresholds)
    safe_pass_threshold = None
    if pass_threshold is not None:
        safe_pass_threshold = max(0.0, min(100.0, float(pass_threshold)))

    existing = (
        db.query(GradeScalePreference)
        .filter(
            GradeScalePreference.user_id == user_id,
            GradeScalePreference.course_id == course_id,
        )
        .first()
    )

    payload_json = json.dumps(safe_thresholds) if safe_thresholds else None

    if existing:
        existing.mode = safe_mode
        existing.thresholds_json = payload_json
        existing.pass_threshold = safe_pass_threshold
        existing.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(existing)
        return existing

    row = GradeScalePreference(
        user_id=user_id,
        course_id=course_id,
        mode=safe_mode,
        thresholds_json=payload_json,
        pass_threshold=safe_pass_threshold,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


# === Personal todo CRUD ===

def _todo_to_dict(row: TodoItem) -> dict:
    return {
        "id": row.todo_id,
        "title": row.title,
        "notes": row.notes or "",
        "due_at": row.due_at,
        "completed": bool(row.completed),
        "recurrence": (row.recurrence or "none"),
        "series_id": row.series_id,
        "occurrence_index": int(row.occurrence_index or 0),
        "anchor_due_at": row.anchor_due_at,
        "workload_reset_mode": row.workload_reset_mode or "none",
        "source": getattr(row, "source", None),
        "createdAt": row.created_at.isoformat() if row.created_at else None,
        "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
    }


def _normalize_recurrence(raw: Optional[str]) -> str:
    value = str(raw or "none").strip().lower()
    return value if value in {"none", "daily", "weekly", "monthly", "yearly"} else "none"


def _normalize_workload_reset_mode(raw: Optional[str]) -> str:
    value = str(raw or "none").strip().lower()
    return value if value in {"none", "progress", "checklist", "both"} else "none"


def _parse_due_local(raw: Optional[str]) -> Optional[datetime]:
    text_value = str(raw or "").strip()
    if not text_value:
        return None
    try:
        parsed = datetime.fromisoformat(text_value)
    except ValueError:
        return None

    # Normalize to naive local-like datetime; frontend stores local ISO strings.
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def _fmt_due_local(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def _last_day_of_month(year: int, month: int) -> int:
    if month == 2:
        leap = (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0)
        return 29 if leap else 28
    if month in {4, 6, 9, 11}:
        return 30
    return 31


def _add_months_local(dt: datetime, months: int) -> datetime:
    total_month = (dt.month - 1) + months
    year = dt.year + (total_month // 12)
    month = (total_month % 12) + 1
    day = min(dt.day, _last_day_of_month(year, month))
    return dt.replace(year=year, month=month, day=day)


def _add_years_local(dt: datetime, years: int) -> datetime:
    target_year = dt.year + years
    day = dt.day
    if dt.month == 2 and dt.day == 29 and _last_day_of_month(target_year, 2) == 28:
        day = 28
    return dt.replace(year=target_year, day=day)


def _next_due_from(current_due_at: Optional[str], recurrence: str) -> Optional[str]:
    dt = _parse_due_local(current_due_at)
    if not dt:
        return None

    if recurrence == "daily":
        next_dt = dt + timedelta(days=1)
    elif recurrence == "weekly":
        next_dt = dt + timedelta(days=7)
    elif recurrence == "monthly":
        next_dt = _add_months_local(dt, 1)
    elif recurrence == "yearly":
        next_dt = _add_years_local(dt, 1)
    else:
        return None

    return _fmt_due_local(next_dt)


def _shift_due_by_occurrences(
    base_due_at: Optional[str],
    recurrence: str,
    occurrence_count: int,
) -> Optional[str]:
    if occurrence_count <= 0:
        return base_due_at

    candidate = base_due_at
    for _ in range(occurrence_count):
        candidate = _next_due_from(candidate, recurrence)
        if not candidate:
            return None
    return candidate


def _next_upcoming_due_from(current_due_at: Optional[str], recurrence: str) -> Optional[str]:
    """Advance recurrence to the next upcoming slot; generates exactly one next occurrence."""
    recurrence = _normalize_recurrence(recurrence)
    if recurrence == "none":
        return None

    now_local = datetime.now()
    candidate = current_due_at
    for _ in range(2000):
        candidate = _next_due_from(candidate, recurrence)
        if not candidate:
            return None
        parsed = _parse_due_local(candidate)
        if parsed and parsed >= now_local:
            return candidate
    return candidate


def _generate_next_recurring_occurrence(
    source_row: TodoItem,
    db: Session,
) -> Optional[TodoItem]:
    recurrence = _normalize_recurrence(source_row.recurrence)
    if recurrence == "none":
        return None

    base_due = source_row.due_at or source_row.anchor_due_at
    next_due_at = _next_upcoming_due_from(base_due, recurrence)
    if not next_due_at:
        return None

    series_id = (source_row.series_id or source_row.todo_id or "").strip()
    if not series_id:
        return None

    existing = (
        db.query(TodoItem)
        .filter(
            TodoItem.user_id == source_row.user_id,
            TodoItem.series_id == series_id,
            TodoItem.due_at == next_due_at,
            TodoItem.completed == False,  # noqa: E712
        )
        .first()
    )
    if existing:
        return None

    max_index = (
        db.query(TodoItem)
        .filter(TodoItem.user_id == source_row.user_id, TodoItem.series_id == series_id)
        .order_by(TodoItem.occurrence_index.desc(), TodoItem.id.desc())
        .first()
    )
    next_index = int(max_index.occurrence_index or 0) + 1 if max_index else 1

    next_todo_id = f"{series_id}__r{next_index}"
    while (
        db.query(TodoItem)
        .filter(TodoItem.user_id == source_row.user_id, TodoItem.todo_id == next_todo_id)
        .first()
    ):
        next_index += 1
        next_todo_id = f"{series_id}__r{next_index}"

    created = TodoItem(
        user_id=source_row.user_id,
        todo_id=next_todo_id,
        title=source_row.title,
        notes=source_row.notes or "",
        due_at=next_due_at,
        completed=False,
        recurrence=recurrence,
        series_id=series_id,
        occurrence_index=next_index,
        anchor_due_at=source_row.anchor_due_at or source_row.due_at,
        workload_reset_mode=source_row.workload_reset_mode or "none",
    )
    db.add(created)
    return created


def _ensure_recurring_next_occurrences(user_id: int, db: Session) -> None:
    """On reads, heal missing next occurrences for completed recurring series."""
    latest_by_series = {}
    rows = (
        db.query(TodoItem)
        .filter(TodoItem.user_id == user_id, TodoItem.recurrence.isnot(None), TodoItem.series_id.isnot(None))
        .order_by(TodoItem.series_id.asc(), TodoItem.occurrence_index.desc(), TodoItem.id.desc())
        .all()
    )
    for row in rows:
        sid = (row.series_id or "").strip()
        if not sid or sid in latest_by_series:
            continue
        latest_by_series[sid] = row

    created_any = False
    for row in latest_by_series.values():
        recurrence = _normalize_recurrence(row.recurrence)
        if recurrence == "none" or not row.completed:
            continue
        created = _generate_next_recurring_occurrence(row, db)
        if created is not None:
            created_any = True

    if created_any:
        db.commit()


def _normalize_edit_scope(raw: Optional[str]) -> str:
    value = str(raw or "this-occurrence").strip().lower()
    return value if value in {"this-occurrence", "this-and-future"} else "this-occurrence"


def _normalize_delete_scope(raw: Optional[str]) -> str:
    value = str(raw or "this-occurrence").strip().lower()
    return value if value in {"this-occurrence", "this-and-future"} else "this-occurrence"


def _apply_future_series_updates(
    current_row: TodoItem,
    db: Session,
    title: str,
    notes: str,
    due_at: Optional[str],
    recurrence: str,
    workload_reset_mode: str,
) -> None:
    series_id = str(current_row.series_id or current_row.todo_id or "").strip()
    if not series_id:
        return

    current_index = int(current_row.occurrence_index or 0)

    future_rows = (
        db.query(TodoItem)
        .filter(
            TodoItem.user_id == current_row.user_id,
            TodoItem.series_id == series_id,
            TodoItem.occurrence_index > current_index,
        )
        .order_by(TodoItem.occurrence_index.asc(), TodoItem.id.asc())
        .all()
    )

    if recurrence == "none":
        for future_row in future_rows:
            db.delete(future_row)
        return

    for future_row in future_rows:
        offset = max(0, int(future_row.occurrence_index or 0) - current_index)
        shifted_due = _shift_due_by_occurrences(due_at, recurrence, offset)
        future_row.title = title
        future_row.notes = notes
        future_row.recurrence = recurrence
        future_row.series_id = series_id
        future_row.workload_reset_mode = workload_reset_mode
        if shifted_due:
            future_row.due_at = shifted_due
            future_row.anchor_due_at = shifted_due
        future_row.updated_at = datetime.now(timezone.utc)


def get_todos(user_id: int, db: Session) -> list:
    """Get all personal todo items for a user."""
    _ensure_recurring_next_occurrences(user_id, db)
    rows = (
        db.query(TodoItem)
        .filter(TodoItem.user_id == user_id)
        .order_by(TodoItem.created_at.asc(), TodoItem.id.asc())
        .all()
    )
    return [_todo_to_dict(row) for row in rows]


def create_todo(
    user_id: int,
    todo_id: str,
    title: str,
    notes: str,
    due_at: Optional[str],
    completed: bool,
    db: Session,
    recurrence: str = "none",
    series_id: Optional[str] = None,
    occurrence_index: int = 0,
    anchor_due_at: Optional[str] = None,
    workload_reset_mode: str = "none",
    source: Optional[str] = None,
) -> TodoItem:
    existing = (
        db.query(TodoItem)
        .filter(TodoItem.user_id == user_id, TodoItem.todo_id == todo_id)
        .first()
    )
    if existing:
        raise ValueError("Todo item already exists")

    normalized_recurrence = _normalize_recurrence(recurrence)
    normalized_workload_reset_mode = _normalize_workload_reset_mode(workload_reset_mode)
    normalized_series_id = str(series_id or "").strip() or todo_id
    normalized_index = max(0, int(occurrence_index or 0))
    normalized_anchor = (str(anchor_due_at).strip() if anchor_due_at is not None else None) or due_at

    row = TodoItem(
        user_id=user_id,
        todo_id=todo_id,
        title=title,
        notes=notes,
        due_at=due_at,
        completed=completed,
        recurrence=normalized_recurrence,
        series_id=normalized_series_id,
        occurrence_index=normalized_index,
        anchor_due_at=normalized_anchor,
        workload_reset_mode=normalized_workload_reset_mode,
        source=source,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def update_todo(
    user_id: int,
    todo_id: str,
    title: str,
    notes: str,
    due_at: Optional[str],
    completed: bool,
    db: Session,
    recurrence: str = "none",
    series_id: Optional[str] = None,
    occurrence_index: int = 0,
    anchor_due_at: Optional[str] = None,
    workload_reset_mode: str = "none",
) -> Optional[TodoItem]:
    row, _ = update_todo_with_recurrence(
        user_id,
        todo_id,
        title,
        notes,
        due_at,
        completed,
        db,
        recurrence=recurrence,
        series_id=series_id,
        occurrence_index=occurrence_index,
        anchor_due_at=anchor_due_at,
        workload_reset_mode=workload_reset_mode,
    )
    return row


def update_todo_with_recurrence(
    user_id: int,
    todo_id: str,
    title: str,
    notes: str,
    due_at: Optional[str],
    completed: bool,
    db: Session,
    recurrence: str = "none",
    series_id: Optional[str] = None,
    occurrence_index: int = 0,
    anchor_due_at: Optional[str] = None,
    edit_scope: str = "this-occurrence",
    workload_reset_mode: str = "none",
) -> Tuple[Optional[TodoItem], Optional[TodoItem]]:
    row = (
        db.query(TodoItem)
        .filter(TodoItem.user_id == user_id, TodoItem.todo_id == todo_id)
        .first()
    )
    if not row:
        return None, None

    was_completed = bool(row.completed)
    normalized_recurrence = _normalize_recurrence(recurrence)
    normalized_workload_reset_mode = _normalize_workload_reset_mode(workload_reset_mode)
    normalized_series_id = str(series_id or "").strip() or row.series_id or row.todo_id
    normalized_index = max(0, int(occurrence_index or 0))
    normalized_anchor = (str(anchor_due_at).strip() if anchor_due_at is not None else None) or row.anchor_due_at or due_at
    normalized_edit_scope = _normalize_edit_scope(edit_scope)

    row.title = title
    row.notes = notes
    row.due_at = due_at
    row.completed = completed
    row.recurrence = normalized_recurrence
    row.series_id = normalized_series_id
    row.occurrence_index = normalized_index
    row.anchor_due_at = normalized_anchor
    row.workload_reset_mode = normalized_workload_reset_mode
    row.updated_at = datetime.now(timezone.utc)

    if normalized_edit_scope == "this-and-future":
        _apply_future_series_updates(
            row,
            db,
            title=title,
            notes=notes,
            due_at=due_at,
            recurrence=normalized_recurrence,
            workload_reset_mode=normalized_workload_reset_mode,
        )

    generated_row = None
    if normalized_recurrence != "none" and (not was_completed and completed):
        generated_row = _generate_next_recurring_occurrence(row, db)

    db.commit()
    db.refresh(row)
    if generated_row is not None:
        db.refresh(generated_row)
    return row, generated_row


def delete_todo(
    user_id: int,
    todo_id: str,
    db: Session,
    delete_scope: str = "this-occurrence",
) -> list[str]:
    row = (
        db.query(TodoItem)
        .filter(TodoItem.user_id == user_id, TodoItem.todo_id == todo_id)
        .first()
    )
    if not row:
        return []

    normalized_delete_scope = _normalize_delete_scope(delete_scope)
    deleted_ids: list[str] = []

    if normalized_delete_scope == "this-and-future":
        series_id = str(row.series_id or row.todo_id or "").strip()
        current_index = int(row.occurrence_index or 0)
        if series_id:
            rows = (
                db.query(TodoItem)
                .filter(
                    TodoItem.user_id == user_id,
                    TodoItem.series_id == series_id,
                    TodoItem.occurrence_index >= current_index,
                )
                .order_by(TodoItem.occurrence_index.asc(), TodoItem.id.asc())
                .all()
            )
            if rows:
                deleted_ids = [str(item.todo_id) for item in rows]
                for item in rows:
                    db.delete(item)

    if not deleted_ids:
        deleted_ids = [str(row.todo_id)]
        db.delete(row)

    db.commit()
    return deleted_ids


# === Persistent auth sessions ===
def _hash_session_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _is_expired(expires_at: Optional[datetime]) -> bool:
    """Return True when expires_at is in the past, handling naive/aware values."""
    if not expires_at:
        return True
    if expires_at.tzinfo is None:
        return expires_at <= datetime.utcnow()
    return expires_at <= datetime.now(timezone.utc)


def create_session(user_id: int, db: Session, days_valid: int = 30) -> str:
    """Create a persistent auth session token and return the raw token."""
    raw_token = secrets.token_urlsafe(32)
    row = SessionToken(
        user_id=user_id,
        token_hash=_hash_session_token(raw_token),
        expires_at=datetime.now(timezone.utc) + timedelta(days=days_valid),
    )
    db.add(row)
    db.commit()
    return raw_token


def get_session_user_id(raw_token: str, db: Session) -> Optional[int]:
    """Return user id for a valid auth session token, else None."""
    if not raw_token:
        return None

    row = (
        db.query(SessionToken)
        .filter(SessionToken.token_hash == _hash_session_token(raw_token))
        .first()
    )
    if not row:
        return None
    if _is_expired(row.expires_at):
        db.delete(row)
        db.commit()
        return None
    return int(row.user_id)


def invalidate_session(raw_token: str, db: Session) -> None:
    """Invalidate one auth session token."""
    if not raw_token:
        return
    row = (
        db.query(SessionToken)
        .filter(SessionToken.token_hash == _hash_session_token(raw_token))
        .first()
    )
    if row:
        db.delete(row)
        db.commit()


def invalidate_user_sessions(user_id: int, db: Session) -> None:
    """Invalidate all auth sessions for a user."""
    db.query(SessionToken).filter(SessionToken.user_id == user_id).delete(
        synchronize_session=False
    )
    db.commit()

# === Password reset helpers ===

def _hash_reset_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()

def create_password_reset_token(user_id: int, db: Session, minutes_valid: int = 30) -> str:
    """Create a one-time password reset token and return the raw token value."""
    now = datetime.now(timezone.utc)
    # Invalidate any previous active reset tokens for this user.
    active_rows = db.query(PasswordResetToken).filter(
        PasswordResetToken.user_id == user_id,
        PasswordResetToken.used_at.is_(None),
        PasswordResetToken.expires_at > now,
    ).all()
    for row in active_rows:
        row.used_at = now

    raw_token = secrets.token_urlsafe(48)
    row = PasswordResetToken(
        user_id=user_id,
        token_hash=_hash_reset_token(raw_token),
        expires_at=now + timedelta(minutes=minutes_valid),
    )
    db.add(row)
    db.commit()
    return raw_token

def get_valid_password_reset_token(raw_token: str, db: Session) -> Optional[PasswordResetToken]:
    """Return a token row if present, unexpired, and unused."""
    token_hash = _hash_reset_token(raw_token)
    row = db.query(PasswordResetToken).filter(PasswordResetToken.token_hash == token_hash).first()
    if not row:
        return None
    if row.used_at is not None:
        return None
    if _is_expired(row.expires_at):
        return None
    return row

def mark_password_reset_token_used(row: PasswordResetToken, db: Session) -> None:
    """Mark a reset token as used."""
    row.used_at = datetime.now(timezone.utc)
    db.commit()

# === Pydantic schemas ===
class UserLogin(BaseModel):
    email: EmailStr
    password: str

class UserCreate(UserLogin):
    @field_validator("password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain at least one number")
        if not any(c.isalpha() for c in v):
            raise ValueError("Password must contain at least one letter")
        return v

class UserResponse(BaseModel):
    id: int
    email: str
    created_at: datetime

    class Config:
        from_attributes = True

class CanvasTokenRequest(BaseModel):
    token: str

class ForgotPasswordRequest(BaseModel):
    email: EmailStr

class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain at least one number")
        if not any(c.isalpha() for c in v):
            raise ValueError("Password must contain at least one letter")
        return v

class CanvasTokenStatus(BaseModel):
    has_token: bool
    updated_at: Optional[datetime] = None


class TodoItemPayload(BaseModel):
    id: str
    title: str
    notes: str = ""
    due_at: Optional[str] = None
    completed: bool = False
    recurrence: str = "none"
    series_id: Optional[str] = None
    occurrence_index: int = 0
    anchor_due_at: Optional[str] = None
    edit_scope: str = "this-occurrence"
    workload_reset_mode: str = "none"
    source: Optional[str] = None

    @field_validator("id", "title")
    @classmethod
    def required_text(cls, v: str) -> str:
        text = str(v or "").strip()
        if not text:
            raise ValueError("Field is required")
        return text

    @field_validator("notes")
    @classmethod
    def normalize_notes(cls, v: str) -> str:
        return str(v or "")

    @field_validator("due_at")
    @classmethod
    def normalize_due_at(cls, v: Optional[str]) -> Optional[str]:
        text = str(v).strip() if v is not None else None
        return text or None

    @field_validator("anchor_due_at")
    @classmethod
    def normalize_anchor_due_at(cls, v: Optional[str]) -> Optional[str]:
        text = str(v).strip() if v is not None else None
        return text or None

    @field_validator("recurrence")
    @classmethod
    def normalize_recurrence(cls, v: str) -> str:
        return _normalize_recurrence(v)

    @field_validator("occurrence_index")
    @classmethod
    def normalize_occurrence_index(cls, v: int) -> int:
        n = int(v or 0)
        return max(0, n)

    @field_validator("edit_scope")
    @classmethod
    def normalize_edit_scope(cls, v: str) -> str:
        return _normalize_edit_scope(v)

    @field_validator("workload_reset_mode")
    @classmethod
    def normalize_workload_reset_mode(cls, v: str) -> str:
        return _normalize_workload_reset_mode(v)

    @model_validator(mode="after")
    def validate_recurrence_requires_due(self):
        if self.recurrence != "none" and not (self.due_at or self.anchor_due_at):
            raise ValueError("Recurring todos require due_at or anchor_due_at")
        if not self.series_id:
            self.series_id = self.id
        if not self.anchor_due_at:
            self.anchor_due_at = self.due_at
        return self
