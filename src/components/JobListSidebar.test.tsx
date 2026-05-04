import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import JobListSidebar from "./JobListSidebar";

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("JobListSidebar", () => {
  const mockOnSelectJob = vi.fn();
  const mockOnNewJob = vi.fn();

  let mockJobs: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.clearAllMocks();
    const now = Date.now();
    mockJobs = [
      {
        id: 1,
        job_type: "inference",
        name: "Test Job 1",
        prompt_file: "test.jinja2",
        data_source: "data.jsonl",
        provider: "Local",
        model: "llama3",
        server_url: "http://localhost:8000",
        output_mode: "JSON",
        samples: 10,
        strategy: "random",
        status: "completed",
        created_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: 2,
        job_type: "transform",
        name: "Running Job",
        prompt_file: "prompt.jinja2",
        data_source: "samples.jsonl",
        provider: "OpenAI",
        model: "gpt-4",
        server_url: "https://api.openai.com/v1",
        output_mode: "Unstructured",
        samples: 50,
        strategy: "exhaustive",
        status: "running",
        created_at: new Date(now - 10 * 60 * 1000).toISOString(),
        updated_at: new Date(now - 10 * 60 * 1000).toISOString(),
      },
      {
        id: 3,
        job_type: "transform",
        name: "Mixed Result Job",
        prompt_file: "",
        data_source: "collection:1",
        provider: "Nightshift",
        model: "JavaScript",
        server_url: "",
        output_mode: "Transform",
        samples: 1,
        strategy: "exhaustive",
        status: "completed_with_errors",
        created_at: new Date(now - 60 * 60 * 1000).toISOString(),
        updated_at: new Date(now - 60 * 60 * 1000).toISOString(),
      },
    ];
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue(mockJobs);
  });

  it("renders the job list header with new job button", async () => {
    render(
      <JobListSidebar
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    expect(await screen.findByText("Jobs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\+ New/i })).toBeInTheDocument();
  });

  it("shows loading state initially", async () => {
    render(
      <JobListSidebar
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  it("displays jobs from the API", async () => {
    render(
      <JobListSidebar
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    expect(await screen.findByText(/Test Job 1/i)).toBeInTheDocument();
    expect(screen.getByText(/Running Job/i)).toBeInTheDocument();
    expect(screen.getByText(/Mixed Result Job/i)).toBeInTheDocument();
  });

  it("refreshes jobs when the hidden jobs page becomes active", async () => {
    const { rerender } = render(
      <JobListSidebar
        isActive={false}
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    expect(invoke).not.toHaveBeenCalled();

    rerender(
      <JobListSidebar
        isActive
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    expect(await screen.findByText(/Test Job 1/i)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("list_inference_jobs", {
      page: 1,
      pageSize: 50,
    });
  });

  it("shows status badges for each job", async () => {
    render(
      <JobListSidebar
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    expect(await screen.findByText("completed")).toBeInTheDocument();
    expect(screen.getByText("Completed with errors")).toBeInTheDocument();
    
    // Find the running job item and check for status badge within it
    const runningJobItem = await screen.findByText(/Running Job/i);
    const runningBadge = runningJobItem.closest(".job-item")?.querySelector(".status-badge");
    expect(runningBadge).toHaveTextContent("running");
  });

  it("calls onSelectJob when a job is clicked", async () => {
    render(
      <JobListSidebar
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    const jobItem = await screen.findByText(/Test Job 1/i);
    fireEvent.click(jobItem.closest(".job-item")!);

    expect(mockOnSelectJob).toHaveBeenCalledWith(1);
  });

  it("calls onNewJob when new job button is clicked", async () => {
    render(
      <JobListSidebar
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    const newJobButton = screen.getByRole("button", { name: /\+ New/i });
    fireEvent.click(newJobButton);

    expect(mockOnNewJob).toHaveBeenCalledTimes(1);
  });

  it("shows empty state when no jobs exist", async () => {
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    render(
      <JobListSidebar
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    expect(await screen.findByText(/No jobs yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Create your first job/i)).toBeInTheDocument();
  });

  it("places status on the first line and job type/date on the second line", async () => {
    render(
      <JobListSidebar
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    const jobItem = (await screen.findByText(/Running Job/i)).closest(".job-item");
    expect(jobItem?.querySelector(".job-primary-line")).toHaveTextContent("Running Job");
    expect(jobItem?.querySelector(".job-primary-line")).toHaveTextContent("running");
    expect(jobItem?.querySelector(".job-meta")).toHaveTextContent("Transform");
    expect(jobItem?.querySelector(".job-meta")).not.toHaveTextContent("running");
    expect(jobItem?.querySelector(".job-relative-time")).toHaveTextContent("10 Min ago");
  });

  it("formats timestamps as relative times", async () => {
    render(
      <JobListSidebar
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    const jobItem = await screen.findByText(/Test Job 1/i);
    expect(jobItem).toBeInTheDocument();
    expect(screen.getByText("1 day ago")).toBeInTheDocument();
    expect(screen.getByText("10 Min ago")).toBeInTheDocument();
  });

  it("applies status-specific styling classes", async () => {
    render(
      <JobListSidebar
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    const completedJob = await screen.findByText(/Test Job 1/i);
    const runningJob = screen.getByText(/Running Job/i);
    const mixedJob = screen.getByText(/Mixed Result Job/i);

    expect(completedJob.closest(".job-item")).toHaveClass("status-completed");
    expect(runningJob.closest(".job-item")).toHaveClass("status-running");
    expect(mixedJob.closest(".job-item")).toHaveClass("status-warning");
  });
});
