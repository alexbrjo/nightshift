#!/usr/bin/env python3
"""Job API routes."""

from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from src.backend.database import get_session
from src.backend.models import Job, JobSample, Project

router = APIRouter()


class JobCreate(BaseModel):
    project_id: int
    name: str
    description: Optional[str] = None
    template_path: str
    input_files: Optional[List[str]] = None
    sampling_strategy: str = "single"
    output_schema: Optional[Dict] = None
    config: Dict = {}


class JobUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    sampling_strategy: Optional[str] = None
    output_schema: Optional[Dict] = None
    config: Optional[Dict] = None


@router.get("/", response_model=List[Dict[str, Any]])
async def list_jobs(project_id: Optional[int] = None):
    async with get_session() as session:
        query = session.query(Job)
        if project_id:
            query = query.filter(Job.project_id == project_id)
        jobs = await session.execute(query.order_by(Job.created_at.desc()))
        return [job.to_dict() for job in jobs.scalars().all()]


@router.get("/{job_id}", response_model=Dict[str, Any])
async def get_job(job_id: int):
    async with get_session() as session:
        job = await session.get(Job, job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        return job.to_dict()


@router.post("/", response_model=Dict[str, Any])
async def create_job(job_data: JobCreate):
    async with get_session() as session:
        project = await session.get(Project, job_data.project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        job = Job(
            project_id=job_data.project_id,
            name=job_data.name,
            description=job_data.description,
            template_path=job_data.template_path,
            input_files=str(job_data.input_files or []),
            sampling_strategy=job_data.sampling_strategy,
            output_schema=str(job_data.output_schema or {}),
            config=str(job_data.config),
        )
        session.add(job)
        await session.commit()
        await session.refresh(job)
        return job.to_dict()


@router.patch("/{job_id}", response_model=Dict[str, Any])
async def update_job(job_id: int, job_data: JobUpdate):
    async with get_session() as session:
        job = await session.get(Job, job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")

        update_data = job_data.model_dump(exclude_unset=True)
        for field, value in update_data.items():
            if field == "config" or field == "output_schema" or field == "input_files":
                setattr(job, field, str(value))
            else:
                setattr(job, field, value)

        await session.commit()
        await session.refresh(job)
        return job.to_dict()


@router.delete("/{job_id}")
async def delete_job(job_id: int):
    async with get_session() as session:
        job = await session.get(Job, job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")

        await session.delete(job)
        await session.commit()
        return {"deleted": True}


@router.get("/{job_id}/samples", response_model=List[Dict[str, Any]])
async def list_job_samples(job_id: int, skip: int = 0, limit: int = 100):
    async with get_session() as session:
        job = await session.get(Job, job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")

        samples = await session.execute(
            JobSample.query.filter(JobSample.job_id == job_id)
            .offset(skip)
            .limit(limit)
        )
        return [s.to_dict() for s in samples.scalars().all()]


@router.post("/{job_id}/run", response_model=Dict[str, Any])
async def run_job(job_id: int, background_tasks: BackgroundTasks):
    async with get_session() as session:
        job = await session.get(Job, job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")

        if job.status == "running":
            raise HTTPException(status_code=400, detail="Job is already running")

        job.status = "running"
        job.started_at = datetime.utcnow()
        await session.commit()

        background_tasks.add_task(execute_job, job_id)
        return {"status": "running", "job_id": job_id}


async def execute_job(job_id: int):
    from asyncio import Semaphore
    from datetime import datetime

    async with get_session() as session:
        job = await session.get(Job, job_id)
        if not job:
            return

        job.status = "running"
        job.started_at = datetime.utcnow()
        await session.commit()

        try:
            if job.sampling_strategy == "single":
                samples_to_process = 1
            elif job.sampling_strategy == "random":
                samples_to_process = min(job.total_samples or 10, 10)
            elif job.sampling_strategy == "exhaustive":
                samples_to_process = job.total_samples or 1
            else:
                samples_to_process = job.total_samples or 1

            semaphore = Semaphore(5)

            for i in range(samples_to_process):
                sample = JobSample(
                    job_id=job.id,
                    sample_index=i,
                    status="pending",
                )
                session.add(sample)

            await session.commit()

            for sample in job.samples:
                try:
                    async with semaphore:
                        await process_sample(session, job, sample)
                except Exception as e:
                    sample.status = "error"
                    sample.error_message = str(e)
                    sample.completed_at = datetime.utcnow()
                    job.failed_samples += 1

            if job.failed_samples == 0:
                job.status = "completed"
                job.completed_at = datetime.utcnow()
            else:
                job.status = "partial"

            await session.commit()

        except Exception as e:
            job.status = "failed"
            job.completed_at = datetime.utcnow()
            await session.commit()


async def process_sample(session, job: Job, sample: JobSample):
    from datetime import datetime

    sample.status = "running"
    sample.started_at = datetime.utcnow()
    await session.commit()

    try:
        rendered_prompt = render_template(job.template_path, sample.input_data)

        response = await call_llm(
            rendered_prompt,
            job.config.get("provider", "openai"),
            job.config.get("model", "gpt-4o-mini"),
            **job.config,
        )

        sample.raw_response = response["raw"]
        sample.parsed_content = str(response.get("parsed"))
        sample.prompt_tokens = response.get("usage", {}).get("prompt_tokens")
        sample.completion_tokens = response.get("usage", {}).get("completion_tokens")
        sample.total_tokens = response.get("usage", {}).get("total_tokens")
        sample.latency_ms = response.get("latency_ms")

        if job.output_schema:
            validation_errors = validate_json(
                sample.parsed_content, eval(job.output_schema)
            )
            sample.validation_errors = str(validation_errors)

        sample.status = "completed"
        sample.completed_at = datetime.utcnow()
        await session.commit()

    except Exception as e:
        sample.status = "error"
        sample.error_message = str(e)
        sample.completed_at = datetime.utcnow()
        await session.commit()


def render_template(template_path: str, input_data: Optional[Dict] = None) -> str:
    from jinja2 import Environment, FileSystemLoader

    env = Environment(loader=FileSystemLoader(Path(template_path).parent))
    template = env.get_template(Path(template_path).name)

    if input_data:
        return template.render(**input_data)
    return template.render()


async def call_llm(
    prompt: str,
    provider: str = "openai",
    model: str = "gpt-4o-mini",
    temperature: float = 0.7,
    max_tokens: Optional[int] = None,
) -> Dict:
    from datetime import datetime

    start_time = datetime.utcnow()

    if provider == "openai":
        from openai import AsyncOpenAI

        client = AsyncOpenAI()
        response = await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=temperature,
        )

        latency_ms = int((datetime.utcnow() - start_time).total_seconds() * 1000)

        return {
            "raw": response.choices[0].message.content,
            "parsed": None,
            "usage": {
                "prompt_tokens": response.usage.prompt_tokens,
                "completion_tokens": response.usage.completion_tokens,
                "total_tokens": response.usage.total_tokens,
            },
            "latency_ms": latency_ms,
        }

    raise ValueError(f"Unsupported provider: {provider}")


def validate_json(data: Dict, schema: Dict) -> List[str]:
    from jsonschema import Draft7Validator

    try:
        validator = Draft7Validator(schema)
        errors = list(validator.iter_errors(data))
        return [str(err) for err in errors]
    except Exception:
        return []


@router.get("/{job_id}/samples/{sample_id}", response_model=Dict[str, Any])
async def get_sample(job_id: int, sample_id: int):
    async with get_session() as session:
        sample = await session.get(JobSample, sample_id)
        if not sample or sample.job_id != job_id:
            raise HTTPException(status_code=404, detail="Sample not found")
        return sample.to_dict()
