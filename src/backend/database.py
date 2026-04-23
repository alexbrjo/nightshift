from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

DATABASE_URL = "sqlite+aiosqlite:///./data/nightshift.db"


async_engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
)

sync_engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
)


async_session_factory = sessionmaker(
    async_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class SessionManager:
    """Async context manager for database sessions."""

    def __init__(self):
        self.session = None

    async def __aenter__(self) -> AsyncSession:
        self.session = async_session_factory()
        return self.session

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.session:
            await self.session.close()


def get_session() -> SessionManager:
    """Get a database session context manager."""
    return SessionManager()


engine = sync_engine
