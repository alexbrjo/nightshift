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
    const now = Date.now();
    vi.mocked(invoke).mockResolvedValue([
      {
        id: 11,
        job_id: 7,
        name: "Eval outputs",
        created_at: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
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
    expect(screen.getByText("2 days ago")).toHaveClass("collection-created-time");
    expect(invoke).toHaveBeenCalledWith("list_all_collections");
    expect(listen).toHaveBeenCalledWith("job-started", expect.any(Function));
  });

  it("uses the same relative timestamp style as the jobs sidebar", async () => {
    const now = Date.now();
    vi.mocked(invoke).mockResolvedValue([
      {
        id: 12,
        job_id: 8,
        name: "Recent outputs",
        created_at: new Date(now - 10 * 60 * 1000).toISOString(),
      },
    ]);

    render(
      <CollectionsList
        isActive
        selectedId={null}
        onSelectCollection={vi.fn()}
      />,
    );

    const collectionItem = (await screen.findByText("Recent outputs")).closest(".collection-item");
    expect(collectionItem?.querySelector(".collection-meta")).toHaveTextContent("#12");
    expect(collectionItem?.querySelector(".collection-created-time")).toHaveTextContent("10 Min ago");
  });

  it("passes the selected collection so callers can use its name", async () => {
    const onSelectCollection = vi.fn();
    const collection = {
      id: 13,
      job_id: 9,
      name: "Named outputs",
      created_at: new Date().toISOString(),
    };
    vi.mocked(invoke).mockResolvedValue([collection]);

    render(
      <CollectionsList
        isActive
        selectedId={null}
        onSelectCollection={onSelectCollection}
      />,
    );

    fireEvent.click(await screen.findByText("Named outputs"));

    expect(onSelectCollection).toHaveBeenCalledWith(collection);
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
    expect(screen.getByText("Your collections will appear here after you run a job.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh collections" })).not.toBeInTheDocument();
  });
});
