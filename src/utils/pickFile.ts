import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface PickFileResult {
  /** Project-relative path on success. */
  path?: string;
  /** Reason the picker returned without a usable path (cancelled, outside root). */
  error?: string;
}

/**
 * Open the native file picker and return a project-relative path. Out-of-root
 * selections are rejected with a structured error so callers can surface them
 * inline (e.g. as `errors.submit`) rather than letting the job fail later with
 * a confusing path-resolver message. Cancellation returns `{}`.
 */
export async function pickFile(
  filters: Array<{ name: string; extensions: string[] }>,
): Promise<PickFileResult> {
  const selected = await open({ multiple: false, directory: false, filters });
  if (typeof selected !== "string") return {};
  const root = await invoke<string | null>("get_root_path");
  if (root) {
    const sep = selected.includes("\\") && !selected.includes("/") ? "\\" : "/";
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (selected.startsWith(prefix)) {
      return { path: selected.slice(prefix.length) };
    }
    return { error: `Selected file is outside the project root: ${selected}` };
  }
  return { path: selected };
}
