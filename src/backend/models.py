#!/usr/bin/env python3
"""SQLAlchemy models for Nightshift."""

from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    """Base class for all models."""

    pass


class Project(Base):
    """A project representing a directory being worked on."""

    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    path: Mapped[str] = mapped_column(String(1024), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    jobs: Mapped[List["Job"]] = relationship(
        "Job", back_populates="project", cascade="all, delete-orphan"
    )
    collections: Mapped[List["Collection"]] = relationship(
        "Collection", back_populates="project", cascade="all, delete-orphan"
    )
    pipelines: Mapped[List["Pipeline"]] = relationship(
        "Pipeline", back_populates="project", cascade="all, delete-orphan"
    )
    analyses: Mapped[List["Analysis"]] = relationship(
        "Analysis", back_populates="project", cascade="all, delete-orphan"
    )

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "path": self.path,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class Job(Base):
    """A job representing an inference or processing task."""

    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("projects.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    template_path: Mapped[str] = mapped_column(String(1024))
    input_files: Mapped[Optional[List[str]]] = mapped_column(Text, nullable=True)
    sampling_strategy: Mapped[str] = mapped_column(String(50))
    output_schema: Mapped[Optional[Dict]] = mapped_column(Text, nullable=True)
    config: Mapped[Dict] = mapped_column(Text, default="{}")

    status: Mapped[str] = mapped_column(String(50), index=True, default="pending")
    total_samples: Mapped[int] = mapped_column(Integer, default=0)
    completed_samples: Mapped[int] = mapped_column(Integer, default=0)
    failed_samples: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )

    project: Mapped["Project"] = relationship("Project", back_populates="jobs")
    samples: Mapped[List["JobSample"]] = relationship(
        "JobSample", back_populates="job", cascade="all, delete-orphan"
    )
    collection: Mapped[Optional["Collection"]] = relationship(
        "Collection", back_populates="source_job"
    )

    def to_dict(self):
        return {
            "id": self.id,
            "project_id": self.project_id,
            "name": self.name,
            "description": self.description,
            "template_path": self.template_path,
            "input_files": eval(self.input_files) if self.input_files else None,
            "sampling_strategy": self.sampling_strategy,
            "output_schema": eval(self.output_schema) if self.output_schema else None,
            "config": eval(self.config) if self.config else {},
            "status": self.status,
            "total_samples": self.total_samples,
            "completed_samples": self.completed_samples,
            "failed_samples": self.failed_samples,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }


class JobSample(Base):
    """A single sample within a job."""

    __tablename__ = "job_samples"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("jobs.id", ondelete="CASCADE")
    )
    sample_index: Mapped[int] = mapped_column(Integer)
    input_data: Mapped[Optional[Dict]] = mapped_column(Text, nullable=True)
    rendered_prompt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    raw_response: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    parsed_content: Mapped[Optional[Dict]] = mapped_column(Text, nullable=True)
    validation_errors: Mapped[Optional[List[str]]] = mapped_column(
        Text, nullable=True
    )

    provider: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    model: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    prompt_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    completion_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    total_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    latency_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    status: Mapped[str] = mapped_column(String(50), index=True, default="pending")
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )

    job: Mapped["Job"] = relationship("Job", back_populates="samples")

    def to_dict(self):
        return {
            "id": self.id,
            "job_id": self.job_id,
            "sample_index": self.sample_index,
            "input_data": eval(self.input_data) if self.input_data else None,
            "rendered_prompt": self.rendered_prompt,
            "raw_response": self.raw_response,
            "parsed_content": eval(self.parsed_content) if self.parsed_content else None,
            "validation_errors": eval(self.validation_errors) if self.validation_errors else None,
            "provider": self.provider,
            "model": self.model,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
            "latency_ms": self.latency_ms,
            "status": self.status,
            "error_message": self.error_message,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }


class Collection(Base):
    """A collection of job output samples."""

    __tablename__ = "collections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("projects.id", ondelete="CASCADE")
    )
    job_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    schema_definition: Mapped[Dict] = mapped_column(Text, default="{}")
    data: Mapped[List[Dict]] = mapped_column(Text, default="[]")

    total_items: Mapped[int] = mapped_column(Integer, default=0)
    current_page: Mapped[int] = mapped_column(Integer, default=1)
    items_per_page: Mapped[int] = mapped_column(Integer, default=50)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    project: Mapped["Project"] = relationship("Project", back_populates="collections")
    source_job: Mapped[Optional["Job"]] = relationship(
        "Job", back_populates="collection"
    )
    analysis: Mapped[Optional["Analysis"]] = relationship(
        "Analysis", back_populates="collection"
    )

    def to_dict(self):
        return {
            "id": self.id,
            "project_id": self.project_id,
            "job_id": self.job_id,
            "name": self.name,
            "description": self.description,
            "schema_definition": eval(self.schema_definition) if self.schema_definition else {},
            "data": eval(self.data) if self.data else [],
            "total_items": self.total_items,
            "current_page": self.current_page,
            "items_per_page": self.items_per_page,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class PipelineStage(Base):
    """A stage in an experiment pipeline."""

    __tablename__ = "pipeline_stages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pipeline_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("pipelines.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    order: Mapped[int] = mapped_column(Integer, default=0)

    config: Mapped[Dict] = mapped_column(Text, default="{}")
    input_schema: Mapped[Optional[Dict]] = mapped_column(Text, nullable=True)
    output_schema: Mapped[Optional[Dict]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    pipeline: Mapped["Pipeline"] = relationship(
        "Pipeline", back_populates="stages"
    )
    stage_runs: Mapped[List["PipelineStageRun"]] = relationship(
        "PipelineStageRun", back_populates="stage", cascade="all, delete-orphan"
    )

    def to_dict(self):
        return {
            "id": self.id,
            "pipeline_id": self.pipeline_id,
            "name": self.name,
            "description": self.description,
            "order": self.order,
            "config": eval(self.config) if self.config else {},
            "input_schema": eval(self.input_schema) if self.input_schema else None,
            "output_schema": eval(self.output_schema) if self.output_schema else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class Pipeline(Base):
    """An experiment pipeline with multiple stages."""

    __tablename__ = "pipelines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("projects.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    definition_yaml: Mapped[str] = mapped_column(Text)

    status: Mapped[str] = mapped_column(String(50), default="draft")
    is_trial: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )

    project: Mapped["Project"] = relationship("Project", back_populates="pipelines")
    stages: Mapped[List["PipelineStage"]] = relationship(
        "PipelineStage", back_populates="pipeline", cascade="all, delete-orphan"
    )
    stage_runs: Mapped[List["PipelineStageRun"]] = relationship(
        "PipelineStageRun", back_populates="pipeline", cascade="all, delete-orphan"
    )

    def to_dict(self):
        return {
            "id": self.id,
            "project_id": self.project_id,
            "name": self.name,
            "description": self.description,
            "definition_yaml": self.definition_yaml or "{}",
            "status": self.status,
            "is_trial": self.is_trial,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }


class PipelineStageRun(Base):
    """A run of a pipeline stage."""

    __tablename__ = "pipeline_stage_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pipeline_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("pipelines.id", ondelete="CASCADE")
    )
    stage_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("pipeline_stages.id", ondelete="SET NULL"), nullable=True
    )
    job_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True
    )

    input_data: Mapped[Optional[Dict]] = mapped_column(Text, nullable=True)
    output_data: Mapped[Optional[Dict]] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="pending")
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )

    pipeline: Mapped["Pipeline"] = relationship("Pipeline", back_populates="stage_runs")
    stage: Mapped[Optional["PipelineStage"]] = relationship(
        "PipelineStage", back_populates="stage_runs"
    )

    def to_dict(self):
        return {
            "id": self.id,
            "pipeline_id": self.pipeline_id,
            "stage_id": self.stage_id,
            "job_id": self.job_id,
            "input_data": eval(self.input_data) if self.input_data else None,
            "output_data": eval(self.output_data) if self.output_data else None,
            "status": self.status,
            "error_message": self.error_message,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }


class Analysis(Base):
    """An analysis run for an experiment."""

    __tablename__ = "analyses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("projects.id", ondelete="CASCADE")
    )
    job_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True
    )
    collection_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("collections.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    status: Mapped[str] = mapped_column(String(50), default="pending")
    agent_status: Mapped[Dict] = mapped_column(Text, default="{}")

    database_path: Mapped[str] = mapped_column(String(1024))
    results_path: Mapped[Optional[str]] = mapped_column(
        String(1024), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    started_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )

    project: Mapped["Project"] = relationship("Project", back_populates="analyses")
    job: Mapped[Optional["Job"]] = relationship("Job", back_populates="analysis")
    analysis_runs: Mapped[List["AnalysisRun"]] = relationship(
        "AnalysisRun", back_populates="analysis", cascade="all, delete-orphan"
    )

    def to_dict(self):
        return {
            "id": self.id,
            "project_id": self.project_id,
            "job_id": self.job_id,
            "collection_id": None,
            "name": self.name,
            "description": self.description,
            "status": self.status,
            "agent_status": eval(self.agent_status) if self.agent_status else {},
            "database_path": self.database_path,
            "results_path": self.results_path,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }


class AnalysisRun(Base):
    """A run of an analysis agent."""

    __tablename__ = "analysis_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    analysis_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("analyses.id", ondelete="CASCADE")
    )
    step: Mapped[str] = mapped_column(String(100))
    input_context: Mapped[Optional[Dict]] = mapped_column(Text, nullable=True)
    output_result: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="pending")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, nullable=False
    )
    completed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True
    )

    analysis: Mapped["Analysis"] = relationship(
        "Analysis", back_populates="analysis_runs"
    )

    def to_dict(self):
        return {
            "id": self.id,
            "analysis_id": self.analysis_id,
            "step": self.step,
            "input_context": eval(self.input_context) if self.input_context else None,
            "output_result": self.output_result,
            "status": self.status,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }


Job.analysis = relationship("Analysis", back_populates="job")
Collection.analysis = relationship("Analysis", back_populates="collection")
