#!/usr/bin/env python3
"""Pipeline API routes."""

from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from src.backend.database import get_session
from src.backend.models import Pipeline, PipelineStage, Project

router = APIRouter()


class PipelineStageCreate(BaseModel):
    name: str
    description: Optional[str] = None
    order: int = 0
    config: Dict = {}
    input_schema: Optional[Dict] = None
    output_schema: Optional[Dict] = None


class PipelineCreate(BaseModel):
    project_id: int
    name: str
    description: Optional[str] = None
    definition_yaml: str


class PipelineUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    definition_yaml: Optional[str] = None


@router.get("/", response_model=List[Dict[str, Any]])
async def list_pipelines(project_id: Optional[int] = None):
    async with get_session() as session:
        stmt = select(Pipeline)
        if project_id:
            stmt = stmt.where(Pipeline.project_id == project_id)
        stmt = stmt.order_by(Pipeline.created_at.desc())
        result = await session.execute(stmt)
        return [p.to_dict() for p in result.scalars().all()]


@router.get("/{pipeline_id}", response_model=Dict[str, Any])
async def get_pipeline(pipeline_id: int):
    async with get_session() as session:
        stmt = select(Pipeline).where(Pipeline.id == pipeline_id)
        result = await session.execute(stmt)
        pipeline = result.scalar_one_or_none()
        if not pipeline:
            raise HTTPException(status_code=404, detail="Pipeline not found")
        return pipeline.to_dict()


@router.post("/", response_model=Dict[str, Any])
async def create_pipeline(pipeline_data: PipelineCreate):
    async with get_session() as session:
        stmt = select(Project).where(Project.id == pipeline_data.project_id)
        result = await session.execute(stmt)
        project = result.scalar_one_or_none()
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        pipeline = Pipeline(
            project_id=pipeline_data.project_id,
            name=pipeline_data.name,
            description=pipeline_data.description,
            definition_yaml=pipeline_data.definition_yaml or "{}",
            status="draft",
        )
        session.add(pipeline)
        await session.commit()
        await session.refresh(pipeline)

    return pipeline.to_dict()


@router.patch("/{pipeline_id}", response_model=Dict[str, Any])
async def update_pipeline(pipeline_id: int, pipeline_data: PipelineUpdate):
    async with get_session() as session:
        stmt = select(Pipeline).where(Pipeline.id == pipeline_id)
        result = await session.execute(stmt)
        pipeline = result.scalar_one_or_none()
        if not pipeline:
            raise HTTPException(status_code=404, detail="Pipeline not found")

        update_data = pipeline_data.model_dump(exclude_unset=True)
        for field, value in update_data.items():
            setattr(pipeline, field, value)

        await session.commit()
        await session.refresh(pipeline)
        return pipeline.to_dict()


@router.delete("/{pipeline_id}")
async def delete_pipeline(pipeline_id: int):
    async with get_session() as session:
        stmt = select(Pipeline).where(Pipeline.id == pipeline_id)
        result = await session.execute(stmt)
        pipeline = result.scalar_one_or_none()
        if not pipeline:
            raise HTTPException(status_code=404, detail="Pipeline not found")

        await session.delete(pipeline)
        await session.commit()
        return {"deleted": True}


@router.post("/{pipeline_id}/stages", response_model=Dict[str, Any])
async def create_stage(pipeline_id: int, stage_data: PipelineStageCreate):
    async with get_session() as session:
        stmt = select(Pipeline).where(Pipeline.id == pipeline_id)
        result = await session.execute(stmt)
        pipeline = result.scalar_one_or_none()
        if not pipeline:
            raise HTTPException(status_code=404, detail="Pipeline not found")

        stage = PipelineStage(
            pipeline_id=pipeline_id,
            name=stage_data.name,
            description=stage_data.description,
            order=stage_data.order,
            config=str(stage_data.config),
            input_schema=str(stage_data.input_schema) if stage_data.input_schema else None,
            output_schema=str(stage_data.output_schema) if stage_data.output_schema else None,
        )
        session.add(stage)
        await session.commit()
        await session.refresh(stage)
        return stage.to_dict()


@router.get("/{pipeline_id}/stages", response_model=List[Dict[str, Any]])
async def list_stages(pipeline_id: int):
    async with get_session() as session:
        stmt = select(PipelineStage).where(
            PipelineStage.pipeline_id == pipeline_id
        ).order_by(PipelineStage.order)
        result = await session.execute(stmt)
        return [s.to_dict() for s in result.scalars().all()]


@router.post("/{pipeline_id}/run", response_model=Dict[str, Any])
async def run_pipeline(pipeline_id: int, background_tasks: BackgroundTasks):
    async with get_session() as session:
        stmt = select(Pipeline).where(Pipeline.id == pipeline_id)
        result = await session.execute(stmt)
        pipeline = result.scalar_one_or_none()
        if not pipeline:
            raise HTTPException(status_code=404, detail="Pipeline not found")

        if pipeline.status == "running":
            raise HTTPException(status_code=400, detail="Pipeline is already running")

        pipeline.status = "running"
        pipeline.started_at = datetime.utcnow()
        await session.commit()

        background_tasks.add_task(execute_pipeline, pipeline_id)
        return {"status": "running", "pipeline_id": pipeline_id}


async def execute_pipeline(pipeline_id: int):
    from datetime import datetime

    async with get_session() as session:
        stmt = select(Pipeline).where(Pipeline.id == pipeline_id)
        result = await session.execute(stmt)
        pipeline = result.scalar_one_or_none()
        if not pipeline:
            return

        pipeline.status = "running"
        pipeline.started_at = datetime.utcnow()
        await session.commit()

        try:
            input_data = []
            for stage in pipeline.stages:
                try:
                    output = await run_stage(session, stage, input_data)
                    input_data = output
                except Exception as e:
                    run = PipelineStageRun(
                        pipeline_id=pipeline.id,
                        stage_id=stage.id,
                        status="error",
                        error_message=str(e),
                    )
                    session.add(run)
                    await session.commit()
                    raise e

            pipeline.status = "completed"
            pipeline.completed_at = datetime.utcnow()
            await session.commit()

        except Exception as e:
            pipeline.status = "failed"
            pipeline.completed_at = datetime.utcnow()
            await session.commit()


async def run_stage(session, stage: PipelineStage, input_data: List[Dict]) -> Dict:
    from datetime import datetime

    stage_run = PipelineStageRun(
        pipeline_id=stage.pipeline_id,
        stage_id=stage.id,
        input_data={"input": str(input_data)} if input_data else None,
        status="pending",
    )
    session.add(stage_run)
    await session.commit()

    try:
        stage_run.status = "running"
        stage_run.started_at = datetime.utcnow()
        await session.commit()

        result = execute_stage_config(eval(stage.config) if stage.config else {}, input_data)

        stage_run.output_data = {"output": str(result)}
        stage_run.status = "completed"
        stage_run.completed_at = datetime.utcnow()
        await session.commit()

        return result

    except Exception as e:
        stage_run.output_data = None
        stage_run.status = "error"
        stage_run.error_message = str(e)
        stage_run.completed_at = datetime.utcnow()
        await session.commit()
        raise e


def execute_stage_config(config: Dict, input_data: List[Dict]) -> Dict:
    if config.get("type") == "inference":
        return {"type": "inference", "input": input_data}
    elif config.get("type") == "javascript":
        return {"type": "javascript", "input": input_data}
    elif config.get("type") == "collection":
        return {"type": "collection", "input": input_data}
    else:
        return {"type": "pass-through", "input": input_data}


@router.post("/{pipeline_id}/trial-run", response_model=Dict[str, Any])
async def run_pipeline_trial(pipeline_id: int, background_tasks: BackgroundTasks):
    async with get_session() as session:
        stmt = select(Pipeline).where(Pipeline.id == pipeline_id)
        result = await session.execute(stmt)
        pipeline = result.scalar_one_or_none()
        if not pipeline:
            raise HTTPException(status_code=404, detail="Pipeline not found")

        if pipeline.status == "running":
            raise HTTPException(status_code=400, detail="Pipeline is already running")

        pipeline.status = "running"
        pipeline.is_trial = True
        pipeline.started_at = datetime.utcnow()
        await session.commit()

        background_tasks.add_task(execute_pipeline_trial, pipeline_id)
        return {"status": "running", "pipeline_id": pipeline_id}


async def execute_pipeline_trial(pipeline_id: int):
    from datetime import datetime

    async with get_session() as session:
        stmt = select(Pipeline).where(Pipeline.id == pipeline_id)
        result = await session.execute(stmt)
        pipeline = result.scalar_one_or_none()
        if not pipeline:
            return

        pipeline.status = "running"
        pipeline.is_trial = True
        pipeline.started_at = datetime.utcnow()
        await session.commit()

        try:
            for stage in pipeline.stages[:3]:
                input_data = [{"sample": 1}, {"sample": 2}]
                output = await run_stage(session, stage, input_data)
                if not output:
                    break

            pipeline.status = "completed"
            pipeline.completed_at = datetime.utcnow()
            await session.commit()

        except Exception as e:
            pipeline.status = "failed"
            pipeline.completed_at = datetime.utcnow()
            await session.commit()
