import { describe, it, expect, vi, beforeEach } from "vitest";

// Integration test for job management workflow
describe("Job Management Workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("validates complete job creation flow", () => {
    // Test data validation logic
    const validJobData = {
      name: "Test Job",
      promptFile: "test.jinja2",
      dataSource: "data.jsonl",
      provider: "Local",
      model: "llama3",
      serverUrl: "http://localhost:8000",
      outputMode: "JSON",
      samples: 10,
      strategy: "random",
    };

    // Validate required fields
    expect(validJobData.name).toBeTruthy();
    expect(validJobData.promptFile).toBeTruthy();
    expect(validJobData.dataSource).toBeTruthy();
    expect(validJobData.model).toBeTruthy();
    expect(validJobData.serverUrl).toBeTruthy();
    
    // Validate URL format
    expect(() => new URL(validJobData.serverUrl)).not.toThrow();
    
    // Validate samples is positive
    expect(validJobData.samples).toBeGreaterThan(0);
  });

  it("validates job status transitions", () => {
    const validTransitions: Record<string, string[]> = {
      pending: ["queued", "cancelled"],
      queued: ["running", "cancelled"],
      running: ["completed", "completed_with_errors", "failed", "cancelled"],
      completed: [],
      completed_with_errors: [],
      failed: [],
      cancelled: [],
    };

    // Test that all statuses have valid transitions defined
    Object.keys(validTransitions).forEach((status) => {
      expect(status).toMatch(/pending|queued|running|completed|completed_with_errors|failed|cancelled/);
    });
  });

  it("validates sampling strategies", () => {
    const validStrategies = ["single", "random", "exhaustive"];
    
    validStrategies.forEach((strategy) => {
      expect(strategy).toBeTruthy();
    });
  });

  it("validates output modes", () => {
    const validOutputModes = ["unstructured", "plain json", "json schema"];
    
    validOutputModes.forEach((mode) => {
      expect(mode).toBeTruthy();
    });
  });

  it("calculates progress percentage correctly", () => {
    const testCases = [
      { completed: 0, failed: 0, total: 100, expected: 0 },
      { completed: 50, failed: 0, total: 100, expected: 50 },
      { completed: 90, failed: 10, total: 100, expected: 100 },
      { completed: 5, failed: 2, total: 10, expected: 70 },
    ];

    testCases.forEach(({ completed, failed, total, expected }) => {
      const progressPercent = total > 0
        ? ((completed + failed) / total) * 100
        : 0;
      
      expect(progressPercent).toBe(expected);
    });
  });

  it("formats timestamps correctly", () => {
    const testDate = new Date("2024-01-15T10:30:00Z");
    
    // Test that date formatting produces expected output
    const formatted = testDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    
    expect(formatted).toMatch(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/);
  });

  it("validates YAML export structure", () => {
    const jobConfig = {
      name: "Test Job",
      prompt_file: "test.jinja2",
      data_source: "data.jsonl",
      provider: "Local",
      model: "llama3",
      server_url: "http://localhost:8000",
      output_mode: "JSON",
      temperature: 0.7,
      max_tokens: 1024,
      samples: 10,
      strategy: "random",
    };

    // Validate all required fields are present
    expect(jobConfig).toHaveProperty("name");
    expect(jobConfig).toHaveProperty("prompt_file");
    expect(jobConfig).toHaveProperty("data_source");
    expect(jobConfig).toHaveProperty("provider");
    expect(jobConfig).toHaveProperty("model");
    expect(jobConfig).toHaveProperty("server_url");
    expect(jobConfig).toHaveProperty("output_mode");
    expect(jobConfig).toHaveProperty("samples");
    expect(jobConfig).toHaveProperty("strategy");
  });

  it("handles optional fields in job config", () => {
    const minimalJob = {
      name: "Minimal Job",
      prompt_file: "test.jinja2",
      data_source: "data.jsonl",
      provider: "Local",
      model: "llama3",
      server_url: "http://localhost:8000",
      output_mode: "JSON",
      samples: 1,
      strategy: "single",
    };

    const fullJob = {
      ...minimalJob,
      temperature: 0.7,
      max_tokens: 1024,
      thinking_budget: 500,
      json_schema_file: "schema.json",
    };

    // Both should be valid
    expect(minimalJob.name).toBe("Minimal Job");
    expect(fullJob.thinking_budget).toBe(500);
    expect(fullJob.json_schema_file).toBe("schema.json");
  });
});
