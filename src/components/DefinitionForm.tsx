import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type {
  DefinitionContentInput,
  DefinitionKind,
  GroupMode,
  JobDefinition,
  JobDefinitionVersion,
} from "../database";
import {
  definitionDelete,
  definitionReadCurrent,
  definitionSaveVersion,
} from "../api/orchestrator";
import { useToast } from "./Toast";
import { pickFile } from "../utils/pickFile";
import DefinitionHistoryPanel from "./DefinitionHistoryPanel";
import Editor from "./Editor";

interface DefinitionFormProps {
  /**
   * Definition to edit. The form only edits existing definitions —
   * creation now lives on the tree sidebar (`+ New` for roots,
   * `+ Add child` for descendants), which creates the row and selects
   * the new id. The form sees the result via `defId`.
   */
  defId: number;
  onSaved: (defId: number) => void;
  onDeleted: () => void;
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
  kind: DefinitionKind;
  mode: GroupMode | null;
  description: string;
  // Inference-specific (used only when kind === "inference"):
  dataSource: string;
  params: InferenceParams;
  // For non-inference kinds: free-form JSON editors so users can author
  // params/input_ref directly. Persisted as strings so partially-typed JSON
  // doesn't lose itself between renders.
  paramsJson: string;
  inputRefJson: string;
}

const PROVIDERS = ["Local", "OpenAI", "Anthropic", "Google", "Custom"];
const OUTPUT_MODES = ["Unstructured", "Plain JSON", "JSON Schema"];
const STRATEGIES = ["Single", "Random", "Exhaustive"];
const THINKING_OPTIONS = ["Off", "Low", "Medium", "High"];
const DEFAULT_SERVER_URL = "http://localhost:1234";

const KINDS: { value: DefinitionKind; label: string }[] = [
  { value: "inference", label: "Inference" },
  { value: "group", label: "Group" },
  { value: "analysis", label: "Analysis" },
  { value: "js_action", label: "JS Action" },
];

const INITIAL_INFERENCE_PARAMS: InferenceParams = {
  promptFile: "",
  provider: "Local",
  model: "bonsai-8b",
  serverUrl: DEFAULT_SERVER_URL,
  outputMode: "JSON Schema",
  samples: 1,
  strategy: "Single",
};

const INITIAL_STATE: FormState = {
  name: "",
  kind: "inference",
  mode: null,
  description: "",
  dataSource: "",
  params: INITIAL_INFERENCE_PARAMS,
  paramsJson: "{}",
  inputRefJson: "null",
};

function formatSubmitError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

export default function DefinitionForm({
  defId,
  onSaved,
  onDeleted,
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

  // Load the current definition state. The form is always in "edit existing"
  // mode now — creation happens on the tree sidebar.
  useEffect(() => {
    let cancelled = false;
    setIsLoadingDef(true);
    void (async () => {
      try {
        const dv = await definitionReadCurrent(defId);
        if (cancelled) return;
        setDefinition(dv.definition);
        setCurrentVersion(dv.version ?? null);
        if (dv.version) {
          const params = JSON.parse(dv.version.params) as Record<string, unknown>;
          const inputRef = dv.version.inputRef ? JSON.parse(dv.version.inputRef) : null;
          if (dv.version.kind === "inference") {
            setForm({
              ...INITIAL_STATE,
              name: dv.definition.name,
              kind: "inference",
              description: dv.version.description ?? "",
              dataSource:
                inputRef && inputRef.kind === "file"
                  ? String(inputRef.path ?? "")
                  : "",
              params: {
                promptFile: String(params.prompt_file ?? ""),
                provider: String(params.provider ?? "Local"),
                model: String(params.model ?? ""),
                serverUrl: String(params.server_url ?? DEFAULT_SERVER_URL),
                outputMode: String(params.output_mode ?? "JSON Schema"),
                temperature:
                  typeof params.temperature === "number" ? params.temperature : undefined,
                maxTokens:
                  typeof params.max_tokens === "number" ? params.max_tokens : undefined,
                thinkingBudget:
                  typeof params.thinking_budget === "number"
                    ? params.thinking_budget
                    : undefined,
                samples: typeof params.samples === "number" ? params.samples : 1,
                strategy: String(params.strategy ?? "Single"),
                jsonSchemaFile:
                  typeof params.json_schema_file === "string"
                    ? params.json_schema_file
                    : undefined,
              },
              paramsJson: JSON.stringify(params, null, 2),
              inputRefJson: JSON.stringify(inputRef, null, 2),
            });
          } else {
            setForm({
              ...INITIAL_STATE,
              name: dv.definition.name,
              kind: dv.version.kind,
              mode: dv.version.mode ?? null,
              description: dv.version.description ?? "",
              paramsJson: JSON.stringify(params, null, 2),
              inputRefJson: JSON.stringify(inputRef, null, 2),
            });
          }
        } else {
          // Unsaved definition: pick a default kind based on whether this is
          // a root (no parent → group, the experiment topology shape) or a
          // child (parent set → inference, the typical leaf).
          const defaultKind: DefinitionKind =
            dv.definition.parentId === null ? "group" : "inference";
          setForm({
            ...INITIAL_STATE,
            name: dv.definition.name,
            kind: defaultKind,
            mode: defaultKind === "group" ? "sequential" : null,
          });
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

  // Load file-listing dropdowns.
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

  const updateTop = <K extends "name" | "dataSource" | "description">(
    field: K,
    value: string,
  ) => {
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
    if (result.error) setErrors((prev) => ({ ...prev, submit: result.error! }));
    else if (result.path) updateTop("dataSource", result.path);
  }, []);

  const handleBrowseSchemaFile = useCallback(async () => {
    const result = await pickFile([{ name: "JSON Schema", extensions: ["json"] }]);
    if (result.error) setErrors((prev) => ({ ...prev, submit: result.error! }));
    else if (result.path) updateParam("jsonSchemaFile", result.path);
  }, []);

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = "Name is required";
    if (form.kind === "inference") {
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
    } else {
      if (form.kind === "group" && form.mode === null) {
        next.mode = "Group mode is required";
      }
      try {
        const parsed = JSON.parse(form.paramsJson || "{}");
        if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
          next.paramsJson = "params must be a JSON object";
        }
      } catch (e) {
        next.paramsJson = `params is not valid JSON: ${(e as Error).message}`;
      }
      if (form.inputRefJson.trim() && form.inputRefJson.trim() !== "null") {
        try {
          JSON.parse(form.inputRefJson);
        } catch (e) {
          next.inputRefJson = `input_ref is not valid JSON: ${(e as Error).message}`;
        }
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const buildContent = (): DefinitionContentInput => {
    if (form.kind === "inference") {
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
        description: form.description || null,
        message: null,
      };
    }
    const params = JSON.parse(form.paramsJson || "{}") as Record<string, unknown>;
    const inputRef =
      form.inputRefJson.trim() && form.inputRefJson.trim() !== "null"
        ? (JSON.parse(form.inputRefJson) as Record<string, unknown>)
        : null;
    return {
      kind: form.kind,
      mode: form.kind === "group" ? form.mode : null,
      params,
      inputRef,
      description: form.description || null,
      message: null,
    };
  };

  const handleSubmit = useCallback(async () => {
    if (!validate()) return;
    setIsSubmitting(true);
    try {
      if (definition && definition.name !== form.name) {
        await invoke<void>("definition_rename", {
          input: { defId, newName: form.name },
        });
      }
      await definitionSaveVersion(defId, buildContent());
      showToast("Saved", "success");
      onSaved(defId);
    } catch (error) {
      const msg = formatSubmitError(error, "Failed to save");
      console.error("Failed to save definition:", error);
      setErrors({ submit: msg });
    } finally {
      setIsSubmitting(false);
    }
  }, [defId, definition, form, onSaved, showToast]);

  const handleDelete = useCallback(async () => {
    // Tauri 2 webview doesn't expose window.confirm — use the dialog plugin.
    const { ask } = await import("@tauri-apps/plugin-dialog");
    const confirmed = await ask("Delete this definition? This cannot be undone.", {
      title: "Confirm delete",
      kind: "warning",
    });
    if (!confirmed) return;
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

  if (isLoadingDef) {
    return <div className="inference-job-form-container loading-indicator">Loading…</div>;
  }

  const isJsActionStub = form.kind === "js_action";
  const isUnsaved = currentVersion === null;
  const heading = (() => {
    if (isUnsaved) {
      const role = definition?.parentId === null ? "root" : "child";
      return `New ${role} (${form.kind})`;
    }
    return `${definition?.name ?? form.name} · ${form.kind}`;
  })();

  return (
    <div className="inference-job-form-container">
      <h2 className="form-title">{heading}</h2>

      {errors.submit && <div className="form-error">{errors.submit}</div>}

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="def-name">Name *</label>
          <input
            id="def-name"
            type="text"
            value={form.name}
            onChange={(e) => updateTop("name", e.target.value)}
            placeholder="definition-name"
            className={errors.name ? "error" : ""}
          />
          {errors.name && <span className="error-message">{errors.name}</span>}
        </div>

        <div className="form-group">
          <label htmlFor="def-kind">Kind</label>
          <select
            id="def-kind"
            value={form.kind}
            onChange={(e) =>
              setForm((prev) => ({
                ...prev,
                kind: e.target.value as DefinitionKind,
                mode: e.target.value === "group" ? prev.mode ?? "sequential" : null,
              }))
            }
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
        </div>

        {form.kind === "group" && (
          <div className="form-group">
            <label htmlFor="def-mode">Mode</label>
            <select
              id="def-mode"
              value={form.mode ?? "sequential"}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, mode: e.target.value as GroupMode }))
              }
            >
              <option value="sequential">Sequential</option>
              <option value="parallel">Parallel</option>
            </select>
            <span className="hint">Parallel is a structural marker only in v1.</span>
          </div>
        )}
      </div>

      {isJsActionStub ? (
        <div className="form-row">
          <p className="hint">
            JS Action workers aren't implemented yet. Saving the definition is fine —
            executions will fail with NotImplemented at run time. Reserved for future
            work.
          </p>
        </div>
      ) : form.kind === "inference" ? (
        <InferenceFields
          form={form}
          errors={errors}
          promptFiles={promptFiles}
          dataFiles={dataFiles}
          schemaFiles={schemaFiles}
          updateParam={updateParam}
          updateTop={updateTop}
          handleBrowseDataSource={handleBrowseDataSource}
          handleBrowseSchemaFile={handleBrowseSchemaFile}
        />
      ) : (
        <JsonFields
          form={form}
          errors={errors}
          onParamsChange={(s) => setForm((prev) => ({ ...prev, paramsJson: s }))}
          onInputRefChange={(s) => setForm((prev) => ({ ...prev, inputRefJson: s }))}
          onDescriptionChange={(s) => updateTop("description", s)}
        />
      )}

      <div className="form-actions">
        <button
          type="button"
          className="btn-secondary"
          onClick={handleDelete}
          disabled={isSubmitting}
        >
          Delete
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={handleSubmit}
          disabled={isSubmitting}
        >
          {isSubmitting ? "Saving..." : isUnsaved ? "Create" : "Save Version"}
        </button>
      </div>

      <DefinitionHistoryPanel
        defId={defId}
        currentVersionId={currentVersion?.id ?? null}
      />
    </div>
  );
}

interface InferenceFieldsProps {
  form: FormState;
  errors: Record<string, string>;
  promptFiles: string[];
  dataFiles: string[];
  schemaFiles: string[];
  updateParam: <K extends keyof InferenceParams>(field: K, value: InferenceParams[K]) => void;
  updateTop: (field: "dataSource", value: string) => void;
  handleBrowseDataSource: () => void;
  handleBrowseSchemaFile: () => void;
}

function InferenceFields({
  form,
  errors,
  promptFiles,
  dataFiles,
  schemaFiles,
  updateParam,
  updateTop,
  handleBrowseDataSource,
  handleBrowseSchemaFile,
}: InferenceFieldsProps) {
  return (
    <>
      <div className="form-row">
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
                {form.params.strategy === "Exhaustive"
                  ? "Samples per row"
                  : "Number of Samples"}
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
    </>
  );
}

interface JsonFieldsProps {
  form: FormState;
  errors: Record<string, string>;
  onParamsChange: (s: string) => void;
  onInputRefChange: (s: string) => void;
  onDescriptionChange: (s: string) => void;
}

function JsonFields({
  form,
  errors,
  onParamsChange,
  onInputRefChange,
  onDescriptionChange,
}: JsonFieldsProps) {
  return (
    <div className="form-row" style={{ flexDirection: "column", alignItems: "stretch", gap: "1rem" }}>
      <div className="form-group">
        <label htmlFor="def-description">Description</label>
        <input
          id="def-description"
          type="text"
          value={form.description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="Optional description"
        />
      </div>
      <div className="form-group">
        <label>params (JSON object)</label>
        <Editor code={form.paramsJson} language="json" onChange={onParamsChange} />
        {errors.paramsJson && <span className="error-message">{errors.paramsJson}</span>}
      </div>
      <div className="form-group">
        <label>input_ref (JSON or null)</label>
        <Editor code={form.inputRefJson} language="json" onChange={onInputRefChange} />
        {errors.inputRefJson && <span className="error-message">{errors.inputRefJson}</span>}
      </div>
    </div>
  );
}
