import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  DefinitionContentInput,
  JobDefinition,
  JobDefinitionVersion,
} from "../database";
import {
  definitionCreate,
  definitionDelete,
  definitionReadCurrent,
  definitionSaveVersion,
  experimentStart,
} from "../api/orchestrator";
import { useToast } from "./Toast";
import { pickFile } from "../utils/pickFile";
import DefinitionHistoryPanel from "./DefinitionHistoryPanel";

interface DefinitionFormProps {
  /** Definition to edit; `null` means a new definition is being authored. */
  defId: number | null;
  onSaved: (defId: number) => void;
  onDeleted: () => void;
  onCancel: () => void;
}

interface InferenceParams {
  promptFile: string;
  provider: string;
  model: string;
  serverUrl: string;
  outputMode: string;
  temperature?: number;
  maxTokens?: number;
  thinkingBudget?: number;
  samples: number;
  strategy: string;
  jsonSchemaFile?: string;
}

interface FormState {
  name: string;
  dataSource: string;
  params: InferenceParams;
}

const PROVIDERS = ["Local", "OpenAI", "Anthropic", "Google", "Custom"];
const OUTPUT_MODES = ["Unstructured", "Plain JSON", "JSON Schema"];
const STRATEGIES = ["Single", "Random", "Exhaustive"];
const THINKING_OPTIONS = ["Off", "Low", "Medium", "High"];
const DEFAULT_SERVER_URL = "http://localhost:1234";

const INITIAL_STATE: FormState = {
  name: "",
  dataSource: "",
  params: {
    promptFile: "",
    provider: "Local",
    model: "bonsai-8b",
    serverUrl: DEFAULT_SERVER_URL,
    outputMode: "JSON Schema",
    samples: 1,
    strategy: "Single",
  },
};

function formatSubmitError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

/**
 * v1: kind=inference only. The kind dropdown is shown for layout continuity
 * with checkpoint 6 (group / analysis / js_action sub-forms) but only
 * "Inference" is selectable for now.
 */
export default function DefinitionForm({
  defId,
  onSaved,
  onDeleted,
  onCancel,
}: DefinitionFormProps) {
  const [form, setForm] = useState<FormState>(INITIAL_STATE);
  const [definition, setDefinition] = useState<JobDefinition | null>(null);
  const [currentVersion, setCurrentVersion] = useState<JobDefinitionVersion | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingDef, setIsLoadingDef] = useState(false);

  const [promptFiles, setPromptFiles] = useState<string[]>([]);
  const [dataFiles, setDataFiles] = useState<string[]>([]);
  const [schemaFiles, setSchemaFiles] = useState<string[]>([]);

  const { showToast } = useToast();

  // Fetch the current definition + version when defId changes.
  useEffect(() => {
    let cancelled = false;
    if (defId === null) {
      setForm(INITIAL_STATE);
      setDefinition(null);
      setCurrentVersion(null);
      setErrors({});
      return;
    }
    setIsLoadingDef(true);
    void (async () => {
      try {
        const dv = await definitionReadCurrent(defId);
        if (cancelled) return;
        setDefinition(dv.definition);
        setCurrentVersion(dv.version ?? null);
        if (dv.version) {
          const params = JSON.parse(dv.version.params) as Record<string, unknown>;
          const inputRef = dv.version.inputRef
            ? (JSON.parse(dv.version.inputRef) as { kind?: string; path?: string })
            : null;
          setForm({
            name: dv.definition.name,
            dataSource: inputRef?.kind === "file" ? (inputRef.path ?? "") : "",
            params: {
              promptFile: String(params.prompt_file ?? ""),
              provider: String(params.provider ?? "Local"),
              model: String(params.model ?? ""),
              serverUrl: String(params.server_url ?? DEFAULT_SERVER_URL),
              outputMode: String(params.output_mode ?? "JSON Schema"),
              temperature: typeof params.temperature === "number" ? params.temperature : undefined,
              maxTokens: typeof params.max_tokens === "number" ? params.max_tokens : undefined,
              thinkingBudget:
                typeof params.thinking_budget === "number" ? params.thinking_budget : undefined,
              samples: typeof params.samples === "number" ? params.samples : 1,
              strategy: String(params.strategy ?? "Single"),
              jsonSchemaFile:
                typeof params.json_schema_file === "string" ? params.json_schema_file : undefined,
            },
          });
        } else {
          // Identity exists but no content yet — show a blank form with the name pre-filled.
          setForm({ ...INITIAL_STATE, name: dv.definition.name });
        }
        setErrors({});
      } catch (error) {
        console.error("Failed to load definition:", error);
        showToast("Failed to load definition", "error");
      } finally {
        if (!cancelled) setIsLoadingDef(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [defId, showToast]);

  // Load file-listing dropdowns. Identical pattern to legacy InferenceJobForm.
  useEffect(() => {
    let cancelled = false;
    const loadFiles = async () => {
      try {
        const [prompts, datas, schemas] = await Promise.all([
          invoke<string[]>("list_prompt_files"),
          invoke<string[]>("list_data_files"),
          invoke<string[]>("list_schema_files"),
        ]);
        if (cancelled) return;
        setPromptFiles(prompts);
        setDataFiles(datas);
        setSchemaFiles(schemas);
      } catch (error) {
        const msg = String(error);
        if (!msg.includes("No folder opened")) {
          console.error("Failed to load project files:", error);
        }
      }
    };
    void loadFiles();
    const unlistenPromise = listen("project-opened", () => void loadFiles());
    return () => {
      cancelled = true;
      void unlistenPromise.then((fn) => fn());
    };
  }, []);

  const updateParam = <K extends keyof InferenceParams>(field: K, value: InferenceParams[K]) => {
    setForm((prev) => ({ ...prev, params: { ...prev.params, [field]: value } }));
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const updateTop = <K extends "name" | "dataSource">(field: K, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const handleBrowseDataSource = useCallback(async () => {
    const result = await pickFile([
      { name: "JSON / JSONL", extensions: ["json", "jsonl", "ndjson"] },
      { name: "All files", extensions: ["*"] },
    ]);
    if (result.error) {
      setErrors((prev) => ({ ...prev, submit: result.error! }));
    } else if (result.path) {
      updateTop("dataSource", result.path);
    }
  }, []);

  const handleBrowseSchemaFile = useCallback(async () => {
    const result = await pickFile([{ name: "JSON Schema", extensions: ["json"] }]);
    if (result.error) {
      setErrors((prev) => ({ ...prev, submit: result.error! }));
    } else if (result.path) {
      updateParam("jsonSchemaFile", result.path);
    }
  }, []);

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = "Name is required";
    if (!form.params.promptFile.trim()) next.promptFile = "Prompt file is required";
    if (!form.dataSource.trim()) next.dataSource = "Data source is required";
    if (!form.params.model.trim()) next.model = "Model name is required";
    if (!form.params.serverUrl.trim()) {
      next.serverUrl = "Server URL is required";
    } else {
      try {
        new URL(form.params.serverUrl);
      } catch {
        next.serverUrl = "Invalid URL format";
      }
    }
    if (form.params.samples < 1) next.samples = "Must have at least 1 sample";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const buildContent = (): DefinitionContentInput => {
    const p = form.params;
    return {
      kind: "inference",
      mode: null,
      params: {
        prompt_file: p.promptFile,
        provider: p.provider,
        model: p.model,
        server_url: p.serverUrl,
        output_mode: p.outputMode,
        temperature: p.temperature,
        max_tokens: p.maxTokens,
        thinking_budget: p.thinkingBudget,
        samples: p.samples,
        strategy: p.strategy.toLowerCase(),
        json_schema_file: p.jsonSchemaFile || null,
      },
      inputRef: { kind: "file", path: form.dataSource },
      description: null,
      message: null,
    };
  };

  const handleSubmit = useCallback(async () => {
    if (!validate()) return;
    setIsSubmitting(true);
    try {
      let id = defId;
      if (id === null) {
        id = await definitionCreate({ parentId: null, name: form.name, position: 0 });
      } else if (definition && definition.name !== form.name) {
        // Rename is an identity mutation — separate command, no version impact.
        await invoke<void>("definition_rename", {
          input: { defId: id, newName: form.name },
        });
      }
      await definitionSaveVersion(id, buildContent());
      showToast("Saved", "success");
      onSaved(id);
    } catch (error) {
      const msg = formatSubmitError(error, "Failed to save");
      console.error("Failed to save definition:", error);
      setErrors({ submit: msg });
    } finally {
      setIsSubmitting(false);
    }
  }, [defId, definition, form, onSaved, showToast]);

  const handleDelete = useCallback(async () => {
    if (defId === null) return;
    if (!window.confirm("Delete this experiment? This cannot be undone.")) return;
    try {
      await definitionDelete(defId);
      showToast("Deleted", "info");
      onDeleted();
    } catch (error) {
      const msg = formatSubmitError(error, "Failed to delete");
      console.error("Failed to delete definition:", error);
      showToast(msg, "error");
    }
  }, [defId, onDeleted, showToast]);

  const handleRun = useCallback(async () => {
    if (defId === null) return;
    try {
      const execId = await experimentStart(defId);
      showToast(`Started experiment (execution ${execId})`, "success");
    } catch (error) {
      const msg = formatSubmitError(error, "Failed to start experiment");
      console.error("Failed to start experiment:", error);
      showToast(msg, "error");
    }
  }, [defId, showToast]);

  if (isLoadingDef) {
    return <div className="inference-job-form-container loading-indicator">Loading…</div>;
  }

  return (
    <div className="inference-job-form-container">
      <h2 className="form-title">{defId === null ? "New Experiment" : "Edit Experiment"}</h2>

      {errors.submit && <div className="form-error">{errors.submit}</div>}

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="def-name">Name *</label>
          <input
            id="def-name"
            type="text"
            value={form.name}
            onChange={(e) => updateTop("name", e.target.value)}
            placeholder="experiment-name"
            className={errors.name ? "error" : ""}
          />
          {errors.name && <span className="error-message">{errors.name}</span>}
        </div>

        <div className="form-group">
          <label htmlFor="def-kind">Kind</label>
          <select id="def-kind" value="inference" disabled>
            <option value="inference">Inference</option>
          </select>
          <span className="hint">Group / Analysis / JS Action land in a later commit.</span>
        </div>

        <div className="form-group">
          <label htmlFor="prompt-file">Prompt Spec *</label>
          {promptFiles.length > 0 ? (
            <select
              id="prompt-file"
              value={form.params.promptFile}
              onChange={(e) => updateParam("promptFile", e.target.value)}
              className={errors.promptFile ? "error" : ""}
            >
              <option value="">Select a prompt file...</option>
              {promptFiles.map((file) => (
                <option key={file} value={file}>{file}</option>
              ))}
            </select>
          ) : (
            <input
              id="prompt-file"
              type="text"
              value={form.params.promptFile}
              onChange={(e) => updateParam("promptFile", e.target.value)}
              placeholder="path/to/prompt.jinja2"
              className={errors.promptFile ? "error" : ""}
            />
          )}
          {errors.promptFile && <span className="error-message">{errors.promptFile}</span>}
        </div>
      </div>

      <div className="form-fieldsets-grid">
        <fieldset className="llm-config-section">
          <legend>LLM Configuration</legend>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="provider">Provider *</label>
              <select
                id="provider"
                value={form.params.provider}
                onChange={(e) => updateParam("provider", e.target.value)}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="model">Model *</label>
              <input
                id="model"
                type="text"
                value={form.params.model}
                onChange={(e) => updateParam("model", e.target.value)}
                placeholder="e.g., gpt-4, llama3"
                className={errors.model ? "error" : ""}
              />
              {errors.model && <span className="error-message">{errors.model}</span>}
            </div>

            <div className="form-group">
              <label htmlFor="server-url">Server URL *</label>
              <input
                id="server-url"
                type="text"
                value={form.params.serverUrl}
                onChange={(e) => updateParam("serverUrl", e.target.value)}
                placeholder="http://localhost:1234"
                className={errors.serverUrl ? "error" : ""}
              />
              {errors.serverUrl && <span className="error-message">{errors.serverUrl}</span>}
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="max-tokens">Max Tokens</label>
              <select
                id="max-tokens"
                value={form.params.maxTokens?.toString() || ""}
                onChange={(e) =>
                  updateParam("maxTokens", e.target.value ? parseInt(e.target.value) : undefined)
                }
              >
                <option value="">Default</option>
                {[256, 512, 1024, 2048, 4096, 8192, 16384].map((n) => (
                  <option key={n} value={n}>{n.toLocaleString()}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="temperature">Temperature</label>
              <select
                id="temperature"
                value={form.params.temperature?.toString() || ""}
                onChange={(e) =>
                  updateParam(
                    "temperature",
                    e.target.value ? parseFloat(e.target.value) : undefined,
                  )
                }
              >
                <option value="">Default</option>
                <option value="0.1">0.1 (Precise)</option>
                <option value="0.3">0.3 (Balanced)</option>
                <option value="0.5">0.5 (Creative)</option>
                <option value="0.7">0.7 (Very Creative)</option>
                <option value="1.0">1.0 (Maximum)</option>
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="thinking-budget">Thinking Budget</label>
              <select
                id="thinking-budget"
                value={form.params.thinkingBudget?.toString() || ""}
                onChange={(e) =>
                  updateParam(
                    "thinkingBudget",
                    e.target.value ? parseInt(e.target.value) : undefined,
                  )
                }
              >
                <option value="">Off</option>
                {THINKING_OPTIONS.map((opt, idx) => (
                  <option key={opt} value={(idx + 1) * 500}>{opt}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="output-mode">Output Mode</label>
              <select
                id="output-mode"
                value={form.params.outputMode}
                onChange={(e) => updateParam("outputMode", e.target.value)}
              >
                {OUTPUT_MODES.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            {form.params.outputMode === "JSON Schema" && (
              <div className="form-group">
                <label htmlFor="json-schema-file">Schema File</label>
                {schemaFiles.length > 0 ? (
                  <select
                    id="json-schema-file"
                    value={form.params.jsonSchemaFile || ""}
                    onChange={(e) => updateParam("jsonSchemaFile", e.target.value)}
                  >
                    <option value="">Select a schema file...</option>
                    {schemaFiles.map((file) => (
                      <option key={file} value={file}>{file}</option>
                    ))}
                  </select>
                ) : (
                  <div className="file-picker-row">
                    <input
                      id="json-schema-file"
                      type="text"
                      value={form.params.jsonSchemaFile || ""}
                      onChange={(e) => updateParam("jsonSchemaFile", e.target.value)}
                      placeholder="path/to/schema.json"
                    />
                    <button type="button" className="btn-secondary" onClick={handleBrowseSchemaFile}>
                      Browse
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </fieldset>

        <fieldset className="sampling-section">
          <legend>Samples & Input</legend>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="samples">
                {form.params.strategy === "Exhaustive" ? "Samples per row" : "Number of Samples"}
              </label>
              <select
                id="samples"
                value={form.params.samples}
                onChange={(e) => updateParam("samples", parseInt(e.target.value))}
                disabled={form.params.strategy === "Single"}
              >
                {[1, 5, 10, 25, 50, 100, 250, 500, 1000].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              {form.params.strategy === "Exhaustive" && (
                <span className="hint">Each row in the source is evaluated this many times.</span>
              )}
              {form.params.strategy === "Single" && (
                <span className="hint">Single runs the first row only.</span>
              )}
            </div>

            <div className="form-group">
              <label htmlFor="strategy">Strategy</label>
              <select
                id="strategy"
                value={form.params.strategy}
                onChange={(e) => updateParam("strategy", e.target.value)}
              >
                {STRATEGIES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="data-source">Data Source *</label>
              {dataFiles.length > 0 ? (
                <select
                  id="data-source"
                  value={form.dataSource}
                  onChange={(e) => updateTop("dataSource", e.target.value)}
                  className={errors.dataSource ? "error" : ""}
                >
                  <option value="">Select a data file...</option>
                  {dataFiles.map((file) => (
                    <option key={file} value={file}>{file}</option>
                  ))}
                </select>
              ) : (
                <div className="file-picker-row">
                  <input
                    id="data-source"
                    type="text"
                    value={form.dataSource}
                    onChange={(e) => updateTop("dataSource", e.target.value)}
                    placeholder="path/to/data.jsonl"
                    className={errors.dataSource ? "error" : ""}
                  />
                  <button type="button" className="btn-secondary" onClick={handleBrowseDataSource}>
                    Browse
                  </button>
                </div>
              )}
              {errors.dataSource && <span className="error-message">{errors.dataSource}</span>}
            </div>
          </div>
        </fieldset>
      </div>

      <div className="form-actions">
        <button
          type="button"
          className="btn-secondary"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </button>
        {defId !== null && (
          <button
            type="button"
            className="btn-secondary"
            onClick={handleDelete}
            disabled={isSubmitting}
          >
            Delete
          </button>
        )}
        <button
          type="button"
          className="btn-secondary"
          onClick={handleRun}
          disabled={isSubmitting || defId === null}
          title={defId === null ? "Save first" : "Run experiment"}
        >
          Run
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={handleSubmit}
          disabled={isSubmitting}
        >
          {isSubmitting ? "Saving..." : defId === null ? "Create" : "Save Version"}
        </button>
      </div>

      <DefinitionHistoryPanel
        defId={defId}
        currentVersionId={currentVersion?.id ?? null}
      />
    </div>
  );
}
