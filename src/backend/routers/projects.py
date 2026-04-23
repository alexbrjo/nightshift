#!/usr/bin/env python3
"""Project API routes."""

from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from src.backend.config import settings
from src.backend.database import get_session
from src.backend.models import Project

router = APIRouter()


class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None
    path: str


@router.get("/", response_model=List[Dict[str, Any]])
async def list_projects():
    async with get_session() as session:
        stmt = select(Project).order_by(Project.created_at.desc())
        result = await session.execute(stmt)
        return [p.to_dict() for p in result.scalars().all()]


@router.get("/{project_id}", response_model=Dict[str, Any])
async def get_project(project_id: int):
    async with get_session() as session:
        stmt = select(Project).where(Project.id == project_id)
        result = await session.execute(stmt)
        project = result.scalar_one_or_none()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        return project.to_dict()


@router.post("/", response_model=Dict[str, Any])
async def create_project(project_data: ProjectCreate):
    async with get_session() as session:
        path = Path(project_data.path)
        if not path.exists():
            raise HTTPException(status_code=400, detail="Path does not exist")

        stmt = select(Project).where(Project.path == project_data.path)
        result = await session.execute(stmt)
        existing = result.scalar_one_or_none()
        if existing:
            raise HTTPException(status_code=400, detail="Project already exists at this path")

        project = Project(
            name=project_data.name,
            description=project_data.description,
            path=str(path.resolve()),
        )
        session.add(project)
        await session.commit()
        await session.refresh(project)
        return project.to_dict()


@router.patch("/{project_id}", response_model=Dict[str, Any])
async def update_project(project_id: int, project_data: ProjectCreate):
    async with get_session() as session:
        stmt = select(Project).where(Project.id == project_id)
        result = await session.execute(stmt)
        project = result.scalar_one_or_none()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        if project_data.path and project_data.path != project.path:
            path = Path(project_data.path)
            if not path.exists():
                raise HTTPException(status_code=400, detail="Path does not exist")
            project.path = str(path.resolve())

        if project_data.name:
            project.name = project_data.name
        if project_data.description is not None:
            project.description = project_data.description

        await session.commit()
        await session.refresh(project)
        return project.to_dict()


@router.delete("/{project_id}")
async def delete_project(project_id: int):
    async with get_session() as session:
        stmt = select(Project).where(Project.id == project_id)
        result = await session.execute(stmt)
        project = result.scalar_one_or_none()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        await session.delete(project)
        await session.commit()
        return {"deleted": True}


@router.get("/{project_id}/files")
async def list_project_files(project_id: int, pattern: str = "*"):
    async with get_session() as session:
        stmt = select(Project).where(Project.id == project_id)
        result = await session.execute(stmt)
        project = result.scalar_one_or_none()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

    path = Path(project.path)
    if pattern == "*":
        files = list(path.rglob("*"))
    else:
        files = list(path.rglob(pattern))

    return [
        {
            "path": str(f),
            "name": f.name,
            "type": "directory" if f.is_dir() else "file",
            "size": f.stat().st_size if f.is_file() else None,
        }
        for f in files[:100]
    ]


@router.get("/{project_id}/stats")
async def get_project_stats(project_id: int):
    async with get_session() as session:
        stmt = select(Project).where(Project.id == project_id)
        result = await session.execute(stmt)
        project = result.scalar_one_or_none()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

    path = Path(project.path)

    total_files = 0
    total_size = 0

    for f in path.rglob("*"):
        if f.is_file():
            total_files += 1
            try:
                total_size += f.stat().st_size
            except OSError:
                pass

    return {
        "total_files": total_files,
        "total_size": total_size,
        "path": project.path,
    }
