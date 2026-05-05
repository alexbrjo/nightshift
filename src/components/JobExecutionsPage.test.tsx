import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockInvoke } from "../setupTests";
import JobExecutionsPage from "./JobExecutionsPage";
import { ToastProvider } from "./Toast";

function exec(id: number, status = "completed") {
  return {
    id,
    definitionVersionId: 7,
    parentId: null,
    rootId: id,
    status,
    plan: null,
    ledger: null,
    cancellationRequested: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
    createdAt: new Date(Date.now() - id * 60_000).toISOString(),
  };
}

function root(id: number) {
  return {
    id,
    parentId: null,
    rootId: id,
    name: `def-${id}`,
    position: 0,
    currentVersionId: 1,
    source: "user",
    deletedAt: null,
    createdAt: "",
    updatedAt: "",
    currentKind: "group",
  };
}

describe("JobExecutionsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables + Start execution until a definition is selected", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "definition_list_roots") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    render(
      <ToastProvider>
        <JobExecutionsPage />
      </ToastProvider>,
    );
    const start = await screen.findByRole("button", { name: /\+ Start execution/i });
    expect(start).toBeDisabled();
  });

  it("loads executions for the selected definition", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "definition_list_roots") {
        return Promise.resolve([root(1)]);
      }
      if (cmd === "execution_list_for_definition") {
        const a = args as { defId: number };
        if (a.defId === 1) return Promise.resolve([exec(101), exec(100)]);
        return Promise.resolve([]);
      }
      if (cmd === "execution_get") return Promise.resolve(exec(101, "running"));
      if (cmd === "execution_get_tree") return Promise.resolve([]);
      if (cmd === "execution_get_collection") return Promise.resolve([]);
      if (cmd === "execution_get_ledger") return Promise.resolve(null);
      return Promise.resolve();
    });

    render(
      <ToastProvider>
        <JobExecutionsPage />
      </ToastProvider>,
    );

    const defNode = await screen.findByText("def-1");
    fireEvent.click(defNode);

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "execution_list_for_definition",
        expect.objectContaining({ defId: 1 }),
      ),
    );
    expect(await screen.findByText("execution 101")).toBeInTheDocument();
    expect(screen.getByText("execution 100")).toBeInTheDocument();
  });

  it("starts a new execution via experiment_start when the button is clicked", async () => {
    mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "definition_list_roots") return Promise.resolve([root(1)]);
      if (cmd === "execution_list_for_definition") return Promise.resolve([]);
      if (cmd === "experiment_start") {
        const a = args as { rootDefId: number };
        expect(a.rootDefId).toBe(1);
        return Promise.resolve(202);
      }
      if (cmd === "execution_get") return Promise.resolve(exec(202, "running"));
      if (cmd === "execution_get_tree") return Promise.resolve([]);
      if (cmd === "execution_get_collection") return Promise.resolve([]);
      if (cmd === "execution_get_ledger") return Promise.resolve(null);
      return Promise.resolve();
    });

    render(
      <ToastProvider>
        <JobExecutionsPage />
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByText("def-1"));

    const start = await screen.findByRole("button", { name: /\+ Start execution/i });
    await waitFor(() => expect(start).not.toBeDisabled());
    fireEvent.click(start);

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "experiment_start",
        expect.objectContaining({ rootDefId: 1 }),
      ),
    );
  });
});
