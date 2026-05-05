import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockInvoke } from "../setupTests";
import DefinitionTreeSidebar from "./DefinitionTreeSidebar";

function makeDef(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date(Date.now() - 60 * 1000).toISOString();
  return {
    id: 1,
    parentId: null,
    rootId: 1,
    name: "root",
    position: 0,
    currentVersionId: 5,
    source: "user",
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    currentKind: "group" as const,
    ...overrides,
  };
}

describe("DefinitionTreeSidebar", () => {
  const onSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders only roots until expanded", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "definition_list_roots") {
        return Promise.resolve([makeDef({ id: 1, name: "alpha", currentKind: "group" })]);
      }
      return Promise.resolve([]);
    });
    render(<DefinitionTreeSidebar onSelectDefinition={onSelect} />);
    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(mockInvoke).toHaveBeenCalledWith("definition_list_roots");
    // No subtree fetch yet because root isn't expanded.
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "definition_list_by_root",
      expect.anything(),
    );
  });

  it("expands a root and renders nested children on click", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "definition_list_roots") {
        return Promise.resolve([makeDef({ id: 1, name: "alpha", currentKind: "group" })]);
      }
      if (cmd === "definition_list_by_root") {
        return Promise.resolve([
          makeDef({ id: 1, name: "alpha", currentKind: "group" }),
          makeDef({
            id: 2,
            parentId: 1,
            rootId: 1,
            name: "child-a",
            position: 0,
            currentKind: "inference",
            currentVersionId: 7,
          }),
        ]);
      }
      return Promise.resolve([]);
    });
    render(<DefinitionTreeSidebar onSelectDefinition={onSelect} />);
    await screen.findByText("alpha");

    const expand = screen.getByLabelText("Expand");
    fireEvent.click(expand);

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("definition_list_by_root", {
        rootId: 1,
      }),
    );
    expect(await screen.findByText("child-a")).toBeInTheDocument();
  });

  it("calls onSelectDefinition when a node label is clicked", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "definition_list_roots") {
        return Promise.resolve([makeDef({ id: 9, name: "root9" })]);
      }
      return Promise.resolve([]);
    });
    render(<DefinitionTreeSidebar onSelectDefinition={onSelect} />);
    const label = await screen.findByText("root9");
    fireEvent.click(label);
    expect(onSelect).toHaveBeenCalledWith(9);
  });

  it("renders Group / Inference badges from currentKind", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "definition_list_roots") {
        return Promise.resolve([
          makeDef({ id: 1, name: "g", currentKind: "group" }),
          makeDef({ id: 2, name: "i", currentKind: "inference", rootId: 2 }),
        ]);
      }
      return Promise.resolve([]);
    });
    render(<DefinitionTreeSidebar onSelectDefinition={onSelect} />);
    await screen.findByText("g");
    expect(screen.getByText("Group")).toBeInTheDocument();
    expect(screen.getByText("Inference")).toBeInTheDocument();
  });

  it("shows the empty state when no roots exist", async () => {
    mockInvoke.mockResolvedValueOnce([]);
    render(<DefinitionTreeSidebar onSelectDefinition={onSelect} />);
    expect(await screen.findByText(/No definitions yet/i)).toBeInTheDocument();
  });
});
