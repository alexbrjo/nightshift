import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitAppEvent } from "../appEvents";
import { mockInvoke, mockListen } from "../setupTests";
import type { WorkspacePanel } from "../layout";
import { useProjectFiles } from "./useProjectFiles";
import { projectFileReducer } from "./projectFileReducer";

const emptyState = {
  snapshots: {},
  baselines: {},
  hydratingPaths: new Set<string>(),
};

describe("projectFileReducer", () => {
  it("opens tree files while preserving the first disk baseline", () => {
    const opened = projectFileReducer(emptyState, {
      type: "openFromTree",
      path: "notes.md",
      name: "notes.md",
      content: "hello",
      diskContent: "hello",
    });
    const edited = projectFileReducer(opened, {
      type: "updateContent",
      path: "notes.md",
      content: "hello draft",
    });
    const reopened = projectFileReducer(edited, {
      type: "openFromTree",
      path: "notes.md",
      name: "notes.md",
      content: "hello draft",
      diskContent: "hello from disk",
    });

    expect(reopened.snapshots["notes.md"].content).toBe("hello draft");
    expect(reopened.baselines["notes.md"]).toBe("hello");
  });

  it("marks saved files by rebaselining to the current content", () => {
    const opened = projectFileReducer(emptyState, {
      type: "openFromTree",
      path: "notes.md",
      name: "notes.md",
      content: "hello",
      diskContent: "hello",
    });
    const edited = projectFileReducer(opened, {
      type: "updateContent",
      path: "notes.md",
      content: "saved draft",
    });
    const saved = projectFileReducer(edited, { type: "markSaved", path: "notes.md" });

    expect(saved.baselines["notes.md"]).toBe("saved draft");
  });

  it("tracks restored hydration as one state object", () => {
    const hydrating = projectFileReducer(emptyState, { type: "beginHydrating", paths: ["a.md", "b.md"] });

    expect(hydrating.hydratingPaths.has("a.md")).toBe(true);
    expect(hydrating.hydratingPaths.has("b.md")).toBe(true);

    const hydrated = projectFileReducer(hydrating, {
      type: "finishHydratingMany",
      files: [
        {
          path: "a.md",
          baseline: "A",
          snapshot: { path: "a.md", name: "a.md", content: "A", language: "markdown" },
        },
        {
          path: "b.md",
          baseline: "B",
          snapshot: { path: "b.md", name: "b.md", content: "B", language: "markdown" },
        },
      ],
    });

    expect(hydrated.hydratingPaths.size).toBe(0);
    expect(hydrated.snapshots["a.md"].content).toBe("A");
    expect(hydrated.baselines["b.md"]).toBe("B");
  });

  it("clears abandoned hydration paths", () => {
    const hydrating = projectFileReducer(emptyState, { type: "beginHydrating", paths: ["draft.md"] });
    const cancelled = projectFileReducer(hydrating, { type: "cancelHydrating", paths: ["draft.md"] });

    expect(cancelled.hydratingPaths.has("draft.md")).toBe(false);
  });
});

describe("useProjectFiles", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockListen.mockClear();
    mockInvoke.mockImplementation((command: string, args?: { relativePath?: string }) => {
      if (command === "read_file") return Promise.resolve(`${args?.relativePath ?? "file"} content`);
      return Promise.resolve(null);
    });
  });

  it("hydrates restored project editor panels from persisted resource ids", async () => {
    const panels: WorkspacePanel[] = [
      { id: "project-editor:notes.md", type: "project-editor", title: "notes.md", resourceId: "notes.md" },
    ];

    const { result } = renderHook(() => useProjectFiles({ panels, openPanel: vi.fn() }));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("read_file", { relativePath: "notes.md" }));
    await waitFor(() => expect(result.current.fileSnapshots["notes.md"].content).toBe("notes.md content"));
  });

  it("hydrates restored project editor panels concurrently", async () => {
    const pendingReads: Array<{ path: string; resolve: (content: string) => void }> = [];
    const panels: WorkspacePanel[] = [
      { id: "project-editor:first.md", type: "project-editor", title: "first.md", resourceId: "first.md" },
      { id: "project-editor:second.md", type: "project-editor", title: "second.md", resourceId: "second.md" },
    ];
    mockInvoke.mockImplementation((command: string, payload?: { relativePath?: string }) => {
      if (command === "read_file") {
        return new Promise((resolve) => {
          pendingReads.push({ path: payload?.relativePath ?? "", resolve });
        });
      }
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => useProjectFiles({ panels, openPanel: vi.fn() }));

    await waitFor(() => expect(pendingReads.map((read) => read.path).sort()).toEqual(["first.md", "second.md"]));
    act(() => pendingReads.forEach((read) => read.resolve(`${read.path} content`)));

    await waitFor(() => {
      expect(result.current.fileSnapshots["first.md"].content).toBe("first.md content");
      expect(result.current.fileSnapshots["second.md"].content).toBe("second.md content");
    });
  });

  it("opens and reloads the current Method file after draft mutation events", async () => {
    let currentMethodReadCount = 0;
    const openPanel = vi.fn();
    mockInvoke.mockImplementation((command: string) => {
      if (command === "read_file") {
        currentMethodReadCount += 1;
        return Promise.resolve(currentMethodReadCount === 1 ? "label: Draft" : "label: Updated draft");
      }
      return Promise.resolve(null);
    });
    const { result } = renderHook(() => useProjectFiles({ panels: [], openPanel }));

    act(() => emitAppEvent("methodDraftMutated"));

    await waitFor(() => expect(openPanel).toHaveBeenCalledWith("project-editor", {
      resourceId: "methods/current.method.yaml",
      title: "current.method.yaml",
      viewMode: "methodGraph",
    }));
    await waitFor(() => {
      expect(result.current.fileSnapshots["methods/current.method.yaml"].content).toBe("label: Draft");
      expect(result.current.fileTreeRefreshKey).toBe(1);
    });

    act(() => emitAppEvent("methodDraftMutated"));

    await waitFor(() => {
      expect(result.current.fileSnapshots["methods/current.method.yaml"].content).toBe("label: Updated draft");
      expect(mockInvoke.mock.calls.filter(([command]) => command === "read_file")).toHaveLength(2);
    });
  });
});
