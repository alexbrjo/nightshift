import { invoke } from "@tauri-apps/api/core";

import type {
  DefinitionContentInput,
  DefinitionWithVersion,
  ExecutionCollectionItem,
  JobDefinition,
  JobDefinitionVersion,
  JobExecution,
} from "../database";

// CRUD wrappers over the Tauri orchestrator surface. Frontend code reaches
// the backend through these typed functions instead of inlining `invoke`
// strings — they live in one place so the signatures are auditable.
//
// Execution-related commands (`experiment_start`, `execution_get_*`) are
// added in a later checkpoint when the worker chassis lands.

export function definitionCreate(input: {
  parentId: number | null;
  name: string;
  position?: number;
}): Promise<number> {
  return invoke<number>("definition_create", {
    input: { parentId: input.parentId, name: input.name, position: input.position ?? 0 },
  });
}

export function definitionSaveVersion(
  defId: number,
  content: DefinitionContentInput,
): Promise<number> {
  return invoke<number>("definition_save_version", { input: { defId, content } });
}

export function definitionReadCurrent(defId: number): Promise<DefinitionWithVersion> {
  return invoke<DefinitionWithVersion>("definition_read_current", { defId });
}

export function definitionReadVersion(versionId: number): Promise<JobDefinitionVersion> {
  return invoke<JobDefinitionVersion>("definition_read_version", { versionId });
}

export function definitionListVersions(defId: number): Promise<JobDefinitionVersion[]> {
  return invoke<JobDefinitionVersion[]>("definition_list_versions", { defId });
}

export function definitionRename(defId: number, newName: string): Promise<void> {
  return invoke<void>("definition_rename", { input: { defId, newName } });
}

export function definitionMove(
  defId: number,
  newParentId: number | null,
  newPosition: number,
): Promise<void> {
  return invoke<void>("definition_move", {
    input: { defId, newParentId, newPosition },
  });
}

export function definitionDelete(defId: number): Promise<void> {
  return invoke<void>("definition_delete", { defId });
}

export function definitionListRoots(): Promise<JobDefinition[]> {
  return invoke<JobDefinition[]>("definition_list_roots");
}

export function definitionListByRoot(rootId: number): Promise<JobDefinition[]> {
  return invoke<JobDefinition[]>("definition_list_by_root", { rootId });
}

// ----- experiment lifecycle -----

export function experimentStart(rootDefId: number): Promise<number> {
  return invoke<number>("experiment_start", { rootDefId });
}

export function experimentCancel(rootExecId: number): Promise<void> {
  return invoke<void>("experiment_cancel", { rootExecId });
}

// ----- execution reads -----

export function executionGet(execId: number): Promise<JobExecution> {
  return invoke<JobExecution>("execution_get", { execId });
}

export function executionGetTree(rootExecId: number): Promise<JobExecution[]> {
  return invoke<JobExecution[]>("execution_get_tree", { rootExecId });
}

export function executionGetCollection(
  execId: number,
  page: number,
  pageSize: number,
): Promise<ExecutionCollectionItem[]> {
  return invoke<ExecutionCollectionItem[]>("execution_get_collection", {
    execId,
    page,
    pageSize,
  });
}

export function executionGetLedger(
  execId: number,
): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown> | null>("execution_get_ledger", { execId });
}

// ----- event payload types for `listen()` consumers -----

export interface DefinitionVersionCreatedPayload {
  defId: number;
  versionId: number;
}

export interface DefinitionUpdatedPayload {
  defId: number;
  change: "rename" | "move" | "delete";
}

export interface ExecutionStatusPayload {
  execId: number;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  parentId: number | null;
  error?: string;
}

export interface ExecutionProgressPayload {
  execId: number;
  completed: number;
  failed: number;
  total: number;
}

export interface ExperimentStartedPayload {
  rootExecId: number;
  rootDefId: number;
}

export interface ExperimentTerminalPayload {
  rootExecId: number;
  error?: string;
}
