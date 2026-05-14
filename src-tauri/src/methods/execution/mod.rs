mod agents;
mod analysis;
mod commands;
mod jobs;
mod orchestrator;
mod repository;
mod snapshot;
mod topology;

pub(crate) use agents::*;
pub(crate) use analysis::*;
pub use commands::*;
pub(crate) use jobs::*;
pub(crate) use orchestrator::*;
pub(crate) use repository::*;
pub(crate) use snapshot::*;
pub(crate) use topology::*;

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};

use reqwest::Client;
use sha2::{Digest, Sha256};
use sqlx::{Column, Row, TypeInfo, ValueRef};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};

use crate::database::DatabaseState;
use crate::execution::sampling::parse_execution_node_ref;
use crate::execution::{JobEvent, JobExecutor, WorkerConfig};
use crate::state::{MethodExecutionControl, MethodExecutionManager};

use super::config::{
    config_f64, config_i32, config_string, method_file_by_kind, model_values,
    resolve_configured_file, runnable_dependency_ids, runnable_nodes, yaml_lookup, yaml_string,
};
use super::model::{
    ExecutionFileSummary, MethodArtifactSummary, MethodDocument, MethodExecutionEventSummary,
    MethodExecutionNodeSummary, MethodExecutionSummary, MethodWorkflowNode, OutputItem,
};
use super::paths::{
    execution_dir, execution_log_path, execution_output_path, project_root,
    validate_method_source_path,
};
use super::preflight::{format_preflight_blockers, preflight_method_for_root};
use super::storage::{freeze_files, hex, read_method_document, write_method_document};
