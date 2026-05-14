import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("uses an empty getting-started workspace as the default layout without cached state", () => {
    render(<App />);

    expect(workspacePanelTitles()).toEqual([]);
    expect(screen.getByText("Let's get started!")).toBeInTheDocument();
    expect(document.querySelector(".workspace-empty-state-image")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a new chat" })).toBeInTheDocument();
    expect(screen.queryByText("Planning Chat")).not.toBeInTheDocument();
  });

  it("mounts one shared Method workspace event controller for Chat and Method Graph panels", async () => {
    render(<App />);

    await waitFor(() => expect(mockListen).toHaveBeenCalled());
    expect(mockListen.mock.calls.filter(([eventName]) => eventName === "codex-app-server-event")).toHaveLength(1);
    expect(mockListen.mock.calls.filter(([eventName]) => eventName === "method-draft-updated")).toHaveLength(1);
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

    await waitFor(() => expect(workspacePanelTitles()).toEqual(["Execution: edge.method.yaml"]));
    expect(mockInvoke).toHaveBeenCalledWith("execute_method_file", { methodPath: "methods/edge.method.yaml" });
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
