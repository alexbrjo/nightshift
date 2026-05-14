import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { emitAppEvent, useAppEvent } from "../appEvents";
import type { EditorViewMode, WorkspacePanel } from "../layout";
import type { FsNode } from "../features/project-tree/FileTree";
import {
  defaultViewModeForFile,
  fileNameFromPath,
} from "../features/project-editor/projectFileModel";
import { initialProjectFileState, projectFileReducer } from "./projectFileReducer";
import { readProjectFileSnapshot } from "./projectFileHydration";

export function useProjectFiles({
  panels,
  openPanel,
}: {
  panels: WorkspacePanel[];
  openPanel: (type: "project-editor", options: { resourceId: string; title: string; viewMode?: EditorViewMode }) => void;
}) {
  const [state, dispatch] = useReducer(projectFileReducer, initialProjectFileState);
  const [fileTreeRefreshKey, setFileTreeRefreshKey] = useState(0);
  const [projectFolderName, setProjectFolderName] = useState("");

  const dirtyPaths = useMemo(() => {
    const dirty = new Set<string>();
    for (const [path, snapshot] of Object.entries(state.snapshots)) {
      if (snapshot.content !== (state.baselines[path] ?? "")) dirty.add(path);
    }
    return dirty;
  }, [state.baselines, state.snapshots]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<string>("project-opened", () => {
      if (!cancelled) {
        dispatch({ type: "reset" });
        setProjectFolderName("");
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const readProjectFile = useCallback(async (path: string, name: string) => {
    dispatch({ type: "beginHydrating", paths: [path] });
    const file = await readProjectFileSnapshot(path, name);
    if (file.snapshot.error) {
      dispatch({ type: "failHydrating", path, snapshot: file.snapshot });
    } else {
      dispatch({ type: "finishHydrating", path, baseline: file.baseline, snapshot: file.snapshot });
    }
  }, []);

  const handleFileOpen = useCallback((node: FsNode) => {
    const diskContent = node.content || "";
    const existing = state.snapshots[node.path]?.content;
    const content = existing !== undefined ? existing : diskContent;

    dispatch({
      type: "openFromTree",
      path: node.path,
      name: node.name,
      content,
      diskContent,
    });
    openPanel("project-editor", {
      resourceId: node.path,
      title: node.name,
      viewMode: defaultViewModeForFile(node.path, node.name),
    });
  }, [openPanel, state.snapshots]);

  const openProjectFile = useCallback(async (
    path: string,
    options: { title?: string; viewMode?: EditorViewMode; reload?: boolean } = {},
  ) => {
    const name = options.title ?? fileNameFromPath(path);
    const viewMode = options.viewMode ?? defaultViewModeForFile(path, name);

    openPanel("project-editor", { resourceId: path, title: name, viewMode });

    if ((!options.reload && state.snapshots[path]) || state.hydratingPaths.has(path)) return;
    await readProjectFile(path, name);
  }, [openPanel, readProjectFile, state.hydratingPaths, state.snapshots]);

  const handleFileSaved = useCallback((path: string) => {
    dispatch({ type: "markSaved", path });
  }, []);

  const updateFileContent = useCallback((path: string, content: string) => {
    dispatch({ type: "updateContent", path, content });
  }, []);

  const getActiveContent = useCallback((filePath?: string) => {
    return filePath ? state.snapshots[filePath]?.content : undefined;
  }, [state.snapshots]);

  useEffect(() => {
    let cancelled = false;
    const pathsToHydrate = Array.from(new Set(panels
      .filter((panel) => panel.type === "project-editor" && panel.resourceId)
      .map((panel) => panel.resourceId as string)
      .filter((path) => !state.snapshots[path] && !state.hydratingPaths.has(path))));

    if (pathsToHydrate.length === 0) return;
    dispatch({ type: "beginHydrating", paths: pathsToHydrate });

    const hydrateRestoredFiles = async () => {
      const hydratedFiles = await Promise.all(pathsToHydrate.map((path) => readProjectFileSnapshot(path)));

      if (!cancelled) {
        dispatch({ type: "finishHydratingMany", files: hydratedFiles });
      }
    };
    void hydrateRestoredFiles();
    return () => {
      cancelled = true;
      dispatch({ type: "cancelHydrating", paths: pathsToHydrate });
    };
  }, [panels, state.snapshots]);

  useAppEvent("projectFilesChanged", useCallback(() => {
    setFileTreeRefreshKey((key) => key + 1);
  }, []));

  useAppEvent("methodDraftMutated", useCallback(() => {
    emitAppEvent("projectFilesChanged");
    void openProjectFile("methods/current.method.yaml", {
      title: "current.method.yaml",
      viewMode: "methodGraph",
      reload: true,
    });
  }, [openProjectFile]));

  return {
    fileSnapshots: state.snapshots,
    dirtyPaths,
    fileTreeRefreshKey,
    projectFolderName,
    setProjectFolderName,
    handleFileOpen,
    handleFileSaved,
    updateFileContent,
    getActiveContent,
    openProjectFile,
  };
}
