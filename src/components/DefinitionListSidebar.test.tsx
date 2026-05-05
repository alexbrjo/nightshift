import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { mockInvoke } from "../setupTests";
import DefinitionListSidebar from "./DefinitionListSidebar";

describe("DefinitionListSidebar", () => {
  const onSelect = vi.fn();
  const onNew = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    const now = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "definition_list_roots") {
        return Promise.resolve([
          {
            id: 1,
            parentId: null,
            rootId: 1,
            name: "alpha",
            position: 0,
            currentVersionId: 7,
            source: "user",
            deletedAt: null,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 2,
            parentId: null,
            rootId: 2,
            name: "beta-unsaved",
            position: 0,
            currentVersionId: null,
            source: "user",
            deletedAt: null,
            createdAt: now,
            updatedAt: now,
          },
        ]);
      }
      return Promise.resolve([]);
    });
  });

  it("renders header with + New button", async () => {
    render(
      <DefinitionListSidebar onSelectDefinition={onSelect} onNewDefinition={onNew} />,
    );
    expect(await screen.findByText("Experiments")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\+ New/i })).toBeInTheDocument();
  });

  it("loads definitions via definition_list_roots and renders them", async () => {
    render(
      <DefinitionListSidebar onSelectDefinition={onSelect} onNewDefinition={onNew} />,
    );
    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta-unsaved")).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("definition_list_roots");
  });

  it("shows version badge for saved and Unsaved for never-saved definitions", async () => {
    render(
      <DefinitionListSidebar onSelectDefinition={onSelect} onNewDefinition={onNew} />,
    );
    const alpha = (await screen.findByText("alpha")).closest(".job-item");
    expect(alpha?.querySelector(".status-badge")).toHaveTextContent("v7");
    expect(alpha).toHaveClass("status-completed");

    const beta = screen.getByText("beta-unsaved").closest(".job-item");
    expect(beta?.querySelector(".status-badge")).toHaveTextContent("Unsaved");
    expect(beta).toHaveClass("status-pending");
  });

  it("calls onSelectDefinition when a row is clicked", async () => {
    render(
      <DefinitionListSidebar onSelectDefinition={onSelect} onNewDefinition={onNew} />,
    );
    const item = (await screen.findByText("alpha")).closest(".job-item")!;
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("calls onNewDefinition when + New is clicked", async () => {
    render(
      <DefinitionListSidebar onSelectDefinition={onSelect} onNewDefinition={onNew} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /\+ New/i }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("renders empty state when no definitions exist", async () => {
    mockInvoke.mockResolvedValueOnce([]);
    render(
      <DefinitionListSidebar onSelectDefinition={onSelect} onNewDefinition={onNew} />,
    );
    expect(await screen.findByText(/No experiments yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Create your first experiment/i)).toBeInTheDocument();
  });
});
