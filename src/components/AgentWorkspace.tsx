import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ChatMethodAgentOutput,
  MethodArtifactSummary,
  MethodExecutionEventSummary,
  MethodExecutionNodeSummary,
  MethodExecutionSummary,
  MethodFileRef,
  MethodManifest,
  MethodPreflightResult,
  MethodSummary,
} from "../database";

const BASE_METHOD: MethodManifest = {
  schema_version: 1,
  id: "edge-method",
  title: "Edge model comparison",
  objective: "Compare a local model on a frozen prompt and data file.",
  files: [],
  provider: {
    provider: "Local",
    server_url: "http://localhost:1234",
    model: "local-model",
  },
  parameters: {
    output_mode: "Unstructured",
    samples: 1,
    strategy: "single",
  },
  workflow: {
    nodes: [
      { id: "generate", type: "inference", depends_on: [] },
      { id: "analysis", type: "analysis", depends_on: ["generate"] },
    ],
  },
};

interface MethodExecutionEventPayload {
  executionId: number;
  nodeId?: string;
  eventType?: string;
  payload?: Record<string, unknown>;
}

interface ChatMessage {
  id: number;
  role: "assistant" | "user";
  text: string;
}

function cloneMethod(method: MethodManifest) {
  return JSON.parse(JSON.stringify(method)) as MethodManifest;
}

function extractPaths(text: string) {
  const matches = text.match(/[A-Za-z0-9_./-]+\.(?:jinja2|j2|jsonl|json|schema\.json|js)/g) ?? [];
  return Array.from(new Set(matches.map((match) => match.replace(/[),.;]+$/g, ""))));
}

function classifyPath(path: string) {
  if (/\.(jinja2|j2)$/i.test(path)) return "prompt";
  if (/schema\.json$/i.test(path) || /schema/i.test(path)) return "schema";
  if (/\.js$/i.test(path)) return "script";
  return "data";
}

function stableFileId(kind: string) {
  return kind === "script" ? "eval_script" : kind;
}

function assignFileToDraft(method: MethodManifest, path: string): MethodManifest {
  const kind = classifyPath(path);
  const baseId = stableFileId(kind);
  const files = [...(method.files ?? [])];
  const existingIndex = files.findIndex((file) => file.kind === kind);
  const nextFile: MethodFileRef = {
    id: existingIndex >= 0 ? files[existingIndex].id : baseId,
    kind,
    path,
  };
  if (existingIndex >= 0) {
    files[existingIndex] = nextFile;
  } else {
    files.push(nextFile);
  }
  return { ...method, files };
}

function mergeFileAnswers(method: MethodManifest, text: string) {
  return extractPaths(text).reduce(assignFileToDraft, method);
}

function preflightQuestion(preflight: MethodPreflightResult) {
  const blocker = preflight.blockers[0];
  if (!blocker) return null;
  if (blocker.code === "missing_file") {
    const kind = blocker.fileKind ?? "required";
    if (blocker.path) {
      return `${blocker.message} Which ${kind} file should I use instead?`;
    }
    return `${blocker.message}. Which ${kind} file should I use?`;
  }
  return blocker.message;
}

function eventMessage(eventType?: string, payload?: Record<string, unknown>) {
  if (!eventType) return null;
  if (eventType === "inference_job_created") {
    return `Created inference job #${payload?.jobId} for ${payload?.model ?? "model"} (${payload?.samples ?? 1} sample${payload?.samples === 1 ? "" : "s"}).`;
  }
  if (eventType === "sweep_model_started") {
    return `Starting inference for ${payload?.model ?? "model"}.`;
  }
  if (eventType !== "node_job_event") return null;
  if (payload?.type === "Started") {
    return `Inference job #${payload.job_id} started with ${payload.total_samples ?? 0} sample${payload.total_samples === 1 ? "" : "s"}.`;
  }
  if (payload?.type === "Completed") {
    return `Inference job #${payload.job_id} completed: ${payload.success_count ?? 0} succeeded, ${payload.failure_count ?? 0} failed.`;
  }
  if (payload?.type === "Failed") {
    return `Inference job #${payload.job_id} failed: ${payload.error}`;
  }
  return null;
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function isActiveStatus(status?: string) {
  return status === "queued" || status === "running" || status === "paused" || status === "pause_requested";
}

function formatArtifactPreview(content: string, storageKind: string) {
  if (storageKind !== "inline_json") return content;
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function exportArtifact(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function AgentWorkspace() {
  const [methods, setMethods] = useState<MethodSummary[]>([]);
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null);
  const [draftMethod, setDraftMethod] = useState<MethodManifest | null>(cloneMethod(BASE_METHOD));
  const [manifest, setManifest] = useState<MethodManifest | null>(null);
  const [executions, setExecutions] = useState<MethodExecutionSummary[]>([]);
  const [selectedExecutionId, setSelectedExecutionId] = useState<number | null>(null);
  const [nodes, setNodes] = useState<MethodExecutionNodeSummary[]>([]);
  const [events, setEvents] = useState<MethodExecutionEventSummary[]>([]);
  const [artifacts, setArtifacts] = useState<MethodArtifactSummary[]>([]);
  const [artifactContents, setArtifactContents] = useState<Record<number, string>>({});
  const [preflight, setPreflight] = useState<MethodPreflightResult | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      role: "assistant",
      text: "Tell me what you want to measure. I’ll draft a Method, show the workflow, and execute it when you say so.",
    },
  ]);

  const selectedMethod = useMemo(
    () => methods.find((method) => method.id === selectedMethodId) ?? null,
    [methods, selectedMethodId],
  );

  const selectedExecution = useMemo(
    () => executions.find((execution) => execution.id === selectedExecutionId) ?? null,
    [executions, selectedExecutionId],
  );

  const visualMethod = manifest ?? draftMethod;
  const resultArtifacts = useMemo(
    () => artifacts.filter((artifact) => artifact.artifactType === "aggregate" || artifact.artifactType === "analysis"),
    [artifacts],
  );
  const visualNodes =
    nodes.length > 0
      ? nodes
      : visualMethod?.workflow.nodes.map((node, index) => ({
          id: index,
          executionId: 0,
          nodeId: node.id,
          nodeType: node.type,
          status: selectedMethod ? "saved" : "draft",
        })) ?? [];

  const addMessage = useCallback((role: ChatMessage["role"], text: string) => {
    setMessages((current) => [...current, { id: Date.now() + current.length, role, text }]);
  }, []);

  const runPreflight = useCallback(async (method: MethodManifest) => {
    const result = await invoke<MethodPreflightResult>("preflight_method", { input: { method } });
    setPreflight(result);
    return result;
  }, []);

  const askForPreflightBlockers = useCallback(
    (result: MethodPreflightResult) => {
      const question = preflightQuestion(result);
      addMessage(
        "assistant",
        question ?? "This Method is still in draft. I need one more detail before I can save or execute it.",
      );
    },
    [addMessage],
  );

  const loadMethods = useCallback(async () => {
    const rows = await invoke<MethodSummary[]>("list_methods");
    setMethods(rows);
  }, []);

  const loadExecutions = useCallback(async (methodId?: string | null) => {
    const rows = await invoke<MethodExecutionSummary[]>("list_method_executions", {
      methodId: methodId ?? null,
    });
    setExecutions(rows);
    setSelectedExecutionId((current) => current ?? rows[0]?.id ?? null);
  }, []);

  const loadExecutionDetails = useCallback(async (executionId: number | null) => {
    if (!executionId) {
      setNodes([]);
      setEvents([]);
      setArtifacts([]);
      setArtifactContents({});
      return;
    }
    const [nodeRows, eventRows, artifactRows] = await Promise.all([
      invoke<MethodExecutionNodeSummary[]>("get_method_execution_nodes", { executionId }),
      invoke<MethodExecutionEventSummary[]>("get_method_execution_events", { executionId }),
      invoke<MethodArtifactSummary[]>("get_method_execution_artifacts", { executionId }),
    ]);
    setNodes(nodeRows);
    setEvents(eventRows);
    setArtifacts(artifactRows);

    const inlineArtifacts = artifactRows.filter((artifact) => artifact.storageKind.startsWith("inline_"));
    const entries = await Promise.all(
      inlineArtifacts.map(async (artifact) => {
        const content = await invoke<string>("read_method_artifact", { artifactId: artifact.id });
        return [artifact.id, content] as const;
      }),
    );
    setArtifactContents(Object.fromEntries(entries));
  }, []);

  const selectMethod = useCallback(
    async (id: string | null) => {
      setSelectedMethodId(id);
      setSelectedExecutionId(null);
      setNodes([]);
      setEvents([]);
      setArtifacts([]);
      setArtifactContents({});
      setPreflight(null);
      if (!id) {
        setManifest(null);
        setDraftMethod(cloneMethod(BASE_METHOD));
        return;
      }
      const method = await invoke<MethodManifest>("get_method", { id });
      setManifest(method);
      setDraftMethod(null);
      await loadExecutions(id);
    },
    [loadExecutions],
  );

  useEffect(() => {
    loadMethods().catch((err) => setError(String(err)));
  }, [loadMethods]);

  useEffect(() => {
    loadExecutionDetails(selectedExecutionId).catch((err) => setError(String(err)));
  }, [selectedExecutionId, loadExecutionDetails]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<MethodExecutionEventPayload>("method-execution-event", (event) => {
      if (cancelled) return;
      const executionId = event.payload.executionId;
      if (selectedExecutionId && selectedExecutionId !== executionId) return;
      const message = eventMessage(event.payload.eventType, event.payload.payload);
      if (message) addMessage("assistant", message);
      loadExecutions(selectedMethodId).catch((err) => setError(String(err)));
      loadExecutionDetails(executionId).catch((err) => setError(String(err)));
      setSelectedExecutionId(executionId);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((err) => setError(String(err)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addMessage, loadExecutionDetails, loadExecutions, selectedExecutionId, selectedMethodId]);

  const draftWithAgent = useCallback(
    async (text: string) => {
      setError(null);
      try {
        const response = await invoke<ChatMethodAgentOutput>("chat_method_agent", {
          input: { message: text, currentMethod: draftMethod ?? manifest ?? BASE_METHOD },
        });
        if (response.message) addMessage("assistant", response.message);
        response.questions.forEach((question) => addMessage("assistant", question));
        if (response.method) {
          const next = response.method;
          setDraftMethod(next);
          setManifest(null);
          setSelectedMethodId(null);
          setSelectedExecutionId(null);
          setNodes([]);
          setEvents([]);
          setArtifacts([]);
          setArtifactContents({});
          const result = await runPreflight(next);
          if (result.status === "ready") {
            addMessage("assistant", "This Method is ready. Say execute when you want me to create the inference jobs.");
          } else if (response.questions.length === 0) {
            askForPreflightBlockers(result);
          }
        }
      } catch (err) {
        const message = `I couldn't reach the Method design agent: ${String(err)}`;
        setError(message);
        addMessage("assistant", message);
      }
    },
    [addMessage, askForPreflightBlockers, draftMethod, manifest, runPreflight],
  );

  const saveDraft = useCallback(async () => {
    if (!draftMethod) {
      addMessage("assistant", "This Method is already saved.");
      return selectedMethodId;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await runPreflight(draftMethod);
      if (result.status !== "ready") {
        askForPreflightBlockers(result);
        return null;
      }
      addMessage("assistant", "Preflight passed. Saving the Method bundle now.");
      const saved = await invoke<MethodSummary>("save_method", { input: { method: draftMethod } });
      await loadMethods();
      setSelectedMethodId(saved.id);
      setManifest(draftMethod);
      setDraftMethod(null);
      addMessage("assistant", `Saved Method “${saved.title}”.`);
      return saved.id;
    } catch (err) {
      setError(String(err));
      addMessage("assistant", `I couldn’t save it: ${String(err)}`);
      return null;
    } finally {
      setSaving(false);
    }
  }, [addMessage, askForPreflightBlockers, draftMethod, loadMethods, runPreflight, selectedMethodId]);

  const executeCurrentMethod = useCallback(async () => {
    setExecuting(true);
    setError(null);
    try {
      if (draftMethod) {
        const result = await runPreflight(draftMethod);
        if (result.status !== "ready") {
          askForPreflightBlockers(result);
          return;
        }
        addMessage("assistant", "Preflight passed. I’m going to save the Method and create the execution.");
      }
      const methodId = selectedMethodId ?? (await saveDraft());
      if (!methodId) return;
      addMessage("assistant", "Starting execution. I’ll report each inference job as it is created.");
      const executionId = await invoke<number>("execute_method", { id: methodId });
      setSelectedExecutionId(executionId);
      await loadExecutions(methodId);
      await loadExecutionDetails(executionId);
      addMessage("assistant", `Execution ${executionId} started.`);
    } catch (err) {
      setError(String(err));
      addMessage("assistant", `I couldn’t execute it: ${String(err)}`);
    } finally {
      setExecuting(false);
    }
  }, [
    addMessage,
    askForPreflightBlockers,
    draftMethod,
    loadExecutionDetails,
    loadExecutions,
    runPreflight,
    saveDraft,
    selectedMethodId,
  ]);

  const handleExecutionCommand = async (command: "pause" | "resume" | "cancel") => {
    if (!selectedExecutionId) {
      addMessage("assistant", "There isn’t an active execution selected.");
      return;
    }
    try {
      await invoke(`${command}_method_execution`, { executionId: selectedExecutionId });
      await loadExecutions(selectedMethodId);
      await loadExecutionDetails(selectedExecutionId);
      addMessage("assistant", `${command.charAt(0).toUpperCase() + command.slice(1)} requested.`);
    } catch (err) {
      setError(String(err));
      addMessage("assistant", `I couldn’t ${command}: ${String(err)}`);
    }
  };

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    addMessage("user", text);
    const normalized = text.toLowerCase();
    if (normalized.includes("execute") || normalized.includes("run")) {
      await executeCurrentMethod();
    } else if (normalized.includes("save")) {
      await saveDraft();
    } else if (normalized.includes("pause")) {
      await handleExecutionCommand("pause");
    } else if (normalized.includes("resume")) {
      await handleExecutionCommand("resume");
    } else if (normalized.includes("cancel")) {
      await handleExecutionCommand("cancel");
    } else {
      const paths = extractPaths(text);
      if (draftMethod && paths.length > 0 && preflight?.status === "drafting") {
        const next = mergeFileAnswers(draftMethod, text);
        setDraftMethod(next);
        addMessage("assistant", `Updated the draft with ${paths.join(", ")}.`);
        const result = await runPreflight(next);
        if (result.status === "ready") {
          addMessage("assistant", "This Method is ready. Say execute when you want me to create the inference jobs.");
        } else {
          askForPreflightBlockers(result);
        }
      } else {
        await draftWithAgent(text);
      }
    }
  };

  return (
    <div className="agent-chat-workspace">
      <aside className="agent-method-rail">
        <div className="agent-rail-title">
          <h2>Methods</h2>
          <button type="button" onClick={() => selectMethod(null)}>
            New
          </button>
        </div>
        <div className="agent-method-list">
          {methods.length === 0 ? (
            <div className="agent-muted">No saved Methods.</div>
          ) : (
            methods.map((method) => (
              <button
                key={method.id}
                type="button"
                className={method.id === selectedMethodId ? "active" : ""}
                onClick={() => selectMethod(method.id).catch((err) => setError(String(err)))}
              >
                <span>{method.title}</span>
                <small>{method.id}</small>
              </button>
            ))
          )}
        </div>
      </aside>

      <main className="agent-chat-main">
        <section className="agent-chat-panel">
          <div className="agent-chat-scroll">
            {messages.map((message) => (
              <div key={message.id} className={`agent-message ${message.role}`}>
                {message.text}
              </div>
            ))}
            {error ? <div className="agent-message error">{error}</div> : null}
          </div>

          <div className="agent-command-row">
            <button type="button" onClick={saveDraft} disabled={saving || (!draftMethod && !selectedMethodId)}>
              {saving ? "Saving" : "Save"}
            </button>
            <button type="button" onClick={executeCurrentMethod} disabled={executing || (!draftMethod && !selectedMethodId)}>
              {executing ? "Executing" : "Execute"}
            </button>
            <button type="button" onClick={() => handleExecutionCommand("pause")} disabled={!selectedExecutionId}>
              Pause
            </button>
            <button type="button" onClick={() => handleExecutionCommand("resume")} disabled={!selectedExecutionId}>
              Resume
            </button>
            <button type="button" onClick={() => handleExecutionCommand("cancel")} disabled={!selectedExecutionId}>
              Cancel
            </button>
          </div>

          <form
            className="agent-chat-input"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSubmit();
            }}
          >
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Describe a Method, or say save / execute / pause / resume / cancel"
            />
            <button type="submit">Send</button>
          </form>
        </section>

        <aside className="agent-visual-panel">
          <div className="agent-visual-header">
            <div>
              <h2>{visualMethod?.title ?? "No Method"}</h2>
              <p>
                {selectedExecution
                  ? `Execution ${selectedExecution.id} · ${statusLabel(selectedExecution.status)}`
                  : selectedMethod
                    ? "Saved Method"
                    : preflight?.status === "ready"
                      ? "Ready Method"
                      : "Draft Method"}
              </p>
            </div>
            {selectedExecution && isActiveStatus(selectedExecution.status) ? <span>Live</span> : null}
          </div>

          {visualMethod ? (
            <>
              <div className="method-summary-strip">
                <div>
                  <strong>{visualMethod.files?.length ?? 0}</strong>
                  <span>files</span>
                </div>
                <div>
                  <strong>{visualMethod.workflow.nodes.length}</strong>
                  <span>nodes</span>
                </div>
                <div>
                  <strong>{String(visualMethod.provider?.model ?? "model")}</strong>
                  <span>model</span>
                </div>
              </div>

              <div className="agent-graph">
                {visualNodes.map((node) => (
                  <div key={node.nodeId} className={`agent-graph-node status-${node.status}`}>
                    <div>
                      <strong>{node.nodeId}</strong>
                      <span>{node.nodeType}</span>
                    </div>
                    <em>{statusLabel(node.status)}</em>
                  </div>
                ))}
              </div>

              {preflight?.blockers.length ? (
                <div className="agent-blockers">
                  <h3>Needs Input</h3>
                  {preflight.blockers.map((blocker, index) => (
                    <div key={`${blocker.code}-${blocker.path ?? blocker.fileKind ?? index}`} className="agent-blocker">
                      <strong>{blocker.fileKind ?? blocker.code}</strong>
                      <span>{blocker.path ?? blocker.message}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div className="agent-empty-visual">Draft or select a Method to see its workflow.</div>
          )}

          <div className="agent-event-feed">
            {resultArtifacts.length > 0 ? (
              <div className="agent-results">
                <h3>Results</h3>
                {resultArtifacts.map((artifact) => {
                  const content = artifactContents[artifact.id] ?? artifact.storageRef;
                  const isAnalysis = artifact.artifactType === "analysis";
                  return (
                    <div key={artifact.id} className="agent-result-card">
                      <div className="agent-result-header">
                        <div>
                          <strong>{artifact.artifactType}</strong>
                          <span>{artifact.nodeId ?? "execution"}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            exportArtifact(
                              isAnalysis ? "analysis.md" : "aggregate.json",
                              content,
                              isAnalysis ? "text/markdown" : "application/json",
                            )
                          }
                        >
                          Export
                        </button>
                      </div>
                      <pre>{formatArtifactPreview(content, artifact.storageKind)}</pre>
                    </div>
                  );
                })}
              </div>
            ) : null}

            <h3>Events</h3>
            {events.length === 0 ? (
              <div className="agent-muted">No execution events yet.</div>
            ) : (
              events.slice(-8).map((event) => (
                <div key={event.id} className="agent-event">
                  <strong>{event.eventType}</strong>
                  <span>{event.nodeId ?? "execution"}</span>
                </div>
              ))
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
