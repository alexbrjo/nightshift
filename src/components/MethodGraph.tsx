import {
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type Viewport,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import type {
  MethodDocument,
  MethodDraftIssue,
  MethodWorkflowNode,
  MethodDraftReadiness,
  MethodExecutionNodeSummary,
} from "../database";

const NODE_HEIGHT = 180;
const ROW_GAP = NODE_HEIGHT + 64;
const MAX_CONFIG_HINTS = 3;
const MAX_NODE_ISSUES = 3;
const METHOD_NODE_X = 0;
const RESOURCE_NODE_X = -340;
const RESOURCE_NODE_HEIGHT = 118;
const RESOURCE_NODE_GAP = 14;
const METHOD_NODE_WIDTH = 300;
const RESOURCE_NODE_WIDTH = 260;
const GRAPH_FIT_PADDING = 24;
const MIN_GRAPH_ZOOM = 0.18;
const MAX_GRAPH_ZOOM = 1.08;

type MethodGraphNodeData = {
  draftNode: MethodWorkflowNode & { status: string; label: string };
  incomingLabels: string[];
  blockerCount: number;
  warningCount: number;
  resourceCount: number;
  issues: MethodDraftIssue[];
  configHints: string[];
};

type MethodGraphResourceData = {
  resource: MethodWorkflowNode;
};

type MethodFlowNode = Node<MethodGraphNodeData, "method">;
type MethodResourceNode = Node<MethodGraphResourceData, "resource">;
type MethodAnyNode = MethodFlowNode | MethodResourceNode;

export interface MethodGraphElements {
  nodes: MethodAnyNode[];
  edges: Edge[];
}

interface FlowSize {
  width: number;
  height: number;
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

function effectiveConfigHints(draft: MethodDocument, node: MethodWorkflowNode) {
  const ownHints = configHints(node.config);
  if (ownHints.length > 0) return ownHints;
  if (node.type === "sample") {
    return [
      ["samples", draft.parameters?.samples],
      ["strategy", draft.parameters?.strategy],
    ]
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .slice(0, MAX_CONFIG_HINTS)
      .map(([key, value]) => `${key}: ${formatConfigValue(value)}`);
  }
  if (node.type !== "inference") return ownHints;

  const hints = [
    ["provider", draft.provider?.provider],
    ["server_url", draft.provider?.server_url],
    ["model_values", draft.parameters?.model_values],
    ["samples", draft.parameters?.samples],
    ["max_tokens", draft.parameters?.max_tokens],
    ["temperature", draft.parameters?.temperature],
  ]
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .slice(0, MAX_CONFIG_HINTS)
    .map(([key, value]) => `${key}: ${formatConfigValue(value)}`);

  return hints;
}

function isResourceNode(node: MethodWorkflowNode) {
  return node.type === "resource";
}

function isRunnableNode(node: MethodWorkflowNode) {
  return !isResourceNode(node);
}

function resourceKindLabel(kind: string | undefined) {
  switch (kind) {
    case "prompt":
    case "prompt_file":
      return "Prompt";
    case "data":
    case "data_file":
      return "Data";
    case "json_schema":
    case "json_schema_file":
      return "Schema";
    case "eval_script":
      return "Eval script";
    case "collection":
      return "Collection";
    case "api_key":
      return "API key";
    default:
      return (kind || "resource").replace(/_/g, " ");
  }
}

function resourceLocation(resource: MethodWorkflowNode) {
  return resource.path || resource.reference || resourceStatus(resource);
}

function buildNodeOrder(draft: MethodDocument) {
  const methodNodes = draft.workflow.nodes.filter(isRunnableNode);
  const graphEdges = methodEdges(draft).filter((edge) => {
    const source = draft.workflow.nodes.find((node) => node.id === edge.from);
    return !source || isRunnableNode(source);
  });
  const nodeIds = new Set(methodNodes.map((node) => node.id));
  const originalIndex = new Map(methodNodes.map((node, index) => [node.id, index]));
  const incomingCount = new Map(methodNodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();

  graphEdges.forEach((edge) => {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) return;
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  });

  const queue = methodNodes
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

  methodNodes
    .filter((node) => !orderedIds.includes(node.id))
    .sort((left, right) => (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0))
    .forEach((node) => orderedIds.push(node.id));

  return new Map(orderedIds.map((id, index) => [id, index]));
}

function issueAppliesToNode(
  issue: MethodDraftIssue,
  nodeId: string,
  resources: MethodWorkflowNode[],
) {
  return (
    issue.nodeId === nodeId ||
    Boolean(issue.resourceId && resources.some((resource) => resource.id === issue.resourceId))
  );
}

function issuesForNode(
  issues: MethodDraftIssue[],
  nodeId: string,
  resources: MethodWorkflowNode[],
) {
  return issues.filter((issue) => issueAppliesToNode(issue, nodeId, resources));
}

function nodeWithExecutionStatus(
  node: MethodWorkflowNode,
  executionNodes: MethodExecutionNodeSummary[],
): MethodWorkflowNode & { status?: string } {
  const executionNode = executionNodes.find((candidate) => candidate.nodeId === node.id);
  if (!executionNode) return node;
  return { ...node, status: executionNode.status };
}

function methodEdges(draft: MethodDocument) {
  return draft.workflow.nodes.flatMap((node) =>
    (node.depends_on ?? []).map((dep) => ({ from: dep, to: node.id })),
  );
}

function resourceStatus(resource: MethodWorkflowNode) {
  return resource.path || resource.reference ? "attached" : "missing";
}

function dependentResources(node: MethodWorkflowNode, nodeById: Map<string, MethodWorkflowNode>) {
  return (node.depends_on ?? [])
    .map((dep) => nodeById.get(dep))
    .filter((dep): dep is MethodWorkflowNode => Boolean(dep && isResourceNode(dep)));
}

function firstResourceConsumer(draft: MethodDocument, resourceId: string) {
  return draft.workflow.nodes.find((node) =>
    isRunnableNode(node) && (node.depends_on ?? []).includes(resourceId),
  );
}

function deriveMethodReadiness(draft: MethodDocument): MethodDraftReadiness {
  const blockers: MethodDraftIssue[] = [];
  const warnings: MethodDraftIssue[] = [];
  if (!draft.title.trim() || draft.title === "Untitled Method") {
    blockers.push({ code: "missing_title", message: "Add a specific Method title." });
  }
  if (!draft.objective.trim()) {
    blockers.push({ code: "missing_objective", message: "Describe the benchmark or experiment objective." });
  }
  if (draft.workflow.nodes.length === 0) {
    blockers.push({ code: "missing_nodes", message: "Add at least one Method node before validation or execution." });
  }
  const resources = draft.workflow.nodes.filter(isResourceNode);
  if (resources.length === 0) {
    warnings.push({ code: "missing_resources", message: "No resource nodes are attached yet." });
  }
  for (const resource of resources) {
    if (resourceStatus(resource) === "missing") {
      const consumer = firstResourceConsumer(draft, resource.id);
      blockers.push({
        code: "missing_resource",
        message: `Attach ${resourceKindLabel(resource.kind).toLowerCase()} for '${resource.label || resource.id}'.`,
        resourceId: resource.id,
        nodeId: consumer?.id,
      });
    }
  }
  return { status: blockers.length ? "drafting" : "ready", blockers, warnings };
}

function derivedNodeStatus(node: MethodWorkflowNode & { status?: string }, blockers: MethodDraftIssue[]) {
  if (node.status) return node.status;
  return blockers.length > 0 ? "blocked" : "ready";
}

function statusLabel(status: string) {
  return status
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusIcon(status: string) {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
    case "cancelled":
    case "not_implemented":
      return "×";
    default:
      return null;
  }
}

export function buildMethodGraphElements(
  draft: MethodDocument,
  executionNodes: MethodExecutionNodeSummary[] = [],
): MethodGraphElements {
  const allNodes = draft.workflow.nodes;
  const methodNodes = allNodes.filter(isRunnableNode);
  const resourceDraftNodes = allNodes.filter(isResourceNode);
  const graphEdges = methodEdges(draft);
  const readiness = deriveMethodReadiness(draft);
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const order = buildNodeOrder(draft);

  const nodes: MethodFlowNode[] = methodNodes.map((node) => {
    const displayNode = nodeWithExecutionStatus(node, executionNodes);
    const row = order.get(node.id) ?? 0;
    const incomingLabels = graphEdges
      .filter((edge) => edge.to === node.id && !isResourceNode(nodeById.get(edge.from) ?? node))
      .map((edge) => nodeById.get(edge.from)?.label || edge.from);
    const resources = dependentResources(node, nodeById);
    const blockers = issuesForNode(readiness.blockers, node.id, resources);
    const warnings = issuesForNode(readiness.warnings, node.id, resources);

    return {
      id: node.id,
      type: "method",
      position: { x: METHOD_NODE_X, y: row * ROW_GAP },
      data: {
        draftNode: {
          ...displayNode,
          label: displayNode.label || displayNode.id,
          status: derivedNodeStatus(displayNode, blockers),
        } as MethodWorkflowNode & { status: string; label: string },
        incomingLabels,
        blockerCount: blockers.length,
        warningCount: warnings.length,
        resourceCount: resources.length,
        issues: [...blockers, ...warnings],
        configHints: effectiveConfigHints(draft, node),
      },
    };
  });

  const nodeDataById = new Map(nodes.map((node) => [node.id, node.data]));
  const resourceNodes: MethodResourceNode[] = resourceDraftNodes.map((resource, index) => {
    const consumers = methodNodes
      .filter((node) => (node.depends_on ?? []).includes(resource.id))
      .map((node) => node.id);
    const consumerRows = consumers
      .map((nodeId) => order.get(nodeId))
      .filter((row): row is number => typeof row === "number");
    const firstRow = consumerRows.length ? Math.min(...consumerRows) : index;
    const siblingIndex = resourceDraftNodes
      .slice(0, index)
      .filter((other) => {
        const otherConsumerRows = methodNodes
          .filter((node) => (node.depends_on ?? []).includes(other.id))
          .map((node) => order.get(node.id))
          .filter((row): row is number => typeof row === "number");
        const otherFirstRow = otherConsumerRows.length ? Math.min(...otherConsumerRows) : 0;
        return otherFirstRow === firstRow;
      }).length;

    return {
      id: resource.id,
      type: "resource",
      position: {
        x: RESOURCE_NODE_X,
        y: firstRow * ROW_GAP + siblingIndex * (RESOURCE_NODE_HEIGHT + RESOURCE_NODE_GAP),
      },
      data: { resource },
    };
  });
  const edges: Edge[] = graphEdges.map((edge) => {
    const source = nodeById.get(edge.from);
    const isResourceEdge = Boolean(source && isResourceNode(source));
    const targetData = nodeDataById.get(edge.to);
    const issueCount = (targetData?.blockerCount ?? 0) + (targetData?.warningCount ?? 0);
    return {
      id: `${edge.from}-${edge.to}`,
      source: edge.from,
      target: edge.to,
      type: "smoothstep",
      sourceHandle: isResourceEdge ? "right" : "bottom",
      targetHandle: isResourceEdge ? "left" : "top",
      markerEnd: { type: MarkerType.ArrowClosed },
      label: !isResourceEdge && issueCount ? `${issueCount} issues` : undefined,
      className: `method-flow-edge${isResourceEdge ? " method-flow-resource-edge" : ""}`,
      labelClassName: "method-flow-edge-label",
    };
  });

  return { nodes: [...resourceNodes, ...nodes], edges };
}

function MethodGraphNode({ data }: NodeProps<MethodFlowNode>) {
  const { draftNode, incomingLabels, blockerCount, warningCount, resourceCount, issues, configHints } = data;
  const issueCount = blockerCount + warningCount;
  const shownIssues = issues.slice(0, MAX_NODE_ISSUES);
  const normalizedStatus = classSafeStatus(draftNode.status);
  const icon = statusIcon(normalizedStatus);

  return (
    <article className={`method-flow-node status-${normalizedStatus}`}>
      <Handle id="top" type="target" position={Position.Top} isConnectable={false} />
      <Handle id="left" type="target" position={Position.Left} isConnectable={false} />
      <div className="method-flow-node-header">
        <div>
          <strong>{draftNode.type}</strong>
        </div>
        <span className={`method-flow-status status-${normalizedStatus}`}>
          <span>{statusLabel(draftNode.status || "draft")}</span>
          {normalizedStatus === "running" && <span className="method-flow-recording-dot" aria-hidden="true" />}
          {icon && <span className="method-flow-status-icon" aria-hidden="true">{icon}</span>}
        </span>
      </div>
      <p className="method-flow-node-description">{draftNode.label || draftNode.id}</p>
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
      {shownIssues.length > 0 && (
        <div className="method-flow-node-issues" aria-label={`Issues for ${draftNode.id}`}>
          {shownIssues.map((issue) => (
            <span key={`${issue.code}-${issue.resourceId ?? issue.nodeId ?? issue.message}`}>
              {issue.message}
            </span>
          ))}
          {issues.length > shownIssues.length && (
            <span className="method-flow-more">+{issues.length - shownIssues.length} more issues</span>
          )}
        </div>
      )}
      <Handle id="bottom" type="source" position={Position.Bottom} isConnectable={false} />
    </article>
  );
}

function MethodGraphResourceNode({ data }: NodeProps<MethodResourceNode>) {
  const { resource } = data;
  const hasMissing = resourceStatus(resource) === "missing";

  return (
    <article className={`method-flow-resource-node ${hasMissing ? "status-missing" : ""}`}>
      <div className="method-flow-resource-node-title">
        <span>Input</span>
        <strong>{resource.label || resource.id}</strong>
      </div>
      <div className="method-flow-resource-node-list">
        <div>
          <span>{resourceKindLabel(resource.kind)}</span>
          <code>{resourceLocation(resource)}</code>
        </div>
      </div>
      <Handle id="right" type="source" position={Position.Right} isConnectable={false} />
    </article>
  );
}

const nodeTypes = {
  method: MethodGraphNode,
  resource: MethodGraphResourceNode,
};

function graphNodeDimensions(node: MethodAnyNode) {
  return node.type === "resource"
    ? { width: RESOURCE_NODE_WIDTH, height: RESOURCE_NODE_HEIGHT }
    : { width: METHOD_NODE_WIDTH, height: NODE_HEIGHT };
}

export function fitMethodGraphViewport(nodes: MethodGraphElements["nodes"], size: FlowSize): Viewport {
  if (nodes.length === 0 || size.width <= 0 || size.height <= 0) {
    return { x: 0, y: 0, zoom: 1 };
  }

  const bounds = nodes.reduce(
    (current, node) => {
      const dimensions = graphNodeDimensions(node);
      return {
        minX: Math.min(current.minX, node.position.x),
        minY: Math.min(current.minY, node.position.y),
        maxX: Math.max(current.maxX, node.position.x + dimensions.width),
        maxY: Math.max(current.maxY, node.position.y + dimensions.height),
      };
    },
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );

  const graphWidth = Math.max(1, bounds.maxX - bounds.minX);
  const graphHeight = Math.max(1, bounds.maxY - bounds.minY);
  const availableWidth = Math.max(1, size.width - GRAPH_FIT_PADDING * 2);
  const availableHeight = Math.max(1, size.height - GRAPH_FIT_PADDING * 2);
  const zoom = Math.min(
    Math.max(Math.min(availableWidth / graphWidth, availableHeight / graphHeight), MIN_GRAPH_ZOOM),
    MAX_GRAPH_ZOOM,
  );
  const x = (size.width - graphWidth * zoom) / 2 - bounds.minX * zoom;
  const y = Math.max(GRAPH_FIT_PADDING, (size.height - graphHeight * zoom) / 2) - bounds.minY * zoom;

  return { x, y, zoom };
}

interface MethodGraphProps {
  draft: MethodDocument;
  executionNodes?: MethodExecutionNodeSummary[];
}

export default function MethodGraph({ draft, executionNodes = [] }: MethodGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { nodes, edges } = useMemo(
    () => buildMethodGraphElements(draft, executionNodes),
    [draft, executionNodes],
  );
  const [flowSize, setFlowSize] = useState<FlowSize>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Viewport | undefined>();
  const graphSignature = [
    nodes.map((node) => `${node.id}:${node.position.x}:${node.position.y}`).join("|"),
    edges.map((edge) => edge.id).join("|"),
  ].join("::");

  const updateFlowSize = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    setFlowSize((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
  }, []);

  useEffect(() => {
    updateFlowSize();
    const container = containerRef.current;
    const resizeObserver = typeof ResizeObserver === "undefined" || !container
      ? null
      : new ResizeObserver(updateFlowSize);
    if (container) resizeObserver?.observe(container);
    window.addEventListener("resize", updateFlowSize);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateFlowSize);
    };
  }, [updateFlowSize]);

  const fittedViewport = useMemo(
    () => fitMethodGraphViewport(nodes, flowSize),
    [flowSize, graphSignature, nodes],
  );

  useEffect(() => {
    if (flowSize.width > 0 && flowSize.height > 0) {
      setViewport((current) =>
        current
          && current.x === fittedViewport.x
          && current.y === fittedViewport.y
          && current.zoom === fittedViewport.zoom
          ? current
          : fittedViewport,
      );
    }
  }, [fittedViewport, flowSize.height, flowSize.width]);

  if (nodes.length === 0) {
    return <div className="agent-empty-visual">No nodes yet.</div>;
  }

  return (
    <div ref={containerRef} className="method-flow" aria-label="Draft Method graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        viewport={viewport}
        onViewportChange={setViewport}
        minZoom={MIN_GRAPH_ZOOM}
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
