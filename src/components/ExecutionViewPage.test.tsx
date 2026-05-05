import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockInvoke } from "../setupTests";
import ExecutionViewPage from "./ExecutionViewPage";

describe("ExecutionViewPage", () => {
  const onBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "execution_get") {
        return Promise.resolve({
          id: 5,
          definitionVersionId: 1,
          parentId: null,
          rootId: 5,
          status: "running",
          plan: null,
          ledger: null,
          cancellationRequested: 0,
          startedAt: null,
          finishedAt: null,
          error: null,
          createdAt: "",
        });
      }
      if (cmd === "execution_get_tree") {
        return Promise.resolve([
          {
            id: 5,
            definitionVersionId: 1,
            parentId: null,
            rootId: 5,
            status: "running",
            plan: null,
            ledger: null,
            cancellationRequested: 0,
            startedAt: null,
            finishedAt: null,
            error: null,
            createdAt: "",
          },
        ]);
      }
      if (cmd === "execution_get_collection") return Promise.resolve([]);
      if (cmd === "execution_get_ledger") return Promise.resolve(null);
      return Promise.resolve();
    });
  });

  it("renders the running banner and a Cancel button while not terminal", async () => {
    render(<ExecutionViewPage rootExecId={5} onBack={onBack} />);
    expect(await screen.findByText("Job execution 5")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeInTheDocument();
  });

  it("hides Cancel and shows the back button regardless of terminal state", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "execution_get") {
        return Promise.resolve({
          id: 7,
          definitionVersionId: 1,
          parentId: null,
          rootId: 7,
          status: "completed",
          plan: null,
          ledger: null,
          cancellationRequested: 0,
          startedAt: null,
          finishedAt: null,
          error: null,
          createdAt: "",
        });
      }
      if (cmd === "execution_get_tree") return Promise.resolve([]);
      if (cmd === "execution_get_collection") return Promise.resolve([]);
      if (cmd === "execution_get_ledger") return Promise.resolve(null);
      return Promise.resolve();
    });
    render(<ExecutionViewPage rootExecId={7} onBack={onBack} />);
    expect(await screen.findByText("Job execution 7")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Cancel$/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^← Back$/ })).toBeInTheDocument();
  });
});
