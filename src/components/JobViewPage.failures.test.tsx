import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import JobViewPage from "./JobViewPage";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(vi.fn())),
}));

describe("JobViewPage failure surfacing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (invoke as ReturnType<typeof vi.fn>).mockImplementation((command: string) => {
      if (command === "get_inference_job") {
        return Promise.resolve({
          id: 7,
          job_type: "transform",
          name: "Transform with skips",
          prompt_file: "",
          data_source: "collection:3",
          provider: "Nightshift",
          model: "JavaScript",
          server_url: "",
          output_mode: "Transform",
          samples: 1,
          strategy: "exhaustive",
          transform_script_file: "transforms/normalize.js",
          transform_error_mode: "skip",
          transform_output_mode: "unwrap_arrays",
          status: "completed_with_errors",
          created_at: "2026-05-03T09:00:00Z",
          updated_at: "2026-05-03T09:05:00Z",
        });
      }

      if (command === "get_collections_for_job") {
        return Promise.resolve([
          {
            id: 12,
            job_id: 7,
            name: "Transform with skips outputs",
            created_at: "2026-05-03T09:05:00Z",
          },
        ]);
      }

      if (command === "get_job_failures") {
        return Promise.resolve([
          {
            id: 31,
            job_id: 7,
            sample_index: 2,
            error: "Transform script failed: missing questions array",
            created_at: "2026-05-03T09:04:00Z",
          },
        ]);
      }

      return Promise.resolve();
    });
  });

  it("shows completed-with-errors status, skipped item errors, and available output", async () => {
    render(<JobViewPage jobId={7} onViewCollection={vi.fn()} />);

    expect(await screen.findByText("Completed with errors")).toBeInTheDocument();
    expect(screen.getByText("Job completed and skipped 1 failed item.")).toBeInTheDocument();
    expect(screen.getByText("Skipped Items")).toBeInTheDocument();
    expect(screen.getByText("Item 3")).toBeInTheDocument();
    expect(screen.getByText("Transform script failed: missing questions array")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View Collection (1)" })).toBeEnabled();
    expect(listen).toHaveBeenCalledWith("job-completed", expect.any(Function));
  });
});
