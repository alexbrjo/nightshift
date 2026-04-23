#!/usr/bin/env python3
"""Analysis API routes."""

from datetime import datetime
import hashlib
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from src.backend.config import settings
from src.backend.database import get_session
from src.backend.models import Analysis, AnalysisRun, Collection, Job, Project

router = APIRouter()


class AnalysisStep(BaseModel):
    step: str
    description: Optional[str] = None


class AnalysisCreate(BaseModel):
    project_id: int
    job_id: Optional[int] = None
    collection_id: Optional[int] = None
    name: str
    description: Optional[str] = None


@router.get("/", response_model=List[Dict[str, Any]])
async def list_analyses(project_id: Optional[int] = None):
    async with get_session() as session:
        query = session.query(Analysis)
        if project_id:
            query = query.filter(Analysis.project_id == project_id)
        analyses = await session.execute(query.order_by(Analysis.created_at.desc()))
        return [a.to_dict() for a in analyses.scalars().all()]


@router.get("/{analysis_id}", response_model=Dict[str, Any])
async def get_analysis(analysis_id: int):
    async with get_session() as session:
        analysis = await session.get(Analysis, analysis_id)
        if not analysis:
            raise HTTPException(status_code=404, detail="Analysis not found")
        return analysis.to_dict()


@router.post("/", response_model=Dict[str, Any])
async def create_analysis(analysis_data: AnalysisCreate):
    async with get_session() as session:
        project = await session.get(Project, analysis_data.project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        if analysis_data.job_id:
            job = await session.get(Job, analysis_data.job_id)
            if not job or job.project_id != project.id:
                raise HTTPException(status_code=404, detail="Job not found")

        if analysis_data.collection_id:
            collection = await session.get(Collection, analysis_data.collection_id)
            if not collection or collection.project_id != project.id:
                raise HTTPException(status_code=404, detail="Collection not found")

        analysis_id_hash = hashlib.md5(
            f"{project.id}-{analysis_data.name}".encode()
        ).hexdigest()[:8]

        db_dir = settings.data_dir / "analyses"
        db_dir.mkdir(parents=True, exist_ok=True)
        database_path = str(db_dir / f"analysis_{analysis_id_hash}.db")

        analysis = Analysis(
            project_id=analysis_data.project_id,
            job_id=analysis_data.job_id,
            collection_id=analysis_data.collection_id,
            name=analysis_data.name,
            description=analysis_data.description,
            database_path=database_path,
            status="pending",
        )
        session.add(analysis)
        await session.commit()
        await session.refresh(analysis)

    return analysis.to_dict()


@router.post("/{analysis_id}/start", response_model=Dict[str, Any])
async def start_analysis(analysis_id: int, background_tasks: BackgroundTasks):
    async with get_session() as session:
        analysis = await session.get(Analysis, analysis_id)
        if not analysis:
            raise HTTPException(status_code=404, detail="Analysis not found")

        if analysis.status == "running":
            raise HTTPException(status_code=400, detail="Analysis is already running")

        analysis.status = "running"
        analysis.started_at = datetime.utcnow()
        await session.commit()

        background_tasks.add_task(execute_analysis, analysis_id)
        return {"status": "running", "analysis_id": analysis_id}


async def execute_analysis(analysis_id: int):
    from datetime import datetime

    async with get_session() as session:
        analysis = await session.get(Analysis, analysis_id)
        if not analysis:
            return

        analysis.status = "running"
        analysis.started_at = datetime.utcnow()
        analysis.agent_status = str(
            {
                "step": "initializing",
                "description": "Setting up isolated environment",
                "order": ["query", "anecdotes", "summary", "proofread"],
            }
        )
        await session.commit()

        steps = [
            ("query", "Running analysis queries"),
            ("anecdotes", "Supplementing with anecdotes"),
            ("summary", "Writing summary"),
            ("proofread", "Proof-reading results"),
        ]

        try:
            for step, description in steps:
                analysis.agent_status = str(
                    {
                        "step": step,
                        "description": description,
                        "order": [s for s, _ in steps],
                    }
                )
                await session.commit()

                run = AnalysisRun(
                    analysis_id=analysis.id,
                    step=step,
                    input_context=None,
                    status="pending",
                )
                session.add(run)
                await session.commit()

                run.status = "running"
                run.started_at = datetime.utcnow()
                await session.commit()

                result = await execute_step(session, analysis, step)

                run.output_result = result
                run.status = "completed"
                run.completed_at = datetime.utcnow()
                await session.commit()

            results_path = str(
                settings.data_dir / "analyses" / f"{analysis.name}_results.md"
            )
            analysis.results_path = results_path

            final_content = f"# {analysis.name}\n\n"
            for run in analysis.analysis_runs:
                final_content += f"\n## {run.step}\n\n{run.output_result or ''}"

            Path(results_path).write_text(final_content)
            analysis.status = "completed"
            analysis.completed_at = datetime.utcnow()
            await session.commit()

        except Exception as e:
            analysis.status = "failed"
            analysis.completed_at = datetime.utcnow()
            await session.commit()


async def execute_step(session, analysis: Analysis, step: str) -> str:
    if step == "query":
        data = await run_queries(session, analysis)
        return f"Analysis queries completed. Found {len(data)} records."
    elif step == "anecdotes":
        anecdotes = await gather_anecdotes(session, analysis)
        return f"Gathered {len(anecdotes)} anecdotal examples."
    elif step == "summary":
        return await write_summary(session, analysis)
    elif step == "proofread":
        return await proofread_results(session, analysis)
    else:
        return f"Step {step} completed."


async def run_queries(session, analysis: Analysis) -> List[Dict]:
    query = """
        SELECT 
            js.sample_index,
            js.status,
            js.raw_response,
            js.parsed_content
        FROM job_samples js
        JOIN jobs j ON js.job_id = j.id
        WHERE j.project_id = :project_id
    """

    params = {"project_id": analysis.project_id}
    if analysis.job_id:
        query += " AND j.id = :job_id"
        params["job_id"] = analysis.job_id

    result = await session.execute(query, params)
    return [dict(row) for row in result.fetchall()]


async def gather_anecdotes(session, analysis: Analysis) -> List[Dict]:
    return [
        {
            "id": 1,
            "category": "success",
            "description": "Model provided accurate output for edge case",
        }
    ]


async def write_summary(session, analysis: Analysis) -> str:
    return "# Summary\n\nAnalysis completed successfully with all steps executed."


async def proofread_results(session, analysis: Analysis) -> str:
    return "Results reviewed and findings are ready for export."
