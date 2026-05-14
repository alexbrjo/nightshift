import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProjectEditorPanel, { ProjectEditorHeaderActions } from "./ProjectEditorPanel";
import type { WorkspacePanel } from "../../layout";
import type { ProjectFileSnapshot } from "./projectFileModel";

const methodPanel: WorkspacePanel = {
  id: "project-editor:methods%2Fcurrent.method.yaml",
  type: "project-editor",
  title: "current.method.yaml",
  resourceId: "methods/current.method.yaml",
  viewMode: "methodGraph",
};

const methodFile: ProjectFileSnapshot = {
  path: "methods/current.method.yaml",
  name: "current.method.yaml",
  content: [
    "schema_version: 2",
    "id: current",
    "title: Current",
    "objective: Render graph",
    "workflow:",
    "  nodes: []",
    "parameters: {}",
    "provider: {}",
  ].join("\n"),
  language: "yaml",
};

describe("ProjectEditorPanel", () => {
  it("calls back when switching preview modes", () => {
    const onViewModeChange = vi.fn();
    const markdownPanel: WorkspacePanel = {
      id: "project-editor:README.md",
      type: "project-editor",
      title: "README.md",
      resourceId: "README.md",
    };
    const markdownFile: ProjectFileSnapshot = {
      path: "README.md",
      name: "README.md",
      content: "# Notes",
      language: "markdown",
    };

    render(
      <ProjectEditorHeaderActions
        panel={markdownPanel}
        file={markdownFile}
        isDirty={false}
        isExecuting={false}
        onViewModeChange={onViewModeChange}
        onExecute={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show Markdown preview for README.md" }));

    expect(onViewModeChange).toHaveBeenCalledWith(markdownPanel.id, "markdown");
  });

  it("hides view controls for non-previewable project files", () => {
    const codePanel: WorkspacePanel = {
      id: "project-editor:src%2Fcode.js",
      type: "project-editor",
      title: "code.js",
      resourceId: "src/code.js",
    };
    const codeFile: ProjectFileSnapshot = {
      path: "src/code.js",
      name: "code.js",
      content: "console.log('hello');",
      language: "javascript",
    };

    render(
      <ProjectEditorHeaderActions
        panel={codePanel}
        file={codeFile}
        isDirty={false}
        isExecuting={false}
        onViewModeChange={vi.fn()}
        onExecute={vi.fn()}
      />,
    );

    expect(screen.queryByRole("group", { name: "View options for code.js" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show Code for code.js" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show Markdown preview for code.js" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show Method graph for code.js" })).not.toBeInTheDocument();
  });

  it("renders Method graph files and exposes executable header actions", async () => {
    const onExecute = vi.fn();

    render(
      <>
        <ProjectEditorHeaderActions
          panel={methodPanel}
          file={methodFile}
          isDirty={false}
          isExecuting={false}
          onViewModeChange={vi.fn()}
          onExecute={onExecute}
        />
        <ProjectEditorPanel panel={methodPanel} file={methodFile} onChange={vi.fn()} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Execute current.method.yaml" }));

    expect(await screen.findByTestId("method-graph-preview")).toBeInTheDocument();
    expect(onExecute).toHaveBeenCalledWith("methods/current.method.yaml", methodPanel.id);
  });

  it("renders a Method graph for YAML files beyond method manifests", async () => {
    const loosePanel: WorkspacePanel = {
      id: "project-editor:experiments%2Floose.yaml",
      type: "project-editor",
      title: "loose.yaml",
      resourceId: "experiments/loose.yaml",
      viewMode: "methodGraph",
    };
    const looseFile: ProjectFileSnapshot = {
      path: "experiments/loose.yaml",
      name: "loose.yaml",
      content: [
        "schema_version: 2",
        "id: loose-method",
        "title: Loose Method",
        "objective: Render graph",
        "workflow:",
        "  nodes:",
        "    - id: inspect",
        "      label: Inspect",
        "      type: analysis",
        "      config: {}",
        "parameters: {}",
        "provider: {}",
      ].join("\n"),
      language: "yaml",
    };

    render(<ProjectEditorPanel panel={loosePanel} file={looseFile} onChange={vi.fn()} />);

    expect(await screen.findByTestId("method-graph-preview")).toBeInTheDocument();
    expect(screen.getByText("Inspect")).toBeInTheDocument();
  });

  it("shows an inline Method graph error for invalid Method YAML", async () => {
    render(
      <ProjectEditorPanel
        panel={methodPanel}
        file={{ ...methodFile, content: "not: a method" }}
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByText("Method graph unavailable")).toBeInTheDocument();
    expect(screen.getByText("This file is not a valid Method document.")).toBeInTheDocument();
  });

  it("disables execution for dirty Method files", () => {
    render(
      <ProjectEditorHeaderActions
        panel={methodPanel}
        file={methodFile}
        isDirty={true}
        isExecuting={false}
        onViewModeChange={vi.fn()}
        onExecute={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Save current.method.yaml before execution" })).toBeDisabled();
  });

  it("shows file load errors in the editor body", () => {
    render(
      <ProjectEditorPanel
        panel={methodPanel}
        file={{ ...methodFile, content: "", error: "missing file" }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Could not load current.method.yaml: missing file")).toBeInTheDocument();
  });
});
