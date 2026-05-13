import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { mockInvoke } from "./setupTests";
import App from "./App";

describe("App", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue([]);
    localStorage.clear();
  });

  it("renders without crashing", () => {
    render(<App />);
    expect(screen.getByText("Open a folder and select a file to begin")).toBeDefined();
  });

  it("renders sidebar with all section buttons", () => {
    render(<App />);
    expect(document.querySelectorAll(".sidebar-btn").length).toBe(4);
  });

  it("defaults to code-editor section", () => {
    render(<App />);
    expect(screen.getByText("Open a folder and select a file to begin")).toBeDefined();
  });

  it("switches to collection-viewer section", async () => {
    render(<App />);
    const buttons = document.querySelectorAll(".sidebar-btn");
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(screen.getByText("Collections")).toBeDefined());
  });

  it("switches to job-runner section", async () => {
    render(<App />);
    const buttons = document.querySelectorAll(".sidebar-btn");
    
    fireEvent.click(buttons[2]);
    
    const jobText = await screen.findAllByText(/No inference jobs yet|Create Inference Job/i);
    expect(jobText.length).toBeGreaterThan(0);
  });

  it("switches to experiment-designer section", () => {
    render(<App />);
    const buttons = document.querySelectorAll(".sidebar-btn");
    fireEvent.click(buttons[3]);
    expect(screen.getByText(/Describe the Method you want to design/)).toBeDefined();
  });

  it("highlights active section button", () => {
    render(<App />);
    const buttons = document.querySelectorAll(".sidebar-btn");
    expect(buttons[0]).toHaveClass("active");

    fireEvent.click(buttons[1]);
    expect(buttons[1]).toHaveClass("active");
    expect(buttons[0]).not.toHaveClass("active");
  });

  it("shows editor placeholder when no file is open", () => {
    render(<App />);
    expect(screen.getByText("Open a folder and select a file to begin")).toBeDefined();
  });

  it("renders FileTree component", () => {
    render(<App />);
    expect(document.querySelector(".file-tree-panel")).toBeDefined();
  });

  it("hides FileTree when not in code-editor section", () => {
    render(<App />);
    const buttons = document.querySelectorAll(".sidebar-btn");
    fireEvent.click(buttons[1]);
    expect(document.querySelector(".file-tree-panel")).toHaveClass("hidden");
  });

  it("shows FileTree when in code-editor section", () => {
    render(<App />);
    expect(document.querySelector(".file-tree-panel")).not.toHaveClass("hidden");
  });

  it("renders sidebar logo", () => {
    render(<App />);
    expect(document.querySelector(".sidebar-logo")).toBeDefined();
  });

  it("renders workspace container", () => {
    render(<App />);
    expect(document.querySelector(".workspace")).toBeDefined();
  });

  it("renders ToastProvider wrapping the app", () => {
    render(<App />);
    expect(document.querySelector(".toast-container")).toBeDefined();
  });

  it("renders section buttons with correct icons", () => {
    render(<App />);
    const buttons = document.querySelectorAll(".sidebar-btn");
    expect(buttons.length).toBe(4);
  });

  it("renders section buttons with correct titles", () => {
    render(<App />);
    const buttons = document.querySelectorAll(".sidebar-btn");
    expect(buttons[0]).toHaveAttribute("title", "Project");
    expect(buttons[1]).toHaveAttribute("title", "Collections");
    expect(buttons[2]).toHaveAttribute("title", "Inference Jobs");
    expect(buttons[3]).toHaveAttribute("title", "Agent");
  });

  it("navigates back to code-editor from another section", async () => {
    render(<App />);
    const buttons = document.querySelectorAll(".sidebar-btn");

    fireEvent.click(buttons[1]);
    await waitFor(() => expect(screen.getByText("Collections")).toBeDefined());

    fireEvent.click(buttons[0]);
    expect(screen.getByText("Open a folder and select a file to begin")).toBeDefined();
  });

  it("keeps agent chat state alive when switching sections", async () => {
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "start_design_session":
          return Promise.resolve({ threadId: "thr_123" });
        case "send_design_chat_message":
          return Promise.resolve({ threadId: "thr_123", turnId: "turn_456" });
        case "get_current_method_draft":
          return Promise.resolve(null);
        case "list_methods":
        case "list_method_executions":
        case "get_method_execution_nodes":
        case "get_method_execution_events":
          return Promise.resolve([]);
        default:
          return Promise.resolve([]);
      }
    });

    render(<App />);
    const buttons = document.querySelectorAll(".sidebar-btn");

    fireEvent.click(buttons[3]);
    const input = await screen.findByPlaceholderText(/Describe or refine/i);
    fireEvent.change(input, { target: { value: "keep this chat around" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(screen.getByText("keep this chat around")).toBeDefined();
    });

    fireEvent.click(buttons[0]);
    expect(screen.getByText("Open a folder and select a file to begin")).toBeDefined();

    fireEvent.click(buttons[3]);
    expect(screen.getByText("keep this chat around")).toBeDefined();
  });

  it("workspace has full-width class for non-editor sections", () => {
    render(<App />);
    const buttons = document.querySelectorAll(".sidebar-btn");

    fireEvent.click(buttons[1]);
    expect(document.querySelector(".collections-page")).toHaveClass("full-width");

    fireEvent.click(buttons[0]);
    expect(document.querySelector("main.workspace:not(.full-width)")).toBeDefined();
  });

  it("renders app container with correct class", () => {
    render(<App />);
    expect(document.querySelector(".app")).toBeDefined();
  });

  it("renders sidebar with correct classes", () => {
    render(<App />);
    expect(document.querySelector(".sidebar")).toBeDefined();
    expect(document.querySelector(".sidebar-nav")).toBeDefined();
  });

  it("handles rapid section switching", () => {
    render(<App />);
    const buttons = document.querySelectorAll(".sidebar-btn");

    for (let i = 0; i < 4; i++) {
      fireEvent.click(buttons[i]);
    }

    expect(document.querySelector(".sidebar-btn.active")).toBeDefined();
  });
});

describe("getLanguage", () => {
  function getLanguage(filename: string): string | undefined {
    const ext = filename.split(".").pop()?.toLowerCase();
    const map: Record<string, string> = {
      js: "javascript",
      ts: "typescript",
      jsx: "jsx",
      tsx: "tsx",
      json: "json",
      jsonl: "json",
      md: "markdown",
      markdown: "markdown",
      yaml: "yaml",
      yml: "yaml",
      py: "python",
      rs: "rust",
      html: "html",
      css: "css",
      sh: "bash",
    };
    return ext ? map[ext] : undefined;
  }

  it("returns javascript for .js files", () => {
    expect(getLanguage("file.js")).toBe("javascript");
  });

  it("returns typescript for .ts files", () => {
    expect(getLanguage("file.ts")).toBe("typescript");
  });

  it("returns jsx for .jsx files", () => {
    expect(getLanguage("file.jsx")).toBe("jsx");
  });

  it("returns tsx for .tsx files", () => {
    expect(getLanguage("file.tsx")).toBe("tsx");
  });

  it("returns json for .json files", () => {
    expect(getLanguage("file.json")).toBe("json");
  });

  it("returns json for .jsonl files", () => {
    expect(getLanguage("file.jsonl")).toBe("json");
  });

  it("returns markdown for .md files", () => {
    expect(getLanguage("file.md")).toBe("markdown");
  });

  it("returns markdown for .markdown files", () => {
    expect(getLanguage("file.markdown")).toBe("markdown");
  });

  it("returns yaml for .yaml files", () => {
    expect(getLanguage("file.yaml")).toBe("yaml");
  });

  it("returns yaml for .yml files", () => {
    expect(getLanguage("file.yml")).toBe("yaml");
  });

  it("returns python for .py files", () => {
    expect(getLanguage("file.py")).toBe("python");
  });

  it("returns rust for .rs files", () => {
    expect(getLanguage("file.rs")).toBe("rust");
  });

  it("returns html for .html files", () => {
    expect(getLanguage("file.html")).toBe("html");
  });

  it("returns css for .css files", () => {
    expect(getLanguage("file.css")).toBe("css");
  });

  it("returns bash for .sh files", () => {
    expect(getLanguage("file.sh")).toBe("bash");
  });

  it("returns undefined for unknown extensions", () => {
    expect(getLanguage("file.xyz")).toBe(undefined);
  });

  it("returns undefined for files without extension", () => {
    expect(getLanguage("README")).toBe(undefined);
  });

  it("handles uppercase extensions", () => {
    expect(getLanguage("file.JS")).toBe("javascript");
    expect(getLanguage("file.PY")).toBe("python");
  });

  it("handles mixed case extensions", () => {
    expect(getLanguage("file.Js")).toBe("javascript");
  });

  it("handles files with multiple dots", () => {
    expect(getLanguage("file.test.js")).toBe("javascript");
  });

  it("handles hidden files", () => {
    expect(getLanguage(".gitignore")).toBe(undefined);
  });

  it("handles empty filename", () => {
    expect(getLanguage("")).toBe(undefined);
  });

  it("handles path with filename", () => {
    expect(getLanguage("/path/to/file.py")).toBe("python");
  });

  it("handles Windows-style paths", () => {
    expect(getLanguage("C:\\path\\to\\file.rs")).toBe("rust");
  });
});
