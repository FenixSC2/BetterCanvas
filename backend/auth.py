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
from typing import Optional
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
from sqlalchemy import Column, Integer, String, DateTime, Float, Boolean, create_engine, UniqueConstraint
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from cryptography.fernet import Fernet
from dotenv import load_dotenv
from pydantic import BaseModel, EmailStr, field_validator

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
        query["connect_timeout"] = "5"

    new_query = urlencode(query, doseq=True)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, new_query, parts.fragment))

# Database setup
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
        return "sqlite:///./canvas_better.db"
    if raw.startswith("postgres://"):
        # Normalize legacy scheme and force psycopg3 driver.
        normalized = "postgresql+psycopg://" + raw[len("postgres://") :]
        return _ensure_postgres_runtime_params(normalized)
    if raw.startswith("postgresql://"):
        # Default SQLAlchemy postgres dialect expects psycopg2; we install psycopg3.
        normalized = "postgresql+psycopg://" + raw[len("postgresql://") :]
        return _ensure_postgres_runtime_params(normalized)
    return _ensure_postgres_runtime_params(raw)


DATABASE_URL = _resolve_database_url()
if DATABASE_URL.startswith("sqlite") and _is_cloud_runtime():
    logger.warning(
        "DATABASE_URL resolved to SQLite in cloud runtime; data will not persist across redeploys. "
        "Set DATABASE_URL to your PostgreSQL endpoint."
    )

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
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
    attempts = int(os.getenv("DB_INIT_MAX_ATTEMPTS", "6" if _is_cloud_runtime() else "1"))
    delay_seconds = float(os.getenv("DB_INIT_RETRY_DELAY_SECONDS", "2"))

    for attempt in range(1, attempts + 1):
        try:
            Base.metadata.create_all(bind=engine)
            if attempt > 1:
                logger.info("Database initialization succeeded on retry %s/%s", attempt, attempts)
            return
        except Exception as exc:
            logger.error("Database initialization attempt %s/%s failed: %s", attempt, attempts, exc)
            if attempt == attempts:
                logger.critical(
                    "Database initialization failed after %s attempts. Verify DATABASE_URL, "
                    "RDS connectivity/security groups, and SSL requirements.",
                    attempts,
                )
                raise RuntimeError(
                    "Database initialization failed after retries. "
                    "Verify DATABASE_URL, RDS connectivity/security groups, and SSL requirements."
                ) from exc
            time.sleep(delay_seconds)


# Create tables
_initialize_database()

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
