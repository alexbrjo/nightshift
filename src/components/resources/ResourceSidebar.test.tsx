import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../../setupTests";
import { defaultWorkspaceLayout, type ResourceKind, type WorkspaceLayout } from "../../layout";
import ResourceSidebar from "./ResourceSidebar";

function renderSidebar(layoutOverrides: Partial<WorkspaceLayout> = {}) {
  const layout = { ...defaultWorkspaceLayout(), ...layoutOverrides };
  const props = {
    layout,
    isDark: false,
    projectFolderName: "",
    fileTreeRefreshKey: 0,
    jobListRefreshKey: 0,
    dirtyPaths: new Set<string>(),
    onToggleTheme: vi.fn(),
    onSetActiveResourceKind: vi.fn(),
    onToggleSidebar: vi.fn(),
    onFileOpen: vi.fn(),
    onFileSaved: vi.fn(),
    getActiveContent: vi.fn(),
    onRootNameChange: vi.fn(),
    openPanel: vi.fn(),
  };
  render(<ResourceSidebar {...props} />);
  return props;
}

describe("ResourceSidebar", () => {
  it("renders resource navigation and the conversation resource browser", () => {
    mockInvoke.mockResolvedValue(null);

    renderSidebar();

    expect(screen.getByRole("button", { name: "Conversations" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Methods" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jobs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a new chat" })).toBeInTheDocument();
  });

  it("filters welcome-only conversations from chat resources", async () => {
    mockInvoke.mockResolvedValue([
      {
        id: "chat-welcome",
        title: "New planning chat",
        messages: [{ id: "welcome", role: "assistant", text: "Describe the Method you want to design." }],
      },
      {
        id: "chat-real",
        title: "Real benchmark plan",
        messages: [{ id: "user-1", role: "user", text: "Plan the benchmark." }],
      },
    ]);

    renderSidebar();

    expect(await screen.findByText("Real benchmark plan")).toBeInTheDocument();
    expect(screen.queryByText("New planning chat")).not.toBeInTheDocument();
  });

  it("renders empty Method copy and project folder context", () => {
    mockInvoke.mockResolvedValue(null);

    renderSidebar({
      activeResourceKind: "project",
      sidebarMode: "expanded",
    });

    expect(screen.queryByText("Open Method source files from the project tree.")).not.toBeInTheDocument();
  });

  it("delegates active resource and sidebar state changes", () => {
    mockInvoke.mockResolvedValue(null);
    const props = renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Methods" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse resource sidebar" }));

    expect(props.onSetActiveResourceKind).toHaveBeenCalledWith("method");
    expect(props.onToggleSidebar).toHaveBeenCalled();
  });

  it("can be driven by parent layout state", async () => {
    mockInvoke.mockResolvedValue(null);

    function StatefulSidebar() {
      const [layout, setLayout] = useState<WorkspaceLayout>({
        ...defaultWorkspaceLayout(),
        activeResourceKind: "conversation",
      });
      const setActiveResourceKind = (kind: ResourceKind) => {
        setLayout((current) => ({
          ...current,
          activeResourceKind: kind,
          sidebarMode: current.activeResourceKind === kind && current.sidebarMode === "expanded"
            ? "collapsed"
            : "expanded",
        }));
      };
      return (
        <ResourceSidebar
          layout={layout}
          isDark={false}
          projectFolderName="project"
          fileTreeRefreshKey={0}
          jobListRefreshKey={0}
          dirtyPaths={new Set()}
          onToggleTheme={vi.fn()}
          onSetActiveResourceKind={setActiveResourceKind}
          onToggleSidebar={() => setLayout((current) => ({
            ...current,
            sidebarMode: current.sidebarMode === "expanded" ? "collapsed" : "expanded",
          }))}
          onFileOpen={vi.fn()}
          onFileSaved={vi.fn()}
          getActiveContent={vi.fn()}
          onRootNameChange={vi.fn()}
          openPanel={vi.fn()}
        />
      );
    }

    render(<StatefulSidebar />);

    fireEvent.click(screen.getByRole("button", { name: "Methods" }));
    expect(await screen.findByText("Open Method source files from the project tree.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Project" }));
    await waitFor(() => expect(screen.getByLabelText("Project folder: project")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Collapse resource sidebar" }));
    expect(document.querySelector(".resource-sidebar-panel")).not.toBeInTheDocument();
  });
});
