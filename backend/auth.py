# backend/auth.py
"""
User authentication, token storage, and encryption utilities.
"""

import os
import bcrypt
from datetime import datetime, timezone
from typing import Optional
from pathlib import Path
from sqlalchemy import Column, Integer, String, DateTime, Float, Boolean, create_engine, UniqueConstraint
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from cryptography.fernet import Fernet
from pydantic import BaseModel, EmailStr, field_validator

# Database setup
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./canvas_better.db")
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def _load_or_create_token_encryption_key() -> str:
    """Load token encryption key from env or a local persistent file."""
    env_key = os.getenv("TOKEN_ENCRYPTION_KEY")
    if env_key:
        return env_key

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

class UserSession(Base):
    __tablename__ = "user_sessions"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, unique=True, index=True)
    user_id = Column(Integer, index=True)
    expires_at = Column(DateTime)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

# Create tables
Base.metadata.create_all(bind=engine)

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

def create_db_session(user_id: int, session_id: str, expires_at: datetime, db: Session) -> "UserSession":
    """Persist a new session to the database."""
    db_session = UserSession(session_id=session_id, user_id=user_id, expires_at=expires_at)
    db.add(db_session)
    db.commit()
    return db_session

def get_db_session_user_id(session_id: str, db: Session) -> Optional[int]:
    """Return user_id for a valid, non-expired session, or None."""
    now = datetime.now(timezone.utc)
    db_session = db.query(UserSession).filter(
        UserSession.session_id == session_id,
        UserSession.expires_at > now
    ).first()
    if not db_session:
        return None
    return db_session.user_id

def invalidate_db_session(session_id: str, db: Session) -> None:
    """Delete a session from the database."""
    db.query(UserSession).filter(UserSession.session_id == session_id).delete()
    db.commit()

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

class CanvasTokenStatus(BaseModel):
    has_token: bool
    updated_at: Optional[datetime] = None

import logging
logger = logging.getLogger("canvas_backend")
