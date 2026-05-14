import {
  Controls,
  Handle,
  Position,
  ReactFlow,
  type NodeProps,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@xyflow/react/dist/style.css";
import type { MethodDocument, MethodExecutionNodeSummary } from "../../database";
import {
  MAX_NODE_ISSUES,
  MIN_GRAPH_ZOOM,
  buildMethodGraphElements,
  classSafeStatus,
  fitMethodGraphViewport,
  resourceKindLabel,
  resourceLocation,
  resourceStatus,
  statusIcon,
  statusLabel,
  type FlowSize,
  type MethodFlowNode,
  type MethodResourceNode,
} from "./graphModel";

export { buildMethodGraphElements, fitMethodGraphViewport } from "./graphModel";

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
  const flowKey = `${graphSignature}:${flowSize.width}:${flowSize.height}`;

  if (nodes.length === 0) {
    return <div className="agent-empty-visual">No nodes yet.</div>;
  }

  return (
    <div ref={containerRef} className="method-flow" aria-label="Draft Method graph">
      <ReactFlow
        key={flowKey}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        defaultViewport={fittedViewport}
        minZoom={MIN_GRAPH_ZOOM}
        maxZoom={1.8}
        panOnDrag
        panOnScroll
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: "smoothstep" }}
      >
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
