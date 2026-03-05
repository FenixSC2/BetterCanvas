# backend/auth.py
"""
User authentication, token storage, and encryption utilities.
"""

import os
import bcrypt
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import Column, Integer, String, DateTime, create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from cryptography.fernet import Fernet
from pydantic import BaseModel, EmailStr

# Database setup
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./canvas_better.db")
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Encryption key for token storage
TOKEN_ENCRYPTION_KEY = os.getenv("TOKEN_ENCRYPTION_KEY")
if not TOKEN_ENCRYPTION_KEY:
    # Generate a new key if not set
    TOKEN_ENCRYPTION_KEY = Fernet.generate_key().decode()
    print(f"Generated new TOKEN_ENCRYPTION_KEY. Set this in your .env:\nTOKEN_ENCRYPTION_KEY={TOKEN_ENCRYPTION_KEY}")

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

# === Pydantic schemas ===
class UserCreate(BaseModel):
    email: EmailStr
    password: str

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
