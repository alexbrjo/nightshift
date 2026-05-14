import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { mockInvoke, mockListen } from "./setupTests";
import App from "./App";
import { serializeWorkspaceLayout } from "./layout";

function workspacePanelTitles() {
  return Array.from(document.querySelectorAll(".workspace-panel-title")).map((element) => element.textContent);
}

describe("App workspace shell", () => {
  let projectLayout: unknown | null;
  let projectConversations: unknown | null;

  beforeEach(() => {
    projectLayout = null;
    projectConversations = null;
    mockInvoke.mockReset();
    mockListen.mockClear();
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve("/tmp/project");
        case "load_last_folder":
          return Promise.resolve(null);
        case "set_root_path":
          return Promise.resolve(null);
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "send_design_chat_message":
          return Promise.resolve({ threadId: "thr_123", turnId: "turn_456" });
        case "get_design_agent_config":
          return Promise.resolve({ model: "gpt-5.5", reasoningSummary: "auto", maxToolLoops: 20 });
        case "load_project_layout":
          return Promise.resolve(projectLayout);
        case "save_project_layout":
          return Promise.resolve(null);
        case "load_project_conversations":
          return Promise.resolve(projectConversations);
        case "save_project_conversations":
          return Promise.resolve(null);
        case "get_current_method_draft":
          return Promise.resolve(null);
        case "read_file":
          return Promise.resolve("restored file content");
        case "scan_folder":
          return Promise.resolve({ name: "project", children: [] });
        case "list_method_executions":
        case "get_execution_method":
        case "get_method_execution_nodes":
        case "get_method_execution_events":
        case "list_inference_jobs":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders unified resource buttons", () => {
    render(<App />);

    expect(screen.getByRole("button", { name: "Conversations" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Methods" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collections" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jobs" })).toBeInTheDocument();
  });

  it("uses an empty getting-started workspace as the default layout without cached state", () => {
    render(<App />);

    expect(workspacePanelTitles()).toEqual([]);
    expect(screen.getByText("Let's get started!")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a new chat" })).toBeInTheDocument();
    expect(screen.queryByText("Planning Chat")).not.toBeInTheDocument();
  });

  it("initializes the saved project root when the app opens", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve(null);
        case "load_last_folder":
          return Promise.resolve("/tmp/project");
        case "set_root_path":
          return Promise.resolve(null);
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_design_agent_config":
          return Promise.resolve({ model: "gpt-5.5", reasoningSummary: "auto", maxToolLoops: 20 });
        case "load_project_layout":
        case "load_project_conversations":
        case "save_project_layout":
        case "save_project_conversations":
          return Promise.resolve(null);
        case "get_current_method_draft":
          return Promise.resolve(null);
        case "list_method_executions":
        case "get_execution_method":
        case "get_method_execution_nodes":
        case "get_method_execution_events":
        case "list_inference_jobs":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });

    render(<App />);

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("set_root_path", { path: "/tmp/project" }));
  });

  it("does not list welcome-only conversation files as chat resources", async () => {
    projectConversations = [
      {
        id: "chat-welcome",
        title: "New planning chat",
        createdAt: "2026-05-13T00:00:00Z",
        updatedAt: "2026-05-13T00:00:00Z",
        messages: [{ id: "welcome", role: "assistant", text: "Describe the Method you want to design." }],
      },
      {
        id: "chat-real",
        title: "Real benchmark plan",
        createdAt: "2026-05-13T00:00:00Z",
        updatedAt: "2026-05-13T00:00:00Z",
        messages: [{ id: "user-1", role: "user", text: "Plan the benchmark." }],
      },
    ];

    render(<App />);

    expect(await screen.findByText("Real benchmark plan")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a new chat" })).toBeInTheDocument();
    expect(screen.queryByText("New planning chat")).not.toBeInTheDocument();
  });

  it("mounts one shared Method workspace event controller for Chat and Method Graph panels", async () => {
    render(<App />);

    await waitFor(() => expect(mockListen).toHaveBeenCalled());
    expect(mockListen.mock.calls.filter(([eventName]) => eventName === "codex-app-server-event")).toHaveLength(1);
    expect(mockListen.mock.calls.filter(([eventName]) => eventName === "method-draft-updated")).toHaveLength(1);
  });

  it("shows only empty copy in empty Method resources", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Methods" }));

    expect(await screen.findByText("Open Method source files from the project tree.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create a new Method" })).not.toBeInTheDocument();
    expect(screen.queryByText("Current Method Graph")).not.toBeInTheDocument();
  });

  it("opens a Method source file in the project file editor Method graph view", async () => {
    const methodYaml = [
      "schema_version: 2",
      "id: generated-method",
      "title: Generated Method",
      "objective: Render graph",
      "workflow:",
      "  nodes:",
      "    - id: generate",
      "      label: Generate",
      "      type: inference",
      "      config: {}",
      "parameters: {}",
      "provider: {}",
      "outputs: []",
      "metadata: {}",
    ].join("\n");
    projectLayout = JSON.parse(
      serializeWorkspaceLayout({
        schemaVersion: 1,
        sidebarMode: "expanded",
        activeResourceKind: "project",
        panels: [
          {
            id: "project-editor:methods%2Fgenerated.method.yaml",
            type: "project-editor",
            title: "generated.method.yaml",
            resourceId: "methods/generated.method.yaml",
            viewMode: "methodGraph",
          },
        ],
        activePanelId: "project-editor:methods%2Fgenerated.method.yaml",
        splitSizes: [100],
      }),
    );
    mockInvoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "read_file") {
        expect(args).toEqual({ relativePath: "methods/generated.method.yaml" });
        return Promise.resolve(methodYaml);
      }
      switch (command) {
        case "get_root_path":
          return Promise.resolve("/tmp/project");
        case "load_project_layout":
          return Promise.resolve(projectLayout);
        case "load_project_conversations":
        case "get_current_method_draft":
          return Promise.resolve(null);
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_design_agent_config":
          return Promise.resolve({ model: "gpt-5.5", reasoningSummary: "auto", maxToolLoops: 20 });
        case "save_project_layout":
        case "save_project_conversations":
          return Promise.resolve(null);
        case "scan_folder":
          return Promise.resolve({ name: "project", children: [] });
        case "list_method_executions":
        case "get_execution_method":
        case "get_method_execution_nodes":
        case "get_method_execution_events":
        case "list_inference_jobs":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });

    render(<App />);

    expect(await screen.findByTestId("method-graph-preview")).toBeInTheDocument();
    expect(screen.getByText("Generate")).toBeInTheDocument();
    expect(workspacePanelTitles()).toContain("generated.method.yaml");
  });

  it("expands and collapses the resource sidebar", () => {
    render(<App />);

    expect(document.querySelector(".resource-sidebar-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Collapse resource sidebar" }));
    expect(document.querySelector(".resource-sidebar-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand resource sidebar" }));
    expect(document.querySelector(".resource-sidebar-panel")).toBeInTheDocument();
  });

  it("collapses the open resource sidebar when clicking the active nav icon", () => {
    render(<App />);

    expect(screen.getByRole("button", { name: "Conversations" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".resource-sidebar-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    expect(screen.getByRole("button", { name: "Conversations" })).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector(".resource-sidebar-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    expect(screen.getByRole("button", { name: "Conversations" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".resource-sidebar-panel")).toBeInTheDocument();
  });

  it("keeps the selected resource tab when project initialization has no saved layout", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    expect(screen.getByRole("heading", { name: "Project" })).toBeInTheDocument();

    const projectOpenedHandlers = mockListen.mock.calls
      .filter(([eventName]) => eventName === "project-opened")
      .map(([, handler]) => handler as (event: { payload: string }) => void);
    expect(projectOpenedHandlers.length).toBeGreaterThan(0);
    await act(async () => {
      projectOpenedHandlers.forEach((handler) => handler({ payload: "/tmp/project" }));
    });

    await waitFor(() => expect(screen.getByRole("heading", { name: "Project" })).toBeInTheDocument());
  });

  it("shows the project folder name right in the Project header", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve("/tmp/project");
        case "load_last_folder":
          return Promise.resolve("/tmp/project");
        case "set_root_path":
        case "save_project_layout":
        case "save_project_conversations":
          return Promise.resolve(null);
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_design_agent_config":
          return Promise.resolve({ model: "gpt-5.5", reasoningSummary: "auto", maxToolLoops: 20 });
        case "load_project_layout":
        case "load_project_conversations":
        case "get_current_method_draft":
          return Promise.resolve(null);
        case "scan_folder":
          return Promise.resolve({ name: "project", children: [] });
        case "list_method_executions":
        case "get_method_execution_nodes":
        case "get_method_execution_events":
        case "list_inference_jobs":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    const folderLabel = await screen.findByLabelText("Project folder: project");

    expect(folderLabel).toHaveClass("resource-sidebar-context");
    expect(folderLabel).toHaveAttribute("title", "project");
    expect(screen.getByRole("heading", { name: "Project" })).toBeInTheDocument();
  });

  it("restores a valid project layout", async () => {
    projectLayout = JSON.parse(
      serializeWorkspaceLayout({
        schemaVersion: 1,
        sidebarMode: "collapsed",
        activeResourceKind: "job",
        panels: [
          { id: "job-view:7", type: "job-view", title: "Job #7", resourceId: "7" },
        ],
        activePanelId: "job-view:7",
        splitSizes: [100],
      }),
    );

    render(<App />);

    await waitFor(() => expect(workspacePanelTitles()).toEqual(["Job #7"]));
    expect(document.querySelector(".resource-sidebar-panel")).not.toBeInTheDocument();
  });

  it("debounces project layout saves across rapid layout changes", async () => {
    vi.useFakeTimers();
    render(<App />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockInvoke).toHaveBeenCalledWith("load_project_layout");
    mockInvoke.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Methods" }));
    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    fireEvent.click(screen.getByRole("button", { name: "Jobs" }));

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(mockInvoke.mock.calls.filter(([command]) => command === "save_project_layout")).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mockInvoke.mock.calls.filter(([command]) => command === "save_project_layout")).toHaveLength(1);
  });

  it("hydrates restored project editor panels from their persisted resource id", async () => {
    projectLayout = JSON.parse(
      serializeWorkspaceLayout({
        schemaVersion: 1,
        sidebarMode: "expanded",
        activeResourceKind: "project",
        panels: [
          { id: "project-editor:notes.md", type: "project-editor", title: "notes.md", resourceId: "notes.md" },
        ],
        activePanelId: "project-editor:notes.md",
        splitSizes: [100],
      }),
    );

    render(<App />);

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("read_file", { relativePath: "notes.md" }));
    expect(await screen.findByText("restored file content")).toBeInTheDocument();
  });

  it("shows Markdown view controls and persists the selected editor view", async () => {
    projectLayout = JSON.parse(
      serializeWorkspaceLayout({
        schemaVersion: 1,
        sidebarMode: "expanded",
        activeResourceKind: "project",
        panels: [
          { id: "project-editor:README.md", type: "project-editor", title: "README.md", resourceId: "README.md" },
        ],
        activePanelId: "project-editor:README.md",
        splitSizes: [100],
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: "Show Code for README.md" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Show Markdown preview for README.md" }));
    expect(screen.getByTestId("markdown-preview")).toBeInTheDocument();

    mockInvoke.mockClear();

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("save_project_layout", {
        layout: expect.objectContaining({
          panels: [
            expect.objectContaining({
              id: "project-editor:README.md",
              viewMode: "markdown",
            }),
          ],
        }),
      });
    });
  });

  it("hides view controls for non-previewable project files", async () => {
    projectLayout = JSON.parse(
      serializeWorkspaceLayout({
        schemaVersion: 1,
        sidebarMode: "expanded",
        activeResourceKind: "project",
        panels: [
          { id: "project-editor:src%2Fcode.js", type: "project-editor", title: "code.js", resourceId: "src/code.js" },
        ],
        activePanelId: "project-editor:src%2Fcode.js",
        splitSizes: [100],
      }),
    );

    render(<App />);

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("read_file", { relativePath: "src/code.js" }));
    expect(screen.queryByRole("group", { name: "View options for code.js" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show Code for code.js" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show Markdown preview for code.js" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show Method graph for code.js" })).not.toBeInTheDocument();
  });

  it("renders a Method graph from the open YAML buffer", async () => {
    const methodYaml = [
      "schema_version: 2",
      "id: edge-method",
      "title: Edge Method",
      "objective: Render graph",
      "workflow:",
      "  nodes:",
      "    - id: generate",
      "      label: Generate",
      "      type: inference",
      "      config: {}",
      "parameters: {}",
      "provider: {}",
      "outputs: []",
      "metadata: {}",
    ].join("\n");
    projectLayout = JSON.parse(
      serializeWorkspaceLayout({
        schemaVersion: 1,
        sidebarMode: "expanded",
        activeResourceKind: "project",
        panels: [
          {
            id: "project-editor:methods%2Fedge.method.yaml",
            type: "project-editor",
            title: "edge.method.yaml",
            resourceId: "methods/edge.method.yaml",
          },
        ],
        activePanelId: "project-editor:methods%2Fedge.method.yaml",
        splitSizes: [100],
      }),
    );
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve("/tmp/project");
        case "load_project_layout":
          return Promise.resolve(projectLayout);
        case "read_file":
          return Promise.resolve(methodYaml);
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_design_agent_config":
          return Promise.resolve({ model: "gpt-5.5", reasoningSummary: "auto", maxToolLoops: 20 });
        case "load_project_conversations":
        case "save_project_layout":
        case "save_project_conversations":
        case "get_current_method_draft":
          return Promise.resolve(null);
        case "scan_folder":
          return Promise.resolve({ name: "project", children: [] });
        case "list_method_executions":
        case "get_method_execution_nodes":
        case "get_method_execution_events":
        case "list_inference_jobs":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Show Method graph for edge.method.yaml" }));

    expect(await screen.findByTestId("method-graph-preview")).toBeInTheDocument();
    expect(screen.getByText("Generate")).toBeInTheDocument();
  });

  it("offers Method graph for YAML files beyond method manifests", async () => {
    const methodYaml = [
      "schema_version: 2",
      "id: loose-method",
      "title: Loose Method",
      "objective: Render graph",
      "workflow:",
      "  nodes:",
      "    - id: inspect",
      "      label: Inspect",
      "      type: analysis",
      "      config: {}",
      "parameters: {}",
      "provider: {}",
    ].join("\n");
    projectLayout = JSON.parse(
      serializeWorkspaceLayout({
        schemaVersion: 1,
        sidebarMode: "expanded",
        activeResourceKind: "project",
        panels: [
          {
            id: "project-editor:experiments%2Floose.yaml",
            type: "project-editor",
            title: "loose.yaml",
            resourceId: "experiments/loose.yaml",
          },
        ],
        activePanelId: "project-editor:experiments%2Floose.yaml",
        splitSizes: [100],
      }),
    );
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve("/tmp/project");
        case "load_project_layout":
          return Promise.resolve(projectLayout);
        case "read_file":
          return Promise.resolve(methodYaml);
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_design_agent_config":
          return Promise.resolve({ model: "gpt-5.5", reasoningSummary: "auto", maxToolLoops: 20 });
        case "load_project_conversations":
        case "save_project_layout":
        case "save_project_conversations":
        case "get_current_method_draft":
          return Promise.resolve(null);
        case "scan_folder":
          return Promise.resolve({ name: "project", children: [] });
        case "list_method_executions":
        case "get_method_execution_nodes":
        case "get_method_execution_events":
        case "list_inference_jobs":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Show Method graph for loose.yaml" }));

    expect(await screen.findByTestId("method-graph-preview")).toBeInTheDocument();
    expect(screen.getByText("Inspect")).toBeInTheDocument();
  });

  it("shows an inline Method graph error for invalid Method YAML", async () => {
    projectLayout = JSON.parse(
      serializeWorkspaceLayout({
        schemaVersion: 1,
        sidebarMode: "expanded",
        activeResourceKind: "project",
        panels: [
          {
            id: "project-editor:methods%2Fedge.method.yaml",
            type: "project-editor",
            title: "edge.method.yaml",
            resourceId: "methods/edge.method.yaml",
          },
        ],
        activePanelId: "project-editor:methods%2Fedge.method.yaml",
        splitSizes: [100],
      }),
    );

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Show Method graph for edge.method.yaml" }));

    expect(await screen.findByText("Method graph unavailable")).toBeInTheDocument();
    expect(screen.getByText("This file is not a valid Method document.")).toBeInTheDocument();
  });

  it("hydrates restored project editor panels concurrently", async () => {
    const pendingReads: Array<{ path: string; resolve: (content: string) => void }> = [];
    projectLayout = JSON.parse(
      serializeWorkspaceLayout({
        schemaVersion: 1,
        sidebarMode: "expanded",
        activeResourceKind: "project",
        panels: [
          { id: "project-editor:first.md", type: "project-editor", title: "first.md", resourceId: "first.md" },
          { id: "project-editor:second.md", type: "project-editor", title: "second.md", resourceId: "second.md" },
        ],
        activePanelId: "project-editor:first.md",
        splitSizes: [50, 50],
      }),
    );
    mockInvoke.mockImplementation((command: string, payload?: { relativePath?: string }) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve("/tmp/project");
        case "load_project_layout":
          return Promise.resolve(projectLayout);
        case "read_file":
          return new Promise((resolve) => {
            pendingReads.push({ path: payload?.relativePath ?? "", resolve });
          });
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_design_agent_config":
          return Promise.resolve({ model: "gpt-5.5", reasoningSummary: "auto", maxToolLoops: 20 });
        case "load_project_conversations":
        case "save_project_layout":
        case "save_project_conversations":
        case "get_current_method_draft":
          return Promise.resolve(null);
        case "scan_folder":
          return Promise.resolve({ name: "project", children: [] });
        case "list_method_executions":
        case "get_method_execution_nodes":
        case "get_method_execution_events":
        case "list_inference_jobs":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });

    render(<App />);

    await waitFor(() => expect(pendingReads.map((read) => read.path).sort()).toEqual(["first.md", "second.md"]));
    act(() => {
      pendingReads.forEach((read) => read.resolve(`${read.path} content`));
    });

    expect(await screen.findByText("first.md content")).toBeInTheDocument();
    expect(await screen.findByText("second.md content")).toBeInTheDocument();
  });

  it("executes a parsed Method source file from the project editor header", async () => {
    const methodYaml = [
      "schema_version: 2",
      "id: edge-method",
      "title: Edge method",
      "objective: Measure accuracy",
      "workflow:",
      "  nodes:",
      "    - id: generate",
      "      label: Generate",
      "      type: inference",
      "      config: {}",
      "parameters: {}",
      "provider: {}",
      "outputs: []",
      "metadata: {}",
    ].join("\n");
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve("/tmp/project");
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_design_agent_config":
          return Promise.resolve({ model: "gpt-5.5", reasoningSummary: "auto", maxToolLoops: 20 });
        case "load_project_layout":
          return Promise.resolve({
            schemaVersion: 1,
            sidebarMode: "expanded",
            activeResourceKind: "project",
            panels: [{
              id: "project-editor:methods%2Fedge.method.yaml",
              type: "project-editor",
              title: "edge.method.yaml",
              resourceId: "methods/edge.method.yaml",
              viewMode: "methodGraph",
            }],
            activePanelId: "project-editor:methods%2Fedge.method.yaml",
            splitSizes: [100],
          });
        case "load_project_conversations":
          return Promise.resolve(null);
        case "save_project_layout":
        case "save_project_conversations":
          return Promise.resolve(null);
        case "read_file":
          return Promise.resolve(methodYaml);
        case "execute_method_file":
          return Promise.resolve({
            id: 42,
            methodId: "edge-method",
            methodContentHash: "hash",
            status: "queued",
            createdAt: "2026-05-13T00:00:00Z",
          });
        case "list_method_executions":
          return Promise.resolve([{ id: 42, methodId: "edge-method", methodContentHash: "hash", status: "running", createdAt: "2026-05-13T00:00:00Z" }]);
        case "get_execution_method":
          return Promise.resolve({
            schema_version: 2,
            id: "edge-method",
            title: "Edge method",
            objective: "Measure accuracy",
            workflow: { nodes: [{ id: "generate", label: "Generate", type: "inference", config: {} }] },
            parameters: {},
            provider: {},
            outputs: [],
            metadata: {},
          });
        case "get_method_execution_nodes":
          return Promise.resolve([{ id: 1, executionId: 42, nodeId: "generate", nodeType: "inference", status: "running" }]);
        case "list_inference_jobs":
        case "get_current_method_draft":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Execute edge.method.yaml" }));

    await waitFor(() => expect(workspacePanelTitles()).toContain("Execution: edge.method.yaml"));
    expect(mockInvoke).toHaveBeenCalledWith("execute_method_file", { methodPath: "methods/edge.method.yaml" });
  });

  it("discards invalid project layout and falls back to defaults", async () => {
    projectLayout = { schemaVersion: 99, panels: [] };

    render(<App />);

    await waitFor(() => expect(workspacePanelTitles()).toEqual([]));
    expect(screen.getByText("Let's get started!")).toBeInTheDocument();
  });

  it("focuses existing panels instead of duplicating them", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Create a new chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Create a new chat" }));

    expect(workspacePanelTitles().filter((title) => title === "Chat")).toHaveLength(1);
  });

  it("returns to the getting-started workspace when the last panel closes", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Create a new chat" }));
    expect(workspacePanelTitles()).toContain("Chat");
    fireEvent.click(screen.getByRole("button", { name: "Close Chat" }));
    expect(workspacePanelTitles()).toEqual([]);
    expect(screen.getByText("Let's get started!")).toBeInTheDocument();
  });

  it("opens selected conversations as distinct chat panels", async () => {
    projectConversations = [
      {
        id: "chat-one",
        title: "First conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [{ id: "m1", role: "user", text: "First conversation text", status: "completed" }],
      },
      {
        id: "chat-two",
        title: "Second conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [{ id: "m2", role: "user", text: "Second conversation text", status: "completed" }],
      },
    ];

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "First conversation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Second conversation" }));

    expect(workspacePanelTitles()).toContain("First conversation");
    expect(workspacePanelTitles()).toContain("Second conversation");
    expect((await screen.findAllByText("First conversation text")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Second conversation text")).length).toBeGreaterThan(0);
  });

  it("preserves saved chat composer drafts when panels remount", async () => {
    projectConversations = [
      {
        id: "chat-one",
        title: "First conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [{ id: "m1", role: "user", text: "First conversation text", status: "completed" }],
      },
      {
        id: "chat-two",
        title: "Second conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [{ id: "m2", role: "user", text: "Second conversation text", status: "completed" }],
      },
    ];

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "First conversation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Second conversation" }));

    const firstPanel = await screen.findByRole("region", { name: "First conversation" });
    const secondPanel = await screen.findByRole("region", { name: "Second conversation" });
    fireEvent.change(within(firstPanel).getByPlaceholderText(/Describe or refine/i), {
      target: { value: "Keep this first draft" },
    });
    fireEvent.change(within(secondPanel).getByPlaceholderText(/Describe or refine/i), {
      target: { value: "Different second draft" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Close First conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "First conversation" }));

    const reopenedFirstPanel = await screen.findByRole("region", { name: "First conversation" });
    expect(within(reopenedFirstPanel).getByPlaceholderText(/Describe or refine/i)).toHaveValue("Keep this first draft");
    expect(within(secondPanel).getByPlaceholderText(/Describe or refine/i)).toHaveValue("Different second draft");
  });

  it("lets reopened conversations continue and expands their tool call details", async () => {
    projectConversations = [
      {
        id: "chat-one",
        title: "First conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [
          { id: "m1", role: "user", text: "First conversation text", status: "completed" },
          {
            id: "tool-1",
            role: "trace",
            text: "replace_method_draft_graph completed - 42 ms - Draft updated",
            status: "completed",
            traceKind: "tool",
            toolName: "replace_method_draft_graph",
            durationMs: 42,
            outputSummary: "Draft updated",
            toolArguments: { workflow: { nodes: [{ id: "generate" }] } },
            toolOutput: { ok: true },
          },
        ],
      },
    ];

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "First conversation" }));
    const panel = await screen.findByRole("region", { name: "First conversation" });
    const scoped = within(panel);

    fireEvent.click(scoped.getByText("1 tool call"));
    expect(scoped.getByText("replace_method_draft_graph")).toBeInTheDocument();
    expect(scoped.getByText("Parameters")).toBeInTheDocument();
    expect(scoped.getByText("Output")).toBeInTheDocument();
    expect(scoped.getByText("Draft updated")).toBeInTheDocument();

    const input = scoped.getByPlaceholderText(/Describe or refine/i);
    fireEvent.change(input, { target: { value: "Continue from here" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("send_design_chat_message", {
        input: {
          message: expect.stringContaining("First conversation text"),
        },
      });
      expect(mockInvoke).toHaveBeenCalledWith("send_design_chat_message", {
        input: {
          message: expect.stringContaining("Continue from here"),
        },
      });
    });
  });

  it("opens the current Method source render view and refreshes project files after agent Method mutations", async () => {
    const methodYaml = [
      "schema_version: 2",
      "id: current-method",
      "title: Current Method",
      "objective: Render graph",
      "workflow:",
      "  nodes:",
      "    - id: draft",
      "      label: Draft",
      "      type: analysis",
      "      config: {}",
      "parameters: {}",
      "provider: {}",
    ].join("\n");
    const updatedMethodYaml = methodYaml.replace("label: Draft", "label: Updated draft");
    let currentMethodReadCount = 0;
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve("/tmp/project");
        case "load_last_folder":
          return Promise.resolve("/tmp/project");
        case "set_root_path":
        case "save_project_layout":
        case "save_project_conversations":
          return Promise.resolve(null);
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_design_agent_config":
          return Promise.resolve({ model: "gpt-5.5", reasoningSummary: "auto", maxToolLoops: 20 });
        case "read_file":
          currentMethodReadCount += 1;
          return Promise.resolve(currentMethodReadCount === 1 ? methodYaml : updatedMethodYaml);
        case "load_project_layout":
        case "load_project_conversations":
        case "get_current_method_draft":
          return Promise.resolve(null);
        case "scan_folder":
          return Promise.resolve({ name: "project", children: [] });
        case "list_method_executions":
        case "get_method_execution_nodes":
        case "get_method_execution_events":
        case "list_inference_jobs":
          return Promise.resolve([]);
        default:
          return Promise.resolve(null);
      }
    });

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("scan_folder", { path: "/tmp/project" }));
    const scanCallsBefore = mockInvoke.mock.calls.filter(([command]) => command === "scan_folder").length;

    act(() => {
      window.dispatchEvent(new CustomEvent("nightshift-project-files-changed"));
      window.dispatchEvent(new CustomEvent("nightshift-method-draft-mutated"));
    });

    await waitFor(() => {
      expect(workspacePanelTitles()).toContain("current.method.yaml");
      expect(mockInvoke.mock.calls.filter(([command]) => command === "scan_folder").length)
        .toBeGreaterThan(scanCallsBefore);
    });
    expect(await screen.findByTestId("method-graph-preview")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent("nightshift-method-draft-mutated"));
    });

    expect(await screen.findByText("Updated draft")).toBeInTheDocument();
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
    expect(mockInvoke.mock.calls.filter(([command]) => command === "read_file")).toHaveLength(2);
  });

  it("opens a new job panel from the unified job resources", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("list_inference_jobs", { page: 1, pageSize: 50 }));
    fireEvent.click(screen.getByRole("button", { name: "Create a new job" }));

    expect(workspacePanelTitles()).toContain("New Job");
  });

  it("replaces the new job panel with the created job panel", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve("/tmp/project");
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "get_design_agent_config":
          return Promise.resolve({ model: "gpt-5.5", reasoningSummary: "auto", maxToolLoops: 20 });
        case "load_project_layout":
          return Promise.resolve(null);
        case "save_project_layout":
          return Promise.resolve(null);
        case "load_project_conversations":
          return Promise.resolve(null);
        case "save_project_conversations":
          return Promise.resolve(null);
        case "get_current_method_draft":
          return Promise.resolve(null);
        case "list_method_executions":
        case "get_method_execution_nodes":
        case "get_method_execution_events":
        case "list_inference_jobs":
        case "list_prompt_files":
        case "list_data_files":
        case "list_schema_files":
        case "list_transform_scripts":
          return Promise.resolve([]);
        case "check_transform_runtime":
          return Promise.resolve(null);
        case "create_inference_job":
          return Promise.resolve(77);
        default:
          return Promise.resolve(null);
      }
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Jobs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create a new job" }));
    fireEvent.change(await screen.findByLabelText(/Job Name/), { target: { value: "Created job" } });
    fireEvent.change(screen.getByLabelText(/Prompt Spec/), { target: { value: "prompt.txt" } });
    fireEvent.change(screen.getByLabelText(/Data Source/), { target: { value: "data.jsonl" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Inference Job" }));

    await waitFor(() => expect(workspacePanelTitles()).toContain("Job #77"));
    expect(workspacePanelTitles()).not.toContain("New Job");
  });
});
