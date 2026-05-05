//! Analysis worker stub. The full agent loop (queries → anecdotes → draft →
//! proofread, with bounded SQL exploration over sibling collections) was
//! deferred along with the `Siblings` / `Concat` / `Static` / `Grid` resolver
//! kinds it depended on. The kind stays reserved in the schema; experiments
//! that include an analysis leaf fail fast at run time with NotImplemented
//! rather than silently no-op.

use std::pin::Pin;

use crate::orchestrator::definition_service::JobDefinitionVersion;
use crate::orchestrator::execution::JobExecution;

use super::{Worker, WorkerContext, WorkerError};

#[derive(Default)]
pub struct AnalysisWorker;

impl AnalysisWorker {
    pub fn new() -> Self {
        Self
    }
}

impl Worker for AnalysisWorker {
    fn execute<'a>(
        &'a self,
        _exec: JobExecution,
        _version: JobDefinitionVersion,
        _ctx: WorkerContext,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), WorkerError>> + Send + 'a>> {
        Box::pin(async { Err(WorkerError::NotImplemented("analysis".into())) })
    }
}
