//! JS action stub. Reserved kind in the schema; surfaced in the UI as
//! "not yet supported." The backend errors out with `WorkerError::NotImplemented`
//! so a misconfigured tree fails fast rather than silently no-oping.

use std::pin::Pin;

use crate::orchestrator::definition_service::JobDefinitionVersion;
use crate::orchestrator::execution::JobExecution;

use super::{Worker, WorkerContext, WorkerError};

#[derive(Default)]
pub struct JsActionWorker;

impl JsActionWorker {
    pub fn new() -> Self {
        Self
    }
}

impl Worker for JsActionWorker {
    fn execute<'a>(
        &'a self,
        _exec: JobExecution,
        _version: JobDefinitionVersion,
        _ctx: WorkerContext,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), WorkerError>> + Send + 'a>> {
        Box::pin(async { Err(WorkerError::NotImplemented("js_action".into())) })
    }
}
