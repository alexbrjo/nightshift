import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import InferenceJobForm from "./InferenceJobForm";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

describe("InferenceJobForm transform jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders job type choices as title tabs", () => {
    vi.mocked(invoke).mockResolvedValue([]);

    render(<InferenceJobForm isOpen onClose={vi.fn()} onSuccess={vi.fn()} />);

    const inferenceTab = screen.getByRole("tab", { name: "Create Inference Job" });
    const transformTab = screen.getByRole("tab", { name: "Create Transform Job" });

    expect(inferenceTab).toHaveClass("active");
    expect(inferenceTab).toHaveAttribute("aria-selected", "true");
    expect(transformTab).not.toHaveClass("active");
    expect(transformTab).toHaveAttribute("aria-selected", "false");

    fireEvent.click(transformTab);

    expect(inferenceTab).not.toHaveClass("active");
    expect(inferenceTab).toHaveAttribute("aria-selected", "false");
    expect(transformTab).toHaveClass("active");
    expect(transformTab).toHaveAttribute("aria-selected", "true");
  });

  it("uses a plain text inference create action", () => {
    vi.mocked(invoke).mockResolvedValue([]);

    render(<InferenceJobForm isOpen onClose={vi.fn()} onSuccess={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Create Inference Job" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
  });

  it("creates a transform job from the transform tab", async () => {
    const onSuccess = vi.fn();
    vi.mocked(invoke).mockImplementation((command: string) => {
      switch (command) {
        case "list_prompt_files":
        case "list_schema_files":
          return Promise.resolve([]);
        case "list_data_files":
          return Promise.resolve(["data/input.jsonl"]);
        case "list_transform_scripts":
          return Promise.resolve(["transforms/clean.js"]);
        case "list_selectable_collections":
          return Promise.resolve([]);
        case "check_transform_runtime":
          return Promise.resolve();
        case "create_transform_job":
          return Promise.resolve(42);
        default:
          return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
    });

    render(<InferenceJobForm isOpen onClose={vi.fn()} onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("tab", { name: "Create Transform Job" }));
    fireEvent.change(screen.getByLabelText("Job Name *"), {
      target: { value: "Clean rows" },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Transform Script *")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Transform Script *"), {
      target: { value: "transforms/clean.js" },
    });
    fireEvent.change(screen.getByLabelText("Data Source *"), {
      target: { value: "data/input.jsonl" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Transform Job" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("create_transform_job", {
        input: {
          name: "Clean rows",
          dataSource: "data/input.jsonl",
          scriptFile: "transforms/clean.js",
          errorMode: "stop",
          outputMode: "one_to_one",
        },
      });
      expect(onSuccess).toHaveBeenCalledWith(42);
    });
  });

  it("browses data sources into transform form state when no sources are listed", async () => {
    vi.mocked(open).mockResolvedValue("/project/data/input.jsonl");
    vi.mocked(invoke).mockImplementation((command: string) => {
      switch (command) {
        case "list_prompt_files":
        case "list_schema_files":
        case "list_data_files":
        case "list_selectable_collections":
          return Promise.resolve([]);
        case "list_transform_scripts":
          return Promise.resolve(["transforms/clean.js"]);
        case "check_transform_runtime":
          return Promise.resolve();
        case "get_root_path":
          return Promise.resolve("/project");
        case "create_transform_job":
          return Promise.resolve(43);
        default:
          return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
    });

    const onSuccess = vi.fn();
    render(<InferenceJobForm isOpen onClose={vi.fn()} onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("tab", { name: "Create Transform Job" }));
    fireEvent.change(screen.getByLabelText("Job Name *"), {
      target: { value: "Clean rows" },
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Transform Script *")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("Transform Script *"), {
      target: { value: "transforms/clean.js" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Data Source *")).toHaveValue("data/input.jsonl");
    });

    fireEvent.click(screen.getByRole("button", { name: "Create Transform Job" }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("create_transform_job", {
        input: {
          name: "Clean rows",
          dataSource: "data/input.jsonl",
          scriptFile: "transforms/clean.js",
          errorMode: "stop",
          outputMode: "one_to_one",
        },
      });
      expect(onSuccess).toHaveBeenCalledWith(43);
    });
  });

  it("creates a transform job with unwrap array output behavior", async () => {
    const onSuccess = vi.fn();
    vi.mocked(invoke).mockImplementation((command: string) => {
      switch (command) {
        case "list_prompt_files":
        case "list_schema_files":
          return Promise.resolve([]);
        case "list_data_files":
          return Promise.resolve(["data/input.jsonl"]);
        case "list_transform_scripts":
          return Promise.resolve(["transforms/clean.js"]);
        case "list_selectable_collections":
          return Promise.resolve([]);
        case "check_transform_runtime":
          return Promise.resolve();
        case "create_transform_job":
          return Promise.resolve(44);
        default:
          return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
    });

    render(<InferenceJobForm isOpen onClose={vi.fn()} onSuccess={onSuccess} />);

    fireEvent.click(screen.getByRole("tab", { name: "Create Transform Job" }));
    fireEvent.change(screen.getByLabelText("Job Name *"), {
      target: { value: "Split rows" },
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Transform Script *")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("Transform Script *"), {
      target: { value: "transforms/clean.js" },
    });
    fireEvent.change(screen.getByLabelText("Data Source *"), {
      target: { value: "data/input.jsonl" },
    });
    fireEvent.change(screen.getByLabelText("Output Behavior"), {
      target: { value: "unwrap_arrays" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Transform Job" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("create_transform_job", {
        input: {
          name: "Split rows",
          dataSource: "data/input.jsonl",
          scriptFile: "transforms/clean.js",
          errorMode: "stop",
          outputMode: "unwrap_arrays",
        },
      });
      expect(onSuccess).toHaveBeenCalledWith(44);
    });
  });

  it("shows backend string errors in the form banner", async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      switch (command) {
        case "list_prompt_files":
        case "list_schema_files":
          return Promise.resolve([]);
        case "list_data_files":
          return Promise.resolve(["data/input.jsonl"]);
        case "list_transform_scripts":
          return Promise.resolve(["transforms/clean.js"]);
        case "list_selectable_collections":
          return Promise.resolve([]);
        case "check_transform_runtime":
          return Promise.resolve();
        case "create_transform_job":
          return Promise.reject(
            "A job with the name 'Eval ready questions 3' already exists. Please choose a different name.",
          );
        default:
          return Promise.reject(new Error(`Unexpected command: ${command}`));
      }
    });

    render(<InferenceJobForm isOpen onClose={vi.fn()} onSuccess={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: "Create Transform Job" }));
    fireEvent.change(screen.getByLabelText("Job Name *"), {
      target: { value: "Eval ready questions 3" },
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Transform Script *")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("Transform Script *"), {
      target: { value: "transforms/clean.js" },
    });
    fireEvent.change(screen.getByLabelText("Data Source *"), {
      target: { value: "data/input.jsonl" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Transform Job" }));

    expect(
      await screen.findByText(
        "A job with the name 'Eval ready questions 3' already exists. Please choose a different name.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Failed to create transform job")).not.toBeInTheDocument();
  });
});
