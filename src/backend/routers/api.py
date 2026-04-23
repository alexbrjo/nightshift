#!/usr/bin/env python3
"""API routes for Nightshift."""

from fastapi import APIRouter

router = APIRouter()

from src.backend.routers.jobs import router as jobs_router
from src.backend.routers.collections import router as collections_router
from src.backend.routers.pipelines import router as pipelines_router
from src.backend.routers.analyses import router as analyses_router
from src.backend.routers.projects import router as projects_router

router.include_router(projects_router, prefix="/projects", tags=["projects"])
router.include_router(jobs_router, prefix="/jobs", tags=["jobs"])
router.include_router(collections_router, prefix="/collections", tags=["collections"])
router.include_router(pipelines_router, prefix="/pipelines", tags=["pipelines"])
router.include_router(analyses_router, prefix="/analyses", tags=["analyses"])


@router.get("/health")
async def health_check():
    return {"status": "ok"}
