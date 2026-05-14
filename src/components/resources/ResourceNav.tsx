import type { ReactNode } from "react";
import {
  DropperIcon,
  MethodIcon,
  NightShiftIcon,
  RackIcon,
  TestTubeIcon,
} from "../ui/icons";
import type { ResourceKind, SidebarMode } from "../../layout";

export const RESOURCE_BUTTONS: Array<{ kind: ResourceKind; icon: ReactNode; label: string }> = [
  { kind: "conversation", icon: <RackIcon />, label: "Conversations" },
  { kind: "method", icon: <MethodIcon />, label: "Methods" },
  { kind: "project", icon: <DropperIcon />, label: "Project" },
  { kind: "job", icon: <TestTubeIcon />, label: "Jobs" },
];

function ResourceNavButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`sidebar-btn ${active ? "active" : ""}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      <span>{icon}</span>
    </button>
  );
}

export default function ResourceNav({
  sidebarMode,
  activeResourceKind,
  isDark,
  onToggleTheme,
  onSetActiveResourceKind,
  onToggleSidebar,
}: {
  sidebarMode: SidebarMode;
  activeResourceKind: ResourceKind;
  isDark: boolean;
  onToggleTheme: () => void;
  onSetActiveResourceKind: (kind: ResourceKind) => void;
  onToggleSidebar: () => void;
}) {
  return (
    <aside className={`sidebar unified-sidebar ${sidebarMode}`}>
      <button
        type="button"
        className="sidebar-logo"
        title={isDark ? "Switch to dumpster theme" : "Switch to midnight theme"}
        aria-pressed={isDark}
        onClick={onToggleTheme}
      >
        <NightShiftIcon />
      </button>
      <nav className="sidebar-nav" aria-label="Resources">
        {RESOURCE_BUTTONS.map((resource) => (
          <ResourceNavButton
            key={resource.kind}
            active={sidebarMode === "expanded" && activeResourceKind === resource.kind}
            icon={resource.icon}
            label={resource.label}
            onClick={() => onSetActiveResourceKind(resource.kind)}
          />
        ))}
      </nav>
      <button
        type="button"
        className="sidebar-collapse-btn"
        onClick={onToggleSidebar}
        title={sidebarMode === "expanded" ? "Collapse resource sidebar" : "Expand resource sidebar"}
        aria-label={sidebarMode === "expanded" ? "Collapse resource sidebar" : "Expand resource sidebar"}
      >
        {sidebarMode === "expanded" ? "‹" : "›"}
      </button>
    </aside>
  );
}
