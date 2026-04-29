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

  const mockJobs = [
    {
      id: 1,
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
      created_at: "2024-01-15T10:30:00Z",
      updated_at: "2024-01-15T10:35:00Z",
    },
    {
      id: 2,
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
      created_at: "2024-01-16T14:20:00Z",
      updated_at: "2024-01-16T14:25:00Z",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    (invoke as ReturnType<typeof vi.fn>).mockResolvedValue(mockJobs);
  });

  it("renders the job list header with new job button", async () => {
    render(
      <JobListSidebar
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    expect(await screen.findByText(/Inference Jobs/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\+ New Job/i })).toBeInTheDocument();
  });

  it("shows loading state initially", async () => {
    render(
      <JobListSidebar
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    expect(screen.getByText(/Loading jobs/i)).toBeInTheDocument();
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
  });

  it("shows status badges for each job", async () => {
    render(
      <JobListSidebar
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    expect(await screen.findByText(/completed/i)).toBeInTheDocument();
    
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

    const newJobButton = screen.getByRole("button", { name: /\+ New Job/i });
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

    expect(await screen.findByText(/No inference jobs yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Create your first job/i)).toBeInTheDocument();
  });

  it("displays different status icons based on job status", async () => {
    render(
      <JobListSidebar
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    const jobItems = await screen.findAllByRole("listitem");
    
    // Check that status icons are present (emojis)
    expect(jobItems[0]).toHaveTextContent(/✅|⏳|▶️/);
  });

  it("formats dates correctly", async () => {
    render(
      <JobListSidebar
        onSelectJob={mockOnSelectJob}
        onNewJob={mockOnNewJob}
      />
    );

    const jobItem = await screen.findByText(/Test Job 1/i);
    expect(jobItem).toBeInTheDocument();
    // Date should be formatted (e.g., "Jan 15, 10:30 AM") - use findAllByText to avoid multiple matches
    const dateElements = await screen.findAllByText(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/i);
    expect(dateElements.length).toBeGreaterThan(0);
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

    expect(completedJob.closest(".job-item")).toHaveClass("status-completed");
    expect(runningJob.closest(".job-item")).toHaveClass("status-running");
  });
});
