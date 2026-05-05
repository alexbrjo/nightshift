import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import type { DefinitionKind, JobDefinition } from "../database";
import { useActiveRefresh } from "../hooks/useActiveRefresh";
import {
  definitionCreate,
  definitionListByRoot,
  definitionListRoots,
} from "../api/orchestrator";
import InputDialog from "./InputDialog";
import { useToast } from "./Toast";

interface DefinitionTreeSidebarProps {
  selectedId?: number | null;
  onSelectDefinition: (defId: number) => void;
  /** Called after a `+ New` root is created so the parent page can route to it. */
  onRootCreated?: (defId: number) => void;
  /** Called after `+ Add child` so the parent page can route to the new child. */
  onChildCreated?: (defId: number, parentDefId: number) => void;
  refreshKey?: number;
  isActive?: boolean;
  /** Sidebar header label. Differs across pages (Definitions vs Job Executions). */
  title?: string;
}

interface TreeNode {
  def: JobDefinition;
  children: TreeNode[];
}

function kindLabel(kind: DefinitionKind | null): string {
  switch (kind) {
    case "inference":
      return "Inference";
    case "group":
      return "Group";
    case "analysis":
      return "Analysis";
    case "js_action":
      return "JS Action";
    default:
      return "Unsaved";
  }
}

/** Tree-shape the flat `definition_list_by_root` response. */
function buildTree(rows: JobDefinition[]): TreeNode[] {
  const byParent = new Map<number | null, JobDefinition[]>();
  for (const d of rows) {
    const arr = byParent.get(d.parentId ?? null) ?? [];
    arr.push(d);
    byParent.set(d.parentId ?? null, arr);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.position - b.position || a.id - b.id);
  }
  const build = (parentId: number | null): TreeNode[] =>
    (byParent.get(parentId) ?? []).map((d) => ({ def: d, children: build(d.id) }));
  return build(null);
}

/**
 * Tree-shaped sidebar for definitions. Loads roots, then lazy-loads each
 * root's full subtree on first expand. Displays a kind chip + version badge
 * per node so the topology is readable at a glance.
 *
 * Reused by both DefinitionsPage and JobExecutionsPage so the user sees the
 * same topology in both contexts.
 */
export default function DefinitionTreeSidebar({
  selectedId = null,
  onSelectDefinition,
  onRootCreated,
  onChildCreated,
  refreshKey = 0,
  isActive = true,
  title = "Definitions",
}: DefinitionTreeSidebarProps) {
  const [roots, setRoots] = useState<JobDefinition[]>([]);
  const [subtrees, setSubtrees] = useState<Map<number, JobDefinition[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [creatingChildOf, setCreatingChildOf] = useState<number | null>(null);
  const [newRootBusy, setNewRootBusy] = useState(false);
  // Tauri 2 webviews don't expose window.prompt — use the in-app InputDialog
  // for the name prompt. `dialog` carries the kind of action we're in the
  // middle of so a single component handles both flows.
  const [dialog, setDialog] = useState<
    | { kind: "new-root" }
    | { kind: "add-child"; parent: JobDefinition }
    | null
  >(null);
  const hasLoadedRef = useRef(false);
  const { showToast } = useToast();

  // Mirror `expanded` and `subtrees` in refs so the polling callback can read
  // the latest values without re-creating itself on every state change. The
  // earlier shape closed over the initial empty `subtrees` map and reset
  // it back to empty every 5s, which collapsed the visible tree.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const subtreesRef = useRef(subtrees);
  subtreesRef.current = subtrees;

  const refreshAll = useCallback(async () => {
    if (!hasLoadedRef.current) setIsLoading(true);
    try {
      const list = await definitionListRoots();
      setRoots(Array.isArray(list) ? list : []);
      hasLoadedRef.current = true;
      // Refresh any already-expanded subtrees so renames/moves propagate
      // without forcing the user to collapse + re-expand.
      const ids = Array.from(expandedRef.current);
      if (ids.length === 0) return;
      const refreshed = new Map(subtreesRef.current);
      for (const rootId of ids) {
        try {
          refreshed.set(rootId, await definitionListByRoot(rootId));
        } catch (e) {
          console.error("Failed to refresh subtree:", e);
        }
      }
      setSubtrees(refreshed);
    } catch (error) {
      console.error("Failed to load definitions:", error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useActiveRefresh({
    isActive,
    refresh: refreshAll,
    intervalMs: 5000,
    refreshToken: refreshKey,
  });

  useEffect(() => {
    if (!isActive) return;
    const unlisteners: Array<Promise<() => void>> = [
      listen("definition-version-created", () => void refreshAll()),
      listen("definition-updated", () => void refreshAll()),
    ];
    return () => {
      unlisteners.forEach((p) => void p.then((fn) => fn()));
    };
  }, [isActive, refreshAll]);

  const toggleExpand = useCallback(
    async (rootId: number) => {
      const next = new Set(expanded);
      if (next.has(rootId)) {
        next.delete(rootId);
        setExpanded(next);
        return;
      }
      next.add(rootId);
      setExpanded(next);
      if (!subtrees.has(rootId)) {
        try {
          const subtree = await definitionListByRoot(rootId);
          setSubtrees((prev) => new Map(prev).set(rootId, subtree));
        } catch (e) {
          console.error("Failed to load subtree:", e);
        }
      }
    },
    [expanded, subtrees],
  );

  const handleNewRoot = useCallback(() => {
    setDialog({ kind: "new-root" });
  }, []);

  const handleAddChild = useCallback((parentDef: JobDefinition) => {
    setDialog({ kind: "add-child", parent: parentDef });
  }, []);

  const submitNewRoot = useCallback(
    async (name: string) => {
      setDialog(null);
      setNewRootBusy(true);
      try {
        const id = await definitionCreate({
          parentId: null,
          name,
          position: roots.length,
        });
        await refreshAll();
        onRootCreated?.(id);
        onSelectDefinition(id);
      } catch (e) {
        console.error("Failed to create root:", e);
        showToast(`Failed to create: ${e instanceof Error ? e.message : String(e)}`, "error");
      } finally {
        setNewRootBusy(false);
      }
    },
    [refreshAll, onRootCreated, onSelectDefinition, roots.length, showToast],
  );

  const submitAddChild = useCallback(
    async (parentDef: JobDefinition, name: string) => {
      setDialog(null);
      setCreatingChildOf(parentDef.id);
      try {
        const existing = subtrees.get(parentDef.rootId) ?? [];
        const sibCount = existing.filter((d) => d.parentId === parentDef.id).length;
        const id = await definitionCreate({
          parentId: parentDef.id,
          name,
          position: sibCount,
        });
        setExpanded((prev) => new Set(prev).add(parentDef.rootId));
        const subtree = await definitionListByRoot(parentDef.rootId);
        setSubtrees((prev) => new Map(prev).set(parentDef.rootId, subtree));
        onChildCreated?.(id, parentDef.id);
        onSelectDefinition(id);
      } catch (e) {
        console.error("Failed to add child:", e);
        showToast(`Failed to add: ${e instanceof Error ? e.message : String(e)}`, "error");
      } finally {
        setCreatingChildOf(null);
      }
    },
    [onChildCreated, onSelectDefinition, subtrees, showToast],
  );

  const trees = useMemo(() => {
    return roots.map((root) => {
      const subtree = subtrees.get(root.id) ?? [root];
      return buildTree(subtree).find((n) => n.def.id === root.id) ?? {
        def: root,
        children: [],
      };
    });
  }, [roots, subtrees]);

  return (
    <aside className="job-list-sidebar definition-tree-sidebar">
      <header className="job-list-header">
        <h2>{title}</h2>
        <button
          className="btn-primary btn-small"
          onClick={handleNewRoot}
          disabled={newRootBusy}
          title="Create a new experiment (defaults to a group root)"
        >
          + New
        </button>
      </header>

      {isLoading ? (
        <div className="loading-indicator">Loading…</div>
      ) : roots.length === 0 ? (
        <div className="job-list-empty">
          <p>No definitions yet.</p>
          <button
            className="btn-secondary btn-small"
            onClick={handleNewRoot}
            disabled={newRootBusy}
          >
            Create your first experiment
          </button>
        </div>
      ) : (
        <ul className="definition-tree">
          {trees.map((node) => (
            <TreeNodeView
              key={node.def.id}
              node={node}
              depth={0}
              expanded={expanded}
              onToggleExpand={toggleExpand}
              selectedId={selectedId}
              onSelect={onSelectDefinition}
              onAddChild={handleAddChild}
              busyChildOf={creatingChildOf}
            />
          ))}
        </ul>
      )}

      {dialog?.kind === "new-root" && (
        <InputDialog
          title="New experiment"
          label="Name (defaults to a group root)"
          defaultValue=""
          onSubmit={(name) => void submitNewRoot(name)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "add-child" && (
        <InputDialog
          title={`Add child under '${dialog.parent.name}'`}
          label="Name"
          defaultValue=""
          onSubmit={(name) => void submitAddChild(dialog.parent, name)}
          onCancel={() => setDialog(null)}
        />
      )}
    </aside>
  );
}

interface TreeNodeViewProps {
  node: TreeNode;
  depth: number;
  expanded: Set<number>;
  onToggleExpand: (rootId: number) => void;
  selectedId: number | null;
  onSelect: (defId: number) => void;
  onAddChild: (def: JobDefinition) => void;
  busyChildOf: number | null;
}

function TreeNodeView({
  node,
  depth,
  expanded,
  onToggleExpand,
  selectedId,
  onSelect,
  onAddChild,
  busyChildOf,
}: TreeNodeViewProps) {
  const { def, children } = node;
  const isGroup = def.currentKind === "group";
  const isExpanded = depth === 0 ? expanded.has(def.id) : true;
  const versionBadge =
    def.currentVersionId === null ? "Unsaved" : `v${def.currentVersionId}`;
  const versionClass =
    def.currentVersionId === null ? "status-pending" : "status-completed";
  // At depth 0, show the expand toggle for any group (children are
  // lazy-loaded on first expand, so we don't know the count up front)
  // and for any node that already has known children. Non-group leaves
  // get the spacer.
  const showToggle = depth === 0 && (isGroup || children.length > 0);

  return (
    <li
      className={`tree-node tree-node-depth-${depth}`}
      style={{ paddingLeft: depth === 0 ? undefined : `${depth * 12}px` }}
    >
      <div
        className={`tree-node-row${selectedId === def.id ? " selected" : ""}`}
      >
        {showToggle ? (
          <button
            type="button"
            className="tree-expand-toggle"
            onClick={() => onToggleExpand(def.id)}
            aria-label={isExpanded ? "Collapse" : "Expand"}
            aria-expanded={isExpanded}
          >
            {isExpanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="tree-expand-spacer" />
        )}
        <button
          type="button"
          className="tree-node-label"
          onClick={() => onSelect(def.id)}
        >
          <span className="job-name">{def.name}</span>
          <span className="job-type-badge">{kindLabel(def.currentKind)}</span>
          <span className={`status-badge ${versionClass}`}>{versionBadge}</span>
        </button>
        {isGroup && (
          <button
            type="button"
            className="tree-node-add-child"
            onClick={() => onAddChild(def)}
            disabled={busyChildOf === def.id}
            title="Add a child definition under this group"
          >
            +
          </button>
        )}
      </div>
      {isExpanded && children.length > 0 && (
        <ul className="tree-node-children">
          {children.map((child) => (
            <TreeNodeView
              key={child.def.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              selectedId={selectedId}
              onSelect={onSelect}
              onAddChild={onAddChild}
              busyChildOf={busyChildOf}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
