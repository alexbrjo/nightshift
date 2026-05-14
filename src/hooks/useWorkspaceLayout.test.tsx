import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mockInvoke, mockListen } from "../setupTests";
import { createPanel, serializeWorkspaceLayout } from "../layout";
import { useWorkspaceLayout } from "./useWorkspaceLayout";

describe("useWorkspaceLayout", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockListen.mockClear();
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve("/tmp/project");
        case "load_last_folder":
          return Promise.resolve(null);
        case "set_root_path":
        case "save_project_layout":
          return Promise.resolve(null);
        case "load_project_layout":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initializes the saved project root when no root is open", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "get_root_path":
          return Promise.resolve(null);
        case "load_last_folder":
          return Promise.resolve("/tmp/project");
        case "set_root_path":
        case "save_project_layout":
        case "load_project_layout":
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });

    renderHook(() => useWorkspaceLayout());

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("set_root_path", { path: "/tmp/project" }));
  });

  it("restores a valid project layout", async () => {
    const restoredLayout = JSON.parse(
      serializeWorkspaceLayout({
        schemaVersion: 1,
        sidebarMode: "collapsed",
        activeResourceKind: "job",
        panels: [{ id: "job-view:7", type: "job-view", title: "Job #7", resourceId: "7" }],
        activePanelId: "job-view:7",
        splitSizes: [100],
      }),
    );
    mockInvoke.mockImplementation((command: string) => {
      if (command === "load_project_layout") return Promise.resolve(restoredLayout);
      if (command === "get_root_path") return Promise.resolve("/tmp/project");
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => useWorkspaceLayout());

    await waitFor(() => expect(result.current.layout.panels).toHaveLength(1));
    expect(result.current.layout.panels[0].title).toBe("Job #7");
    expect(result.current.layout.sidebarMode).toBe("collapsed");
  });

  it("falls back to defaults for an invalid project layout", async () => {
    mockInvoke.mockImplementation((command: string) => {
      if (command === "load_project_layout") return Promise.resolve({ schemaVersion: 99, panels: [] });
      if (command === "get_root_path") return Promise.resolve("/tmp/project");
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => useWorkspaceLayout());

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("load_project_layout"));
    expect(result.current.layout.panels).toEqual([]);
    expect(result.current.layout.activeResourceKind).toBe("conversation");
  });

  it("debounces project layout saves across rapid layout changes", async () => {
    const { result } = renderHook(() => useWorkspaceLayout());

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("load_project_layout"));
    vi.useFakeTimers();
    mockInvoke.mockClear();

    act(() => {
      result.current.setActiveResourceKind("method");
      result.current.setActiveResourceKind("project");
      result.current.setActiveResourceKind("job");
    });

    act(() => vi.advanceTimersByTime(299));
    expect(mockInvoke.mock.calls.filter(([command]) => command === "save_project_layout")).toHaveLength(0);

    act(() => vi.advanceTimersByTime(1));
    expect(mockInvoke.mock.calls.filter(([command]) => command === "save_project_layout")).toHaveLength(1);
  });

  it("preserves the active resource tab when a project-opened reset has no saved layout", async () => {
    const { result } = renderHook(() => useWorkspaceLayout());
    await waitFor(() => expect(mockInvoke.mock.calls.some(([command]) => command === "load_project_layout")).toBe(true));

    act(() => result.current.setActiveResourceKind("project"));
    expect(result.current.layout.activeResourceKind).toBe("project");

    const projectOpenedHandlers = mockListen.mock.calls
      .filter(([eventName]) => eventName === "project-opened")
      .map(([, handler]) => handler as (event: { payload: string }) => void);

    await act(async () => {
      projectOpenedHandlers.forEach((handler) => handler({ payload: "/tmp/project" }));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.layout.activeResourceKind).toBe("project"));
  });

  it("opens, focuses, replaces, and closes panels", async () => {
    const { result } = renderHook(() => useWorkspaceLayout());
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("load_project_layout"));

    act(() => {
      result.current.openPanel("chat", { resourceId: "chat-one", title: "First chat" });
      result.current.openPanel("chat", { resourceId: "chat-one", title: "Renamed chat" });
    });

    expect(result.current.layout.panels).toHaveLength(1);
    expect(result.current.layout.panels[0].title).toBe("Renamed chat");

    const jobPanel = createPanel("job-view", { resourceId: 77, title: "Job #77" });
    act(() => result.current.replacePanelWithPanel(result.current.layout.panels[0].id, jobPanel));

    expect(result.current.layout.panels.map((panel) => panel.title)).toEqual(["Job #77"]);

    act(() => result.current.closeWorkspacePanel(jobPanel.id));

    expect(result.current.layout.panels).toEqual([]);
  });
});
