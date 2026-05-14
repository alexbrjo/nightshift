import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitAppEvent } from "../appEvents";
import type { MethodExecutionSummary } from "../database";
import { fileNameFromPath } from "../features/project-editor/projectFileModel";

export function useMethodExecutionLauncher(dirtyPaths: Set<string>) {
  const [executingMethodPath, setExecutingMethodPath] = useState<string | null>(null);
  const [methodExecutionFeedback, setMethodExecutionFeedback] = useState<Record<string, {
    tone: "success" | "error";
    text: string;
  }>>({});

  const executeMethodFile = useCallback(async (filePath: string, sourcePanelId: string) => {
    if (dirtyPaths.has(filePath) || executingMethodPath === filePath) return;
    setExecutingMethodPath(filePath);
    setMethodExecutionFeedback((current) => {
      const next = { ...current };
      delete next[filePath];
      return next;
    });
    try {
      const execution = await invoke<MethodExecutionSummary>("execute_method_file", { methodPath: filePath });
      emitAppEvent("methodExecutionStarted", {
        executionId: execution.id,
        method: { title: fileNameFromPath(filePath) },
        sourcePanelId,
      });
      setMethodExecutionFeedback((current) => ({
        ...current,
        [filePath]: { tone: "success", text: `Started execution #${execution.id}.` },
      }));
    } catch (err) {
      setMethodExecutionFeedback((current) => ({
        ...current,
        [filePath]: { tone: "error", text: String(err) },
      }));
    } finally {
      setExecutingMethodPath(null);
    }
  }, [dirtyPaths, executingMethodPath]);

  return {
    executingMethodPath,
    methodExecutionFeedback,
    executeMethodFile,
  };
}
