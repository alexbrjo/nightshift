export const LAYOUT_SCHEMA_VERSION = 1;

export type SidebarMode = "collapsed" | "expanded";
export type ResourceKind = "conversation" | "method" | "project" | "job" | "collection";
export type PanelType =
  | "chat"
  | "method-graph"
  | "method-execution"
  | "project-editor"
  | "collection-view"
  | "job-view"
  | "new-job";

export interface WorkspacePanel {
  id: string;
  type: PanelType;
  title: string;
  resourceId?: string;
}

export interface WorkspaceLayout {
  schemaVersion: 1;
  sidebarMode: SidebarMode;
  activeResourceKind: ResourceKind;
  panels: WorkspacePanel[];
  activePanelId: string;
  splitSizes: number[];
}

export function defaultWorkspaceLayout(): WorkspaceLayout {
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    sidebarMode: "expanded",
    activeResourceKind: "conversation",
    panels: [],
    activePanelId: "",
    splitSizes: [],
  };
}

export function panelId(type: PanelType, resourceId?: string | number | null): string {
  const suffix = resourceId === undefined || resourceId === null || resourceId === "" ? "default" : String(resourceId);
  return `${type}:${encodeURIComponent(suffix)}`;
}

export function createPanel(type: PanelType, options: { resourceId?: string | number | null; title?: string } = {}): WorkspacePanel {
  const resourceId = options.resourceId === undefined || options.resourceId === null ? undefined : String(options.resourceId);
  return {
    id: panelId(type, resourceId),
    type,
    title: options.title ?? defaultPanelTitle(type, resourceId),
    resourceId,
  };
}

export function openOrFocusPanel(layout: WorkspaceLayout, panel: WorkspacePanel): WorkspaceLayout {
  if (layout.panels.some((candidate) => candidate.id === panel.id)) {
    return { ...layout, activePanelId: panel.id };
  }
  return {
    ...layout,
    panels: [...layout.panels, panel],
    activePanelId: panel.id,
    splitSizes: normalizeSplitSizes([...layout.splitSizes, 100 / (layout.panels.length + 1)], layout.panels.length + 1),
  };
}

export function closePanel(layout: WorkspaceLayout, panelIdToClose: string): WorkspaceLayout {
  const index = layout.panels.findIndex((panel) => panel.id === panelIdToClose);
  if (index === -1) return layout;
  const panels = layout.panels.filter((panel) => panel.id !== panelIdToClose);
  const splitSizes = layout.splitSizes.filter((_, sizeIndex) => sizeIndex !== index);
  const activePanelId =
    layout.activePanelId === panelIdToClose
      ? panels[Math.max(0, index - 1)]?.id ?? panels[0]?.id ?? ""
      : layout.activePanelId;
  return {
    ...layout,
    panels,
    activePanelId,
    splitSizes: normalizeSplitSizes(splitSizes, panels.length),
  };
}

export function validateWorkspaceLayout(value: unknown): WorkspaceLayout | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<WorkspaceLayout>;
  if (candidate.schemaVersion !== LAYOUT_SCHEMA_VERSION) return null;
  if (candidate.sidebarMode !== "collapsed" && candidate.sidebarMode !== "expanded") return null;
  if (!isResourceKind(candidate.activeResourceKind)) return null;
  if (!Array.isArray(candidate.panels)) return null;
  const panels = candidate.panels.filter(isWorkspacePanel);
  if (panels.length !== candidate.panels.length) return null;
  const requestedActivePanelId = typeof candidate.activePanelId === "string" ? candidate.activePanelId : undefined;
  const activePanelId = requestedActivePanelId && panels.some((panel) => panel.id === requestedActivePanelId)
    ? requestedActivePanelId
    : panels[0]?.id ?? "";
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    sidebarMode: candidate.sidebarMode,
    activeResourceKind: candidate.activeResourceKind,
    panels,
    activePanelId,
    splitSizes: normalizeSplitSizes(candidate.splitSizes, panels.length),
  };
}

export function serializeWorkspaceLayout(layout: WorkspaceLayout): string {
  return JSON.stringify(layout);
}

export function parseWorkspaceLayout(raw: string | null): WorkspaceLayout | null {
  if (!raw) return null;
  try {
    return validateWorkspaceLayout(JSON.parse(raw));
  } catch {
    return null;
  }
}

function defaultPanelTitle(type: PanelType, resourceId?: string) {
  switch (type) {
    case "chat":
      return "Chat";
    case "method-graph":
      return "Method Graph";
    case "method-execution":
      return resourceId ? `Execution #${resourceId}` : "Method Execution";
    case "project-editor":
      return resourceId ?? "Project Editor";
    case "collection-view":
      return resourceId ? `Collection #${resourceId}` : "Collection";
    case "job-view":
      return resourceId ? `Job #${resourceId}` : "Job";
    case "new-job":
      return "New Job";
  }
}

function isWorkspacePanel(value: unknown): value is WorkspacePanel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<WorkspacePanel>;
  return Boolean(
    typeof candidate.id === "string"
      && isPanelType(candidate.type)
      && typeof candidate.title === "string"
      && (candidate.resourceId === undefined || typeof candidate.resourceId === "string"),
  );
}

function isPanelType(value: unknown): value is PanelType {
  return value === "chat"
    || value === "method-graph"
    || value === "method-execution"
    || value === "project-editor"
    || value === "collection-view"
    || value === "job-view"
    || value === "new-job";
}

function isResourceKind(value: unknown): value is ResourceKind {
  return value === "conversation"
    || value === "method"
    || value === "project"
    || value === "job"
    || value === "collection";
}

function normalizeSplitSizes(value: unknown, panelCount: number): number[] {
  const fallback = Array.from({ length: panelCount }, () => 100 / panelCount);
  if (!Array.isArray(value) || value.length !== panelCount) return fallback;
  const sizes = value.map((size) => Number(size));
  if (sizes.some((size) => !Number.isFinite(size) || size <= 0)) return fallback;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0) return fallback;
  return sizes.map((size) => (size / total) * 100);
}
