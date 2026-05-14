import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  closePanel,
  createPanel,
  defaultWorkspaceLayout,
  openOrFocusPanel,
  parseWorkspaceLayout,
  serializeWorkspaceLayout,
  type EditorViewMode,
  type PanelType,
  type ResourceKind,
  type WorkspaceLayout,
  type WorkspacePanel,
} from "../layout";

const LAYOUT_SAVE_DEBOUNCE_MS = 300;

export function useWorkspaceLayout() {
  const [layout, setLayout] = useState<WorkspaceLayout>(defaultWorkspaceLayout);
  const [layoutPersistenceReady, setLayoutPersistenceReady] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!layoutPersistenceReady) return;
    const timeout = window.setTimeout(() => {
      void invoke("save_project_layout", { layout: JSON.parse(serializeWorkspaceLayout(layout)) });
    }, LAYOUT_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [layout, layoutPersistenceReady]);

  const loadProjectLayout = useCallback(async (
    options: { resetOnMissing?: boolean; preserveActiveResourceKind?: boolean } = {},
  ) => {
    try {
      const value = await invoke<unknown>("load_project_layout");
      if (value !== null && value !== undefined) {
        setLayout(parseWorkspaceLayout(JSON.stringify(value)) ?? defaultWorkspaceLayout());
      } else if (options.resetOnMissing) {
        setLayout(options.preserveActiveResourceKind
          ? (current: WorkspaceLayout) => ({
              ...defaultWorkspaceLayout(),
              activeResourceKind: current.activeResourceKind,
              sidebarMode: current.sidebarMode,
            })
          : defaultWorkspaceLayout);
      }
      setLayoutPersistenceReady(true);
    } catch {
      setLayout(defaultWorkspaceLayout());
      setLayoutPersistenceReady(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const initializeProjectRoot = async () => {
      try {
        const root = await invoke<string | null>("get_root_path");
        if (cancelled) return;
        if (root) {
          await loadProjectLayout();
          return;
        }
        const lastPath = await invoke<string | null>("load_last_folder");
        if (cancelled || !lastPath) return;
        await invoke("set_root_path", { path: lastPath });
        if (!cancelled) await loadProjectLayout({ resetOnMissing: true });
      } catch {
        if (!cancelled) setLayoutPersistenceReady(false);
      }
    };
    listen<string>("project-opened", () => {
      if (!cancelled) {
        void loadProjectLayout({ resetOnMissing: true, preserveActiveResourceKind: true });
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        if (!cancelled) setLayoutPersistenceReady(false);
      });
    void initializeProjectRoot();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [loadProjectLayout]);

  const openPanel = useCallback((
    type: PanelType,
    options: { resourceId?: string | number | null; title?: string; viewMode?: EditorViewMode } = {},
  ) => {
    setLayout((current) => openOrFocusPanel(current, createPanel(type, options)));
  }, []);

  const replacePanelWithPanel = useCallback((sourcePanelId: string, panel: WorkspacePanel) => {
    setLayout((current) => closePanel(openOrFocusPanel(current, panel), sourcePanelId));
  }, []);

  const focusOrReplacePanel = useCallback((panel: WorkspacePanel, sourcePanelId?: string) => {
    setLayout((current) => {
      if (current.panels.some((candidate) => candidate.id === panel.id)) {
        return sourcePanelId
          ? closePanel(openOrFocusPanel(current, panel), sourcePanelId)
          : openOrFocusPanel(current, panel);
      }
      const sourceIndex = sourcePanelId
        ? current.panels.findIndex((candidate) => candidate.id === sourcePanelId)
        : -1;
      if (sourceIndex === -1) return openOrFocusPanel(current, panel);
      const panels = current.panels.map((candidate, index) =>
        index === sourceIndex ? panel : candidate,
      );
      return {
        ...current,
        panels,
        activePanelId: panel.id,
      };
    });
  }, []);

  const setProjectEditorViewMode = useCallback((panelId: string, viewMode: EditorViewMode) => {
    setLayout((current) => ({
      ...current,
      panels: current.panels.map((panel) => panel.id === panelId ? { ...panel, viewMode } : panel),
    }));
  }, []);

  const setActiveResourceKind = useCallback((kind: ResourceKind) => {
    setLayout((current) => ({
      ...current,
      activeResourceKind: kind,
      sidebarMode: current.activeResourceKind === kind && current.sidebarMode === "expanded"
        ? "collapsed"
        : "expanded",
    }));
  }, []);

  const toggleSidebar = useCallback(() => {
    setLayout((current) => ({
      ...current,
      sidebarMode: current.sidebarMode === "expanded" ? "collapsed" : "expanded",
    }));
  }, []);

  const setSplitSizes = useCallback((splitSizes: number[]) => {
    setLayout((current) => ({
      ...current,
      splitSizes,
    }));
  }, []);

  const setActivePanel = useCallback((panelId: string) => {
    setLayout((current) => ({ ...current, activePanelId: panelId }));
  }, []);

  const closeWorkspacePanel = useCallback((panelId: string) => {
    setLayout((current) => closePanel(current, panelId));
  }, []);

  return {
    layout,
    setLayout,
    openPanel,
    replacePanelWithPanel,
    focusOrReplacePanel,
    setProjectEditorViewMode,
    setActiveResourceKind,
    toggleSidebar,
    setSplitSizes,
    setActivePanel,
    closeWorkspacePanel,
  };
}
