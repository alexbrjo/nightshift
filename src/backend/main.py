#!/usr/bin/env python3
"""Main entry point for Nightshift backend."""

import asyncio
import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from src.backend.config import settings
from src.backend.database import engine, get_session
from src.backend.routers import api_router, views_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="Nightshift",
        description="A desktop-first experimentation platform for evaluating LLM-generated context",
        version="0.1.0",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(views_router)
    app.include_router(api_router, prefix="/api")

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
        )

    @app.on_event("startup")
    async def startup():
        logger.info("Starting Nightshift application...")
        logger.info(f"Database URL: {settings.database_url}")
        logger.info(f"CORS origins: {settings.cors_origins}")

    @app.on_event("shutdown")
    async def shutdown():
        logger.info("Shutting down Nightshift application...")
        await engine.dispose()

    return app


app = create_app()


def main():
    """Run the application."""
    import uvicorn

    host = settings.host
    port = settings.port

    logger.info(f"Starting server on {host}:{port}")
    uvicorn.run(
        "src.backend.main:app",
        host=host,
        port=port,
        reload=settings.debug,
    )


if __name__ == "__main__":
    main()
