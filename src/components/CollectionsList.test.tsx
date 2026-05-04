import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import CollectionsList from "./CollectionsList";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

describe("CollectionsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes collections when the hidden collections page becomes active", async () => {
    vi.mocked(invoke).mockResolvedValue([
      {
        id: 11,
        job_id: 7,
        name: "Eval outputs",
        created_at: "2026-05-04T10:00:00Z",
      },
    ]);

    const { rerender } = render(
      <CollectionsList
        isActive={false}
        selectedId={null}
        onSelectCollection={vi.fn()}
      />,
    );

    expect(invoke).not.toHaveBeenCalled();

    rerender(
      <CollectionsList
        isActive
        selectedId={null}
        onSelectCollection={vi.fn()}
      />,
    );

    expect(await screen.findByText("Eval outputs")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("list_all_collections");
    expect(listen).toHaveBeenCalledWith("job-started", expect.any(Function));
  });

  it("shows a retryable error when collections fail to load", async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error("Database unavailable"))
      .mockResolvedValueOnce([]);

    render(
      <CollectionsList
        isActive
        selectedId={null}
        onSelectCollection={vi.fn()}
      />,
    );

    expect(await screen.findByText("Database unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText("No collections yet.")).toBeInTheDocument();
  });
});
