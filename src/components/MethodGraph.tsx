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
import type {
  MethodDocument,
  MethodDraftIssue,
  MethodWorkflowNode,
  MethodDraftReadiness,
  MethodResource,
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
const MAX_BUNDLE_RESOURCES = 4;

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
  resources: MethodResource[];
};

type MethodFlowNode = Node<MethodGraphNodeData, "method">;
type MethodResourceNode = Node<MethodGraphResourceData, "resource">;
type MethodAnyNode = MethodFlowNode | MethodResourceNode;

export interface MethodGraphElements {
  nodes: MethodAnyNode[];
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

function effectiveConfigHints(draft: MethodDocument, node: MethodWorkflowNode) {
  const ownHints = configHints(node.config);
  if (ownHints.length > 0 || node.type !== "inference") return ownHints;

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

function resourceKindLabel(kind: string) {
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
      return kind.replace(/_/g, " ");
  }
}

function resourceLocation(resource: MethodResource) {
  return resource.path || resource.reference || resourceStatus(resource);
}

function resourceBundleId(resources: MethodResource[]) {
  return `resource:${resources.map((resource) => resource.id).join("+")}`;
}

function buildNodeOrder(draft: MethodDocument) {
  const methodNodes = draft.workflow.nodes;
  const graphEdges = methodEdges(draft);
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
  resources: MethodResource[],
) {
  return (
    issue.nodeId === nodeId ||
    Boolean(issue.resourceId && resources.some((resource) => resource.id === issue.resourceId))
  );
}

function issuesForNode(
  issues: MethodDraftIssue[],
  nodeId: string,
  resources: MethodResource[],
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

function resourceConsumers(resource: MethodResource) {
  return resource.consumed_by ?? [];
}

function resourceStatus(resource: MethodResource) {
  return resource.path || resource.reference ? "attached" : "missing";
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
  if (draft.resources.length === 0) {
    warnings.push({ code: "missing_resources", message: "No resources are attached yet." });
  }
  for (const resource of draft.resources) {
    if (resourceStatus(resource) === "missing") {
      blockers.push({
        code: "missing_resource",
        message: `Attach ${resourceKindLabel(resource.kind).toLowerCase()} for '${resource.label || resource.id}'.`,
        resourceId: resource.id,
        nodeId: resourceConsumers(resource)[0],
      });
    }
  }
  return { status: blockers.length ? "drafting" : "ready", blockers, warnings };
}

function derivedNodeStatus(node: MethodWorkflowNode & { status?: string }, blockers: MethodDraftIssue[]) {
  if (node.status) return node.status;
  return blockers.length > 0 ? "blocked" : "ready";
}

export function buildMethodGraphElements(
  draft: MethodDocument,
  executionNodes: MethodExecutionNodeSummary[] = [],
): MethodGraphElements {
  const methodNodes = draft.workflow.nodes;
  const graphEdges = methodEdges(draft);
  const readiness = deriveMethodReadiness(draft);
  const nodeById = new Map(methodNodes.map((node) => [node.id, node]));
  const order = buildNodeOrder(draft);

  const nodes: MethodFlowNode[] = methodNodes.map((node) => {
    const displayNode = nodeWithExecutionStatus(node, executionNodes);
    const row = order.get(node.id) ?? 0;
    const incomingLabels = graphEdges
      .filter((edge) => edge.to === node.id)
      .map((edge) => nodeById.get(edge.from)?.label || edge.from);
    const resources = draft.resources.filter((resource) => resourceConsumers(resource).includes(node.id));
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
  const resourceGroups = new Map<string, MethodResource[]>();
  draft.resources.forEach((resource) => {
    const validConsumers = resourceConsumers(resource).filter((nodeId) => nodeById.has(nodeId)).sort();
    const key = validConsumers.length ? validConsumers.join("|") : `unused:${resource.id}`;
    resourceGroups.set(key, [...(resourceGroups.get(key) ?? []), resource]);
  });
  const groupedResources = [...resourceGroups.entries()].map(([key, resources]) => ({
    key,
    resources,
    consumers: key.startsWith("unused:") ? [] : key.split("|"),
  }));

  const resourceNodes: MethodResourceNode[] = groupedResources.map((group, index) => {
    const consumerRows = group.consumers
      .map((nodeId) => order.get(nodeId))
      .filter((row): row is number => typeof row === "number");
    const firstRow = consumerRows.length ? Math.min(...consumerRows) : index;
    const siblingIndex = groupedResources
      .slice(0, index)
      .filter((other) => {
        const otherRows = other.consumers
          .map((nodeId) => order.get(nodeId))
          .filter((row): row is number => typeof row === "number");
        const otherFirstRow = otherRows.length ? Math.min(...otherRows) : 0;
        return otherFirstRow === firstRow;
      }).length;

    const id = resourceBundleId(group.resources);
    return {
      id,
      type: "resource",
      position: {
        x: RESOURCE_NODE_X,
        y: firstRow * ROW_GAP + siblingIndex * (RESOURCE_NODE_HEIGHT + RESOURCE_NODE_GAP),
      },
      data: { resources: group.resources },
    };
  });
  const edges: Edge[] = graphEdges.map((edge) => {
    const targetData = nodeDataById.get(edge.to);
    const issueCount = (targetData?.blockerCount ?? 0) + (targetData?.warningCount ?? 0);
    return {
      id: `${edge.from}-${edge.to}`,
      source: edge.from,
      target: edge.to,
      type: "smoothstep",
      sourceHandle: "bottom",
      targetHandle: "top",
      markerEnd: { type: MarkerType.ArrowClosed },
      label: issueCount ? `${issueCount} issues` : undefined,
      className: "method-flow-edge",
      labelClassName: "method-flow-edge-label",
    };
  });
  const resourceEdges: Edge[] = groupedResources.flatMap((group) =>
    group.consumers
      .map((nodeId) => ({
        id: `${resourceBundleId(group.resources)}-${nodeId}`,
        source: resourceBundleId(group.resources),
        target: nodeId,
        type: "smoothstep",
        sourceHandle: "right",
        targetHandle: "left",
        markerEnd: { type: MarkerType.ArrowClosed },
        className: "method-flow-edge method-flow-resource-edge",
      })),
  );

  return { nodes: [...resourceNodes, ...nodes], edges: [...resourceEdges, ...edges] };
}

function MethodGraphNode({ data }: NodeProps<MethodFlowNode>) {
  const { draftNode, incomingLabels, blockerCount, warningCount, resourceCount, issues, configHints } = data;
  const issueCount = blockerCount + warningCount;
  const shownIssues = issues.slice(0, MAX_NODE_ISSUES);

  return (
    <article className={`method-flow-node status-${classSafeStatus(draftNode.status)}`}>
      <Handle id="top" type="target" position={Position.Top} isConnectable={false} />
      <Handle id="left" type="target" position={Position.Left} isConnectable={false} />
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
  const { resources } = data;
  const shownResources = resources.slice(0, MAX_BUNDLE_RESOURCES);
  const hasMissing = resources.some((resource) => resourceStatus(resource) === "missing");

  return (
    <article className={`method-flow-resource-node ${hasMissing ? "status-missing" : ""}`}>
      <div className="method-flow-resource-node-title">
        <span>{resources.length === 1 ? "Input" : "Inputs"}</span>
        <strong>{resources.length === 1 ? resources[0].label || resources[0].id : `${resources.length} shared inputs`}</strong>
      </div>
      <div className="method-flow-resource-node-list">
        {shownResources.map((resource) => (
          <div key={resource.id}>
            <span>{resourceKindLabel(resource.kind)}</span>
            <code>{resourceLocation(resource)}</code>
          </div>
        ))}
        {resources.length > shownResources.length && (
          <span className="method-flow-more">+{resources.length - shownResources.length} more inputs</span>
        )}
      </div>
      <Handle id="right" type="source" position={Position.Right} isConnectable={false} />
    </article>
  );
}

const nodeTypes = {
  method: MethodGraphNode,
  resource: MethodGraphResourceNode,
};

interface MethodGraphProps {
  draft: MethodDocument;
  executionNodes?: MethodExecutionNodeSummary[];
}

export default function MethodGraph({ draft, executionNodes = [] }: MethodGraphProps) {
  const { nodes, edges } = buildMethodGraphElements(draft, executionNodes);

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
        defaultViewport={{ x: 390, y: 58, zoom: 1.08 }}
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
