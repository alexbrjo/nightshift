#!/usr/bin/env python3
"""View routes for Nightshift."""

from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, RedirectResponse

router = APIRouter()

STATIC_DIR = Path(__file__).parent.parent / "static"


@router.get("/")
async def root(request: Request):
    return RedirectResponse(url="/projects")


@router.get("/projects")
async def projects(request: Request):
    return FileResponse(STATIC_DIR / "index.html")


@router.get("/projects/{project_id}")
async def project_view(request: Request, project_id: str):
    return FileResponse(STATIC_DIR / "index.html")


@router.get("/jobs/{job_id}")
async def job_view(request: Request, job_id: str):
    return FileResponse(STATIC_DIR / "index.html")


@router.get("/collections/{collection_id}")
async def collection_view(request: Request, collection_id: str):
    return FileResponse(STATIC_DIR / "index.html")


@router.get("/pipelines/{pipeline_id}")
async def pipeline_view(request: Request, pipeline_id: str):
    return FileResponse(STATIC_DIR / "index.html")


@router.get("/analyses/{analysis_id}")
async def analysis_view(request: Request, analysis_id: str):
    return FileResponse(STATIC_DIR / "index.html")
