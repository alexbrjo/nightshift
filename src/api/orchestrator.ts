import { invoke } from "@tauri-apps/api/core";

import type {
  DefinitionContentInput,
  DefinitionWithVersion,
  JobDefinition,
  JobDefinitionVersion,
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

// Event payload types for `listen()` consumers.

export interface DefinitionVersionCreatedPayload {
  defId: number;
  versionId: number;
}

export interface DefinitionUpdatedPayload {
  defId: number;
  change: "rename" | "move" | "delete";
}
