import { describe, expect, it } from "vitest";
import {
  closePanel,
  createPanel,
  defaultWorkspaceLayout,
  openOrFocusPanel,
  panelId,
  parseWorkspaceLayout,
  serializeWorkspaceLayout,
  validateWorkspaceLayout,
} from "./layout";

describe("workspace layout helpers", () => {
  it("creates stable panel ids", () => {
    expect(panelId("chat")).toBe("chat:default");
    expect(panelId("job-view", 42)).toBe("job-view:42");
    expect(panelId("project-editor", "prompts/main prompt.md")).toBe("project-editor:prompts%2Fmain%20prompt.md");
  });

  it("opens new panels and focuses existing panels without duplication", () => {
    const layout = defaultWorkspaceLayout();
    const jobPanel = createPanel("job-view", { resourceId: 9, title: "Job #9" });
    const withJob = openOrFocusPanel(layout, jobPanel);
    const focusedAgain = openOrFocusPanel(withJob, jobPanel);

    expect(withJob.panels).toHaveLength(1);
    expect(withJob.activePanelId).toBe(jobPanel.id);
    expect(focusedAgain.panels).toHaveLength(1);
    expect(focusedAgain.activePanelId).toBe(jobPanel.id);
  });

  it("closes panels and returns to an empty workspace", () => {
    const layout = openOrFocusPanel(defaultWorkspaceLayout(), createPanel("new-job"));
    const next = closePanel(layout, "new-job:default");

    expect(next.panels.some((panel) => panel.id === "new-job:default")).toBe(false);
    expect(next.activePanelId).toBe("");
  });

  it("keeps split sizes matched to surviving panels when closing a middle panel", () => {
    const first = createPanel("chat", { resourceId: "first" });
    const second = createPanel("job-view", { resourceId: 2 });
    const third = createPanel("method-editor", { resourceId: "methods/example.method.yaml" });
    const layout = {
      ...defaultWorkspaceLayout(),
      panels: [first, second, third],
      activePanelId: third.id,
      splitSizes: [20, 30, 50],
    };

    const next = closePanel(layout, second.id);

    expect(next.panels.map((panel) => panel.id)).toEqual([first.id, third.id]);
    expect(next.splitSizes).toEqual([100 * (20 / 70), 100 * (50 / 70)]);
  });

  it("validates persisted schema and discards incompatible cache payloads", () => {
    const layout = openOrFocusPanel(defaultWorkspaceLayout(), createPanel("job-view", { resourceId: 3 }));
    expect(parseWorkspaceLayout(serializeWorkspaceLayout(layout))?.panels).toHaveLength(1);
    expect(validateWorkspaceLayout({ ...layout, schemaVersion: 2 })).toBeNull();
    expect(parseWorkspaceLayout("{bad json")).toBeNull();
  });

  it("persists project editor view modes without rejecting old layouts", () => {
    const layout = openOrFocusPanel(defaultWorkspaceLayout(), {
      ...createPanel("project-editor", { resourceId: "README.md", title: "README.md" }),
      viewMode: "markdown",
    });

    const parsed = parseWorkspaceLayout(serializeWorkspaceLayout(layout));

    expect(parsed?.panels[0].viewMode).toBe("markdown");
  });

  it("applies requested view mode when focusing an existing project editor panel", () => {
    const filePanel = createPanel("project-editor", { resourceId: "methods/current.method.yaml" });
    const layout = openOrFocusPanel(defaultWorkspaceLayout(), filePanel);
    const focused = openOrFocusPanel(
      layout,
      createPanel("project-editor", { resourceId: "methods/current.method.yaml", viewMode: "methodGraph" }),
    );

    expect(focused.panels).toHaveLength(1);
    expect(focused.panels[0].viewMode).toBe("methodGraph");
  });

  it("ignores invalid persisted project editor view modes", () => {
    const layout = {
      ...defaultWorkspaceLayout(),
      panels: [
        {
          id: "project-editor:README.md",
          type: "project-editor",
          title: "README.md",
          resourceId: "README.md",
          viewMode: "spreadsheet",
        },
      ],
      activePanelId: "project-editor:README.md",
      splitSizes: [100],
    };

    const parsed = validateWorkspaceLayout(layout);

    expect(parsed?.panels[0].viewMode).toBeUndefined();
    expect(parsed?.panels[0].title).toBe("README.md");
  });
});
