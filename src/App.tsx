import { Fragment, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import Editor from "./components/Editor";
import FileTree, { type FsNode } from "./components/FileTree";
import {
  ChatPanel,
  DraftMethodGraphPanel,
  MethodExecutionGraphPanel,
  MethodWorkspaceProvider,
} from "./components/AgentWorkspace";
import JobListSidebar from "./components/JobListSidebar";
import JobViewPage from "./components/JobViewPage";
import InferenceJobForm from "./components/InferenceJobForm";
import {
  MarkdownPreview,
  MethodGraphPreview,
  projectFileViewOptions,
} from "./components/ProjectFileViews";
import { ToastProvider } from "./components/Toast";
import type { MethodExecutionSummary } from "./database";
import {
  CodeViewIcon,
  DropperIcon,
  MarkdownViewIcon,
  TestTubeIcon,
  RackIcon,
  MethodGraphViewIcon,
  MethodIcon,
  NightShiftIcon,
} from "./components/icons";
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
} from "./layout";

const LAYOUT_SAVE_DEBOUNCE_MS = 300;

function getLanguage(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    jsx: "jsx",
    tsx: "tsx",
    json: "json",
    jsonl: "json",
    ndjson: "json",
    md: "markdown",
    markdown: "markdown",
    mdx: "markdown",
    yaml: "yaml",
    yml: "yaml",
    py: "python",
    rs: "rust",
    html: "html",
    htm: "html",
    css: "css",
    sh: "bash",
    bash: "bash",
    jinja2: "jinja2",
    jinja: "jinja2",
    j2: "jinja2",
    prompt: "jinja2",
  };
  return ext ? map[ext] : undefined;
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function isMethodSourceFile(path: string, name: string) {
  const normalizedPath = path.replace(/\\/g, "/").toLowerCase();
  const normalizedName = name.toLowerCase();
  return normalizedName.endsWith(".method.yaml")
    || normalizedName.endsWith(".method.yml")
    || normalizedPath.endsWith(".method.yaml")
    || normalizedPath.endsWith(".method.yml");
}

function defaultViewModeForFile(path: string, name: string): EditorViewMode | undefined {
  return isMethodSourceFile(path, name) ? "methodGraph" : undefined;
}

function ResourceNavButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`sidebar-btn ${active ? "active" : ""}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      <span>{icon}</span>
    </button>
  );
}

function viewModeIcon(mode: EditorViewMode) {
  switch (mode) {
    case "code":
      return <CodeViewIcon />;
    case "markdown":
      return <MarkdownViewIcon />;
    case "methodGraph":
      return <MethodGraphViewIcon />;
  }
}

function isStoredConversationResource(chat: { messages?: unknown[] }) {
  if (!Array.isArray(chat.messages) || chat.messages.length === 0) return false;
  return chat.messages.some((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    if (!("id" in message) || !("role" in message)) return false;
    return !(message.id === "welcome" && message.role === "assistant");
  });
}

function ConversationResources({
  openPanelIds,
  onOpenChat,
}: {
  openPanelIds: Set<string>;
  onOpenChat: (chatId?: string, title?: string) => void;
}) {
  const [chats, setChats] = useState<Array<{ id: string; title: string; messages?: unknown[] }>>([]);

  useEffect(() => {
    let cancelled = false;
    let unlistenProject: (() => void) | null = null;
    const loadChats = async () => {
      try {
        const parsed = await invoke<unknown | null>("load_project_conversations");
        if (!cancelled) {
          const resources = Array.isArray(parsed)
            ? (parsed as Array<{ id: string; title: string; messages?: unknown[] }>).filter(isStoredConversationResource)
            : [];
          setChats(resources);
        }
      } catch {
        if (!cancelled) setChats([]);
      }
    };
    const handleConversationsUpdated = () => void loadChats();
    void loadChats();
    window.addEventListener("nightshift-conversations-updated", handleConversationsUpdated);
    listen<string>("project-opened", () => {
      if (!cancelled) void loadChats();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenProject = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      window.removeEventListener("nightshift-conversations-updated", handleConversationsUpdated);
      unlistenProject?.();
    };
  }, []);

  return (
    <div className="resource-list">
      <button
        type="button"
        className="resource-create-button"
        onClick={() => onOpenChat()}
        title="Create a new chat"
      >
        Create a new chat
      </button>
      {chats.map((chat) => (
        <button
          key={chat.id}
          type="button"
          className="resource-row"
          onClick={() => onOpenChat(chat.id, chat.title)}
          title={`${chat.title} · ${chat.messages?.length ?? 0} messages`}
        >
          <span className="resource-name">{chat.title}</span>
          {openPanelIds.has(`chat:${encodeURIComponent(chat.id)}`) && <span className="resource-meta">open</span>}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [layout, setLayout] = useState<WorkspaceLayout>(defaultWorkspaceLayout);
  const [layoutPersistenceReady, setLayoutPersistenceReady] = useState(false);
  const [fileSnapshots, setFileSnapshots] = useState<Record<string, {
    path: string;
    name: string;
    content: string;
    language?: string;
    error?: string;
  }>>({});
  const [jobListRefreshKey, setJobListRefreshKey] = useState(0);
  const [fileTreeRefreshKey, setFileTreeRefreshKey] = useState(0);
  const [projectFolderName, setProjectFolderName] = useState("");
  const [executingMethodPath, setExecutingMethodPath] = useState<string | null>(null);
  const [methodExecutionFeedback, setMethodExecutionFeedback] = useState<Record<string, {
    tone: "success" | "error";
    text: string;
  }>>({});
  const fileContentsRef = useRef(new Map<string, string>());
  const hydratingFilePathsRef = useRef(new Set<string>());
  // Per-file disk content captured the first time a file is opened (and after
  // each save). A path is "dirty" iff its in-memory content differs from this
  // baseline; the dirty set drives the unsaved-marker in the file tree.
  const originalContentsRef = useRef(new Map<string, string>());
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());

  // Theme toggle: clicking the moon logo flips between the default lab theme
  // (no attribute) and the midnight theme (data-theme="dark"). Persisted to
  // localStorage so it survives reloads.
  const [isDark, setIsDark] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("nightshift-theme") === "dark";
  });

  useEffect(() => {
    if (isDark) {
      document.documentElement.dataset.theme = "dark";
      localStorage.setItem("nightshift-theme", "dark");
    } else {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem("nightshift-theme");
    }
  }, [isDark]);

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
        setFileSnapshots({});
        fileContentsRef.current.clear();
        originalContentsRef.current.clear();
        hydratingFilePathsRef.current.clear();
        setDirtyPaths(new Set());
        setProjectFolderName("");
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

  const openPanel = useCallback((type: PanelType, options: { resourceId?: string | number | null; title?: string; viewMode?: EditorViewMode } = {}) => {
    setLayout((current) => openOrFocusPanel(current, createPanel(type, options)));
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

  const handleFileOpen = useCallback(async (node: FsNode) => {
    // Prefer the in-memory copy if we already have it — otherwise the user's
    // unsaved edits would get clobbered every time they revisit a file. The
    // node.content provided by FileTree is treated as disk truth and seeds
    // the original-content baseline for dirty detection.
    const diskContent = node.content || "";
    const existing = fileContentsRef.current.get(node.path);
    const content = existing !== undefined ? existing : diskContent;

    fileContentsRef.current.set(node.path, content);
    if (!originalContentsRef.current.has(node.path)) {
      originalContentsRef.current.set(node.path, diskContent);
    }
    const nextFile = {
      path: node.path,
      name: node.name,
      content,
      language: getLanguage(node.name),
    };
    setFileSnapshots((current) => ({ ...current, [node.path]: nextFile }));
    openPanel("project-editor", {
      resourceId: node.path,
      title: node.name,
      viewMode: defaultViewModeForFile(node.path, node.name),
    });
  }, [openPanel]);

  const openProjectFile = useCallback(async (
    path: string,
    options: { title?: string; viewMode?: EditorViewMode; reload?: boolean } = {},
  ) => {
    const name = options.title ?? fileNameFromPath(path);
    const viewMode = options.viewMode ?? defaultViewModeForFile(path, name);

    openPanel("project-editor", { resourceId: path, title: name, viewMode });

    if ((!options.reload && fileContentsRef.current.has(path)) || hydratingFilePathsRef.current.has(path)) return;
    hydratingFilePathsRef.current.add(path);
    try {
      const diskContent = await invoke<string>("read_file", { relativePath: path });
      fileContentsRef.current.set(path, diskContent);
      originalContentsRef.current.set(path, diskContent);
      setFileSnapshots((current) => ({
        ...current,
        [path]: {
          path,
          name,
          content: diskContent,
          language: getLanguage(name),
        },
      }));
    } catch (err) {
      setFileSnapshots((current) => ({
        ...current,
        [path]: {
          path,
          name,
          content: "",
          language: getLanguage(name),
          error: String(err),
        },
      }));
    } finally {
      hydratingFilePathsRef.current.delete(path);
    }
  }, [openPanel]);

  // Called by FileTree after a successful write_file. Re-baselines the saved
  // path so the dirty marker disappears.
  const handleFileSaved = useCallback((path: string) => {
    const current = fileContentsRef.current.get(path) ?? "";
    originalContentsRef.current.set(path, current);
    setDirtyPaths((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const pathsToHydrate = Array.from(new Set(layout.panels
      .filter((panel) => panel.type === "project-editor" && panel.resourceId)
      .map((panel) => panel.resourceId as string)
      .filter((path) => !fileContentsRef.current.has(path) && !hydratingFilePathsRef.current.has(path))));

    if (pathsToHydrate.length === 0) return;
    pathsToHydrate.forEach((path) => hydratingFilePathsRef.current.add(path));

    const hydrateRestoredFiles = async () => {
      const hydratedFiles = await Promise.all(pathsToHydrate.map(async (path) => {
        try {
          const content = await invoke<string>("read_file", { relativePath: path });
          const name = fileNameFromPath(path);
          return {
            path,
            snapshot: {
              path,
              name,
              content,
              language: getLanguage(name),
            },
            content,
          };
        } catch (err) {
          return {
            path,
            snapshot: {
              path,
              name: path.split(/[\\/]/).pop() || path,
              content: "",
              error: String(err),
            },
            content: "",
          };
        }
      }));

      if (cancelled) return;
      for (const file of hydratedFiles) {
        fileContentsRef.current.set(file.path, file.content);
        originalContentsRef.current.set(file.path, file.content);
      }
      setFileSnapshots((current) => {
        let changed = false;
        const next = { ...current };
        for (const file of hydratedFiles) {
          if (next[file.path]) continue;
          next[file.path] = file.snapshot;
          changed = true;
        }
        return changed ? next : current;
      });
    };
    void hydrateRestoredFiles();
    return () => {
      cancelled = true;
      pathsToHydrate.forEach((path) => hydratingFilePathsRef.current.delete(path));
    };
  }, [layout.panels]);

  const handleJobCreated = useCallback((jobId: number, sourcePanelId: string) => {
    setJobListRefreshKey((key) => key + 1);
    const jobPanel = createPanel("job-view", { resourceId: jobId, title: `Job #${jobId}` });
    setLayout((current) => closePanel(openOrFocusPanel(current, jobPanel), sourcePanelId));
  }, []);

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
      window.dispatchEvent(new CustomEvent("nightshift-method-execution-started", {
        detail: {
          executionId: execution.id,
          method: { title: fileNameFromPath(filePath) },
          sourcePanelId,
        },
      }));
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

  useEffect(() => {
    const handleExecutionStarted = (event: Event) => {
      const detail = (event as CustomEvent<{
        method?: { title?: string };
        executionId?: number;
        sourcePanelId?: string;
      }>).detail;
      if (!detail?.executionId) return;
      const executionPanel = createPanel("method-execution", {
        resourceId: detail.executionId,
        title: detail.method?.title ? `Execution: ${detail.method.title}` : `Execution #${detail.executionId}`,
      });
      setLayout((current) => {
        if (current.panels.some((panel) => panel.id === executionPanel.id)) {
          return detail.sourcePanelId
            ? closePanel(openOrFocusPanel(current, executionPanel), detail.sourcePanelId)
            : openOrFocusPanel(current, executionPanel);
        }
        const sourceIndex = detail.sourcePanelId
          ? current.panels.findIndex((panel) => panel.id === detail.sourcePanelId)
          : -1;
        if (sourceIndex === -1) return openOrFocusPanel(current, executionPanel);
        const panels = current.panels.map((panel, index) =>
          index === sourceIndex ? executionPanel : panel,
        );
        return {
          ...current,
          panels,
          activePanelId: executionPanel.id,
        };
      });
    };
    window.addEventListener("nightshift-method-execution-started", handleExecutionStarted);
    return () => window.removeEventListener("nightshift-method-execution-started", handleExecutionStarted);
  }, []);

  useEffect(() => {
    const handleProjectFilesChanged = () => setFileTreeRefreshKey((key) => key + 1);
    const handleMethodDraftMutated = () => void openProjectFile("methods/current.method.yaml", {
      title: "current.method.yaml",
      viewMode: "methodGraph",
      reload: true,
    });
    window.addEventListener("nightshift-project-files-changed", handleProjectFilesChanged);
    window.addEventListener("nightshift-method-draft-mutated", handleMethodDraftMutated);
    return () => {
      window.removeEventListener("nightshift-project-files-changed", handleProjectFilesChanged);
      window.removeEventListener("nightshift-method-draft-mutated", handleMethodDraftMutated);
    };
  }, [openProjectFile]);

  const renderEmptyWorkspace = () => (
    <div className="workspace-empty-state">
      <h2>Let's get started!</h2>
      <p>Create a chat, Method, job, or open a project file from the sidebar.</p>
    </div>
  );

  const renderResourceBrowser = () => {
    switch (layout.activeResourceKind) {
      case "conversation":
        return (
          <ConversationResources
            openPanelIds={new Set(layout.panels.map((panel) => panel.id))}
            onOpenChat={(chatId, title) => openPanel("chat", { resourceId: chatId, title: title ?? "Chat" })}
          />
        );
      case "method":
        return <p className="resource-empty-copy">Open Method source files from the project tree.</p>;
      case "project":
        return (
          <FileTree
            onFileOpen={handleFileOpen}
            onFileSaved={handleFileSaved}
            dirtyPaths={dirtyPaths}
            getActiveContent={(filePath) => fileContentsRef.current.get(filePath || "") ?? undefined}
            className="resource-file-tree"
            refreshKey={fileTreeRefreshKey}
            onRootNameChange={setProjectFolderName}
          />
        );
      case "job":
        return (
          <JobListSidebar
            selectedId={null}
            onSelectJob={(jobId) => openPanel("job-view", { resourceId: jobId, title: `Job #${jobId}` })}
            onNewJob={() => openPanel("new-job")}
            refreshKey={jobListRefreshKey}
            isActive={layout.activeResourceKind === "job"}
          />
        );
    }
  };

  const renderProjectEditorViewSwitcher = (panel: WorkspacePanel) => {
    if (panel.type !== "project-editor") return null;
    const file = fileSnapshots[panel.resourceId ?? ""];
    if (!file) return null;
    const options = projectFileViewOptions(file.path, file.name);
    if (options.length <= 1) return null;
    const defaultMode = defaultViewModeForFile(file.path, file.name) ?? "code";
    const requestedMode = panel.viewMode ?? defaultMode;
    const selectedMode = options.some((option) => option.mode === requestedMode) ? requestedMode : "code";

    return (
      <div className="project-file-view-switcher" role="group" aria-label={`View options for ${file.name}`}>
        {options.map((option) => (
          <button
            key={option.mode}
            type="button"
            className={`project-file-view-button ${selectedMode === option.mode ? "active" : ""}`}
            onClick={() => setProjectEditorViewMode(panel.id, option.mode)}
            title={option.label}
            aria-label={`Show ${option.label} for ${file.name}`}
            aria-pressed={selectedMode === option.mode}
          >
            {viewModeIcon(option.mode)}
          </button>
        ))}
      </div>
    );
  };

  const renderProjectEditorExecuteButton = (panel: WorkspacePanel) => {
    if (panel.type !== "project-editor") return null;
    const filePath = panel.resourceId ?? "";
    const file = fileSnapshots[filePath];
    if (!file) return null;
    const defaultMode = defaultViewModeForFile(file.path, file.name) ?? "code";
    const requestedMode = panel.viewMode ?? defaultMode;
    const viewMode = projectFileViewOptions(file.path, file.name).some((option) => option.mode === requestedMode)
      ? requestedMode
      : "code";
    if (viewMode !== "methodGraph" || !isMethodSourceFile(file.path, file.name)) return null;
    const isDirty = dirtyPaths.has(file.path);
    const isExecuting = executingMethodPath === file.path;
    const title = isDirty ? "Save this Method file before execution" : "Execute Method file";
    return (
      <>
        <button
          type="button"
          className="project-file-execute-button"
          onClick={() => void executeMethodFile(file.path, panel.id)}
          disabled={isDirty || isExecuting}
          title={title}
          aria-label={isDirty ? `Save ${file.name} before execution` : `Execute ${file.name}`}
        >
          {isExecuting ? "Starting" : "Execute"}
        </button>
        {methodExecutionFeedback[file.path] && (
          <span
            className={`project-file-execution-feedback ${methodExecutionFeedback[file.path].tone}`}
            role="status"
          >
            {methodExecutionFeedback[file.path].text}
          </span>
        )}
      </>
    );
  };

  const renderPanel = (panel: WorkspacePanel) => {
    switch (panel.type) {
      case "chat":
        return <ChatPanel chatId={panel.resourceId} />;
      case "method-graph":
        return <DraftMethodGraphPanel />;
      case "method-execution":
        return <MethodExecutionGraphPanel executionId={panel.resourceId} />;
      case "project-editor":
        {
          const filePath = panel.resourceId ?? "";
          const file = fileSnapshots[filePath];
          const viewOptions = file ? projectFileViewOptions(file.path, file.name) : [];
          const defaultMode = file ? defaultViewModeForFile(file.path, file.name) ?? "code" : "code";
          const requestedMode = panel.viewMode ?? defaultMode;
          const viewMode = viewOptions.some((option) => option.mode === requestedMode) ? requestedMode : "code";
          return file?.error ? (
            <div className="editor-placeholder">Could not load {file.name}: {file.error}</div>
          ) : file ? (
            viewMode === "markdown" ? (
              <MarkdownPreview content={file.content} />
            ) : viewMode === "methodGraph" ? (
              <MethodGraphPreview content={file.content} />
            ) : (
              <Editor
                code={file.content}
                language={file.language}
                onChange={(code) => {
                  fileContentsRef.current.set(file.path, code);
                  const original = originalContentsRef.current.get(file.path) ?? "";
                  setDirtyPaths((d) => {
                    const isDirty = code !== original;
                    if (isDirty === d.has(file.path)) return d;
                    const next = new Set(d);
                    if (isDirty) next.add(file.path);
                    else next.delete(file.path);
                    return next;
                  });
                  setFileSnapshots((current) => {
                    const existing = current[file.path];
                    if (!existing) return current;
                    return { ...current, [file.path]: { ...existing, content: code } };
                  });
                }}
              />
            )
        ) : (
            <div className="editor-placeholder">Open this file from the Project sidebar to load its content.</div>
          );
        }
      case "job-view": {
        const jobId = Number(panel.resourceId);
        return Number.isFinite(jobId) ? (
          <div className="job-runner-main panel-job-view">
            <JobViewPage jobId={jobId} />
          </div>
        ) : (
          <div className="editor-placeholder">Select a job to view details.</div>
        );
      }
      case "new-job":
        return (
          <div className="job-runner-main panel-job-view">
            <InferenceJobForm
              isOpen={true}
              onClose={() => undefined}
              onSuccess={(jobId) => handleJobCreated(jobId, panel.id)}
            />
          </div>
        );
    }
  };

  const resourceButtons: Array<{ kind: ResourceKind; icon: ReactNode; label: string }> = [
    { kind: "conversation", icon: <RackIcon />, label: "Conversations" },
    { kind: "method", icon: <MethodIcon />, label: "Methods" },
    { kind: "project", icon: <DropperIcon />, label: "Project" },
    { kind: "job", icon: <TestTubeIcon />, label: "Jobs" },
  ];

  return (
    <ToastProvider>
      <MethodWorkspaceProvider>
      <div className="app">
        <div className="topbar" data-tauri-drag-region>
          <span className="topbar-title" data-tauri-drag-region>Nightshift</span>
        </div>
        <div className="app-body">
          <aside className={`sidebar unified-sidebar ${layout.sidebarMode}`}>
            <button
              type="button"
              className="sidebar-logo"
              title={isDark ? "Switch to dumpster theme" : "Switch to midnight theme"}
              aria-pressed={isDark}
              onClick={() => setIsDark((prev) => !prev)}
            >
              <NightShiftIcon />
            </button>
            <nav className="sidebar-nav" aria-label="Resources">
              {resourceButtons.map((resource) => (
                <ResourceNavButton
                  key={resource.kind}
                  active={layout.sidebarMode === "expanded" && layout.activeResourceKind === resource.kind}
                  icon={resource.icon}
                  label={resource.label}
                  onClick={() => setActiveResourceKind(resource.kind)}
                />
              ))}
            </nav>
            <button
              type="button"
              className="sidebar-collapse-btn"
              onClick={() =>
                setLayout((current) => ({
                  ...current,
                  sidebarMode: current.sidebarMode === "expanded" ? "collapsed" : "expanded",
                }))
              }
              title={layout.sidebarMode === "expanded" ? "Collapse resource sidebar" : "Expand resource sidebar"}
              aria-label={layout.sidebarMode === "expanded" ? "Collapse resource sidebar" : "Expand resource sidebar"}
            >
              {layout.sidebarMode === "expanded" ? "‹" : "›"}
            </button>
          </aside>

          {layout.sidebarMode === "expanded" && (
            <aside className="resource-sidebar-panel">
              <header className="resource-sidebar-header">
                <h2>{resourceButtons.find((resource) => resource.kind === layout.activeResourceKind)?.label}</h2>
                {layout.activeResourceKind === "project" && projectFolderName && (
                  <span
                    className="resource-sidebar-context"
                    title={projectFolderName}
                    aria-label={`Project folder: ${projectFolderName}`}
                  >
                    {projectFolderName}
                  </span>
                )}
              </header>
              {renderResourceBrowser()}
            </aside>
          )}

          <main className="workspace panel-workspace">
            {layout.panels.length === 0 ? renderEmptyWorkspace() : (
              <PanelGroup
              id="nightshift-panel-workspace"
              direction="horizontal"
              className="workspace-panel-group"
              onLayout={(sizes) =>
                setLayout((current) => ({
                  ...current,
                  splitSizes: sizes,
                }))
              }
            >
              {layout.panels.map((panel, index) => (
                <Fragment key={panel.id}>
                  {index > 0 && (
                    <PanelResizeHandle
                      id={`workspace-panel-resize-${panel.id}`}
                      className="agent-pane-resizer"
                      aria-label={`Resize ${panel.title} panel`}
                    />
                  )}
                  <Panel
                    id={panel.id}
                    order={index + 1}
                    defaultSize={layout.splitSizes[index]}
                    minSize={18}
                    className={`workspace-panel ${layout.activePanelId === panel.id ? "active" : ""}`}
                    onFocus={() => setLayout((current) => ({ ...current, activePanelId: panel.id }))}
                  >
                    <section className="workspace-panel-shell" aria-label={panel.title}>
                      <header className="workspace-panel-header">
                        <div className="workspace-panel-header-main">
                          <button
                            type="button"
                            className="workspace-panel-title"
                            onClick={() => setLayout((current) => ({ ...current, activePanelId: panel.id }))}
                            title={panel.resourceId ? `${panel.title} · ${panel.resourceId}` : panel.title}
	                          >
	                            {panel.title}
	                          </button>
	                          {renderProjectEditorViewSwitcher(panel)}
	                          {renderProjectEditorExecuteButton(panel)}
	                        </div>
                        <button
                          type="button"
                          className="workspace-panel-close"
                          onClick={() => setLayout((current) => closePanel(current, panel.id))}
                          title="Close panel"
                          aria-label={`Close ${panel.title}`}
                        >
                          ×
                        </button>
                      </header>
                      <div className="workspace-panel-body">{renderPanel(panel)}</div>
                    </section>
                  </Panel>
                </Fragment>
              ))}
              </PanelGroup>
            )}
          </main>
        </div>
      </div>
      </MethodWorkspaceProvider>
    </ToastProvider>
  );
}
