#!/usr/bin/env python3
"""Configuration management for Nightshift."""

from pathlib import Path
from typing import List, Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    host: str = "127.0.0.1"
    port: int = 8000
    debug: bool = False

    database_url: str = Field(
        default="sqlite+aiosqlite:///./data/nightshift.db",
        description="Database connection URL",
    )

    data_dir: Path = Field(
        default=Path("./data"),
        description="Directory for application data",
    )

    projects_dir: Path = Field(
        default=Path("./projects"),
        description="Directory for project files",
    )

    cors_origins: List[str] = Field(
        default=["http://localhost:5173", "http://127.0.0.1:5173"],
        description="Allowed CORS origins",
    )

    openai_api_key: Optional[str] = Field(
        default=None,
        description="OpenAI API key (optional, can be set per provider)",
    )

    def __init__(self, **values):
        super().__init__(**values)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.projects_dir.mkdir(parents=True, exist_ok=True)


settings = Settings()
