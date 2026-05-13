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

  it("validates persisted schema and discards incompatible cache payloads", () => {
    const layout = openOrFocusPanel(defaultWorkspaceLayout(), createPanel("collection-view", { resourceId: 3 }));
    expect(parseWorkspaceLayout(serializeWorkspaceLayout(layout))?.panels).toHaveLength(1);
    expect(validateWorkspaceLayout({ ...layout, schemaVersion: 2 })).toBeNull();
    expect(parseWorkspaceLayout("{bad json")).toBeNull();
  });
});
