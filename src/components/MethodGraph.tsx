import {
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { MethodDraft, MethodDraftNode } from "../database";

const NODE_HEIGHT = 122;
const ROW_GAP = NODE_HEIGHT + 64;
const MAX_CONFIG_HINTS = 3;

type MethodGraphNodeData = {
  draftNode: MethodDraftNode;
  incomingLabels: string[];
  blockerCount: number;
  warningCount: number;
  resourceCount: number;
  configHints: string[];
};

type MethodFlowNode = Node<MethodGraphNodeData, "method">;

export interface MethodGraphElements {
  nodes: MethodFlowNode[];
  edges: Edge[];
}

function classSafeStatus(status: string) {
  return status.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
}

function formatConfigValue(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  if (value && typeof value === "object") return "object";
  return "unset";
}

function configHints(config: Record<string, unknown> | undefined) {
  if (!config) return [];
  return Object.entries(config)
    .slice(0, MAX_CONFIG_HINTS)
    .map(([key, value]) => `${key}: ${formatConfigValue(value)}`);
}

function buildNodeOrder(draft: MethodDraft) {
  const nodeIds = new Set(draft.nodes.map((node) => node.id));
  const originalIndex = new Map(draft.nodes.map((node, index) => [node.id, index]));
  const incomingCount = new Map(draft.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();

  draft.edges.forEach((edge) => {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) return;
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  });

  const queue = draft.nodes
    .filter((node) => incomingCount.get(node.id) === 0)
    .map((node) => node.id);
  const orderedIds: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    orderedIds.push(id);
    (outgoing.get(id) ?? []).forEach((targetId) => {
      incomingCount.set(targetId, (incomingCount.get(targetId) ?? 0) - 1);
      if (incomingCount.get(targetId) === 0) {
        queue.push(targetId);
      }
    });
  }

  draft.nodes
    .filter((node) => !orderedIds.includes(node.id))
    .sort((left, right) => (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0))
    .forEach((node) => orderedIds.push(node.id));

  return new Map(orderedIds.map((id, index) => [id, index]));
}

export function buildMethodGraphElements(draft: MethodDraft): MethodGraphElements {
  const nodeById = new Map(draft.nodes.map((node) => [node.id, node]));
  const order = buildNodeOrder(draft);

  const nodes: MethodFlowNode[] = draft.nodes.map((node) => {
    const row = order.get(node.id) ?? 0;
    const incomingLabels = draft.edges
      .filter((edge) => edge.to === node.id)
      .map((edge) => nodeById.get(edge.from)?.label || edge.from);

    return {
      id: node.id,
      type: "method",
      position: { x: 0, y: row * ROW_GAP },
      data: {
        draftNode: node,
        incomingLabels,
        blockerCount: draft.readiness.blockers.filter((issue) => issue.nodeId === node.id).length,
        warningCount: draft.readiness.warnings.filter((issue) => issue.nodeId === node.id).length,
        resourceCount: draft.resources.filter((resource) => resource.consumedBy.includes(node.id)).length,
        configHints: configHints(node.config),
      },
    };
  });

  const edges: Edge[] = draft.edges.map((edge) => ({
    id: `${edge.from}-${edge.to}`,
    source: edge.from,
    target: edge.to,
    type: "smoothstep",
    sourceHandle: "bottom",
    targetHandle: "top",
    markerEnd: { type: MarkerType.ArrowClosed },
    className: "method-flow-edge",
  }));

  return { nodes, edges };
}

function MethodGraphNode({ data }: NodeProps<MethodFlowNode>) {
  const { draftNode, incomingLabels, blockerCount, warningCount, resourceCount, configHints } = data;
  const issueCount = blockerCount + warningCount;

  return (
    <article className={`method-flow-node status-${classSafeStatus(draftNode.status)}`}>
      <Handle id="top" type="target" position={Position.Top} isConnectable={false} />
      <div className="method-flow-node-header">
        <div>
          <strong>{draftNode.label || draftNode.id}</strong>
          <span>{draftNode.type}</span>
        </div>
        <span className="method-flow-status">{draftNode.status || "draft"}</span>
      </div>
      <div className="method-flow-node-meta" aria-label={`Graph details for ${draftNode.id}`}>
        <span>{incomingLabels.length ? `${incomingLabels.length} deps` : "source"}</span>
        <span>{resourceCount ? `${resourceCount} resources` : "no resources"}</span>
        <span>{issueCount ? `${issueCount} issues` : "no issues"}</span>
      </div>
      <div className="method-flow-config">
        {configHints.length > 0 ? (
          configHints.map((hint) => <span key={hint}>{hint}</span>)
        ) : (
          <span>Config not set</span>
        )}
      </div>
      <Handle id="bottom" type="source" position={Position.Bottom} isConnectable={false} />
    </article>
  );
}

const nodeTypes = {
  method: MethodGraphNode,
};

interface MethodGraphProps {
  draft: MethodDraft;
}

export default function MethodGraph({ draft }: MethodGraphProps) {
  const { nodes, edges } = buildMethodGraphElements(draft);

  if (nodes.length === 0) {
    return <div className="agent-empty-visual">No nodes yet.</div>;
  }

  return (
    <div className="method-flow" aria-label="Draft Method graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        defaultViewport={{ x: 84, y: 58, zoom: 1.12 }}
        minZoom={0.7}
        maxZoom={1.8}
        panOnScroll
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: "smoothstep" }}
      >
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
