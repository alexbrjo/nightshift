import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { PipetteIcon } from "./icons";

export interface JobConfig {
  name: string;
  promptFile: string;
  dataSource: string;
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

interface TransformJobConfig {
  name: string;
  dataSource: string;
  scriptFile: string;
  errorMode: "stop" | "skip";
  outputMode: "one_to_one" | "unwrap_arrays";
}

interface SelectableCollection {
  id: number;
  name: string;
  itemCount: number;
}

interface DataSourceSelectProps {
  id: string;
  value: string;
  error?: string;
  dataFiles: string[];
  collections: SelectableCollection[];
  onChange: (value: string) => void;
  onBrowse: () => void;
}

function DataSourceSelect({
  id,
  value,
  error,
  dataFiles,
  collections,
  onChange,
  onBrowse,
}: DataSourceSelectProps) {
  if (dataFiles.length > 0 || collections.length > 0) {
    return (
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={error ? "error" : ""}
      >
        <option value="">Select a data source...</option>
        {dataFiles.length > 0 && (
          <optgroup label="Files">
            {dataFiles.map((file) => (
              <option key={`f:${file}`} value={file}>{file}</option>
            ))}
          </optgroup>
        )}
        {collections.length > 0 && (
          <optgroup label="Collections">
            {collections.map((c) => (
              <option key={`c:${c.id}`} value={`collection:${c.id}`}>
                {c.name} ({c.itemCount})
              </option>
            ))}
          </optgroup>
        )}
      </select>
    );
  }

  return (
    <div className="file-picker-row">
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="path/to/data.jsonl"
        className={error ? "error" : ""}
      />
      <button type="button" className="btn-secondary" onClick={onBrowse}>
        Browse
      </button>
    </div>
  );
}

interface InferenceJobFormProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (jobId: number) => void;
}

const PROVIDERS = ["Local", "OpenAI", "Anthropic", "Google", "Custom"];
const OUTPUT_MODES = ["Unstructured", "Plain JSON", "JSON Schema"];
const STRATEGIES = ["Single", "Random", "Exhaustive"];
const THINKING_OPTIONS = ["Off", "Low", "Medium", "High"];

const DEFAULT_SERVER_URL = "http://localhost:1234";

const INITIAL_FORM_STATE: JobConfig = {
  name: "",
  promptFile: "",
  dataSource: "",
  provider: "Local",
  model: "bonsai-8b",
  serverUrl: DEFAULT_SERVER_URL,
  outputMode: "JSON Schema",
  samples: 1,
  strategy: "Single",
};

const INITIAL_TRANSFORM_STATE: TransformJobConfig = {
  name: "",
  dataSource: "",
  scriptFile: "",
  errorMode: "stop",
  outputMode: "one_to_one",
};

function formatSubmitError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

export default function InferenceJobForm({ isOpen, onClose, onSuccess }: InferenceJobFormProps) {
  const [activeJobType, setActiveJobType] = useState<"inference" | "transform">("inference");
  const [formData, setFormData] = useState<JobConfig>(INITIAL_FORM_STATE);
  const [transformData, setTransformData] = useState<TransformJobConfig>(INITIAL_TRANSFORM_STATE);

  const [promptFiles, setPromptFiles] = useState<string[]>([]);
  const [dataFiles, setDataFiles] = useState<string[]>([]);
  const [schemaFiles, setSchemaFiles] = useState<string[]>([]);
  const [scriptFiles, setScriptFiles] = useState<string[]>([]);
  const [collections, setCollections] = useState<SelectableCollection[]>([]);
  const [transformRuntimeError, setTransformRuntimeError] = useState<string | null>(null);
  const [isLoadingPrompts, setIsLoadingPrompts] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    // Load may run before FileTree's auto-open finishes its async reconnect, so
    // we also re-load whenever the backend emits `project-opened`.
    const loadFiles = async () => {
      setIsLoadingPrompts(true);
      try {
        const [prompts, datas, schemas, scripts, cols] = await Promise.all([
          invoke<string[]>("list_prompt_files"),
          invoke<string[]>("list_data_files"),
          invoke<string[]>("list_schema_files"),
          invoke<string[]>("list_transform_scripts"),
          invoke<Array<{ id: number; name: string; itemCount: number }>>(
            "list_selectable_collections",
          ),
        ]);
        if (cancelled) return;
        setPromptFiles(prompts);
        setDataFiles(datas);
        setSchemaFiles(schemas);
        setScriptFiles(scripts);
        setCollections(cols);
        try {
          await invoke("check_transform_runtime");
          setTransformRuntimeError(null);
        } catch (runtimeError) {
          setTransformRuntimeError(String(runtimeError));
        }
      } catch (error) {
        if (cancelled) return;
        // No project open yet is expected before FileTree settles; the
        // `project-opened` listener will retrigger this load when it does.
        const msg = String(error);
        if (!msg.includes("No folder opened")) {
          console.error("Failed to load project files:", error);
        }
      } finally {
        if (!cancelled) setIsLoadingPrompts(false);
      }
    };

    void loadFiles();
    const unlistenPromise = listen("project-opened", () => {
      void loadFiles();
    });
    return () => {
      cancelled = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [isOpen]);

  // Reset form when opened using useEffect to avoid infinite re-renders
  useEffect(() => {
    if (isOpen) {
      setFormData(INITIAL_FORM_STATE);
      setTransformData(INITIAL_TRANSFORM_STATE);
      setActiveJobType("inference");
      setErrors({});
    }
  }, [isOpen]);

  const pickFile = useCallback(async (
    filters: Array<{ name: string; extensions: string[] }>,
  ): Promise<string | null> => {
    try {
      const selected = await open({ multiple: false, directory: false, filters });
      if (typeof selected !== "string") return null;
      const root = await invoke<string | null>("get_root_path");
      if (root) {
        // Relativize the path if it's inside the project root (executor only
        // accepts relative paths and rejects "..").
        const sep = selected.includes("\\") && !selected.includes("/") ? "\\" : "/";
        const prefix = root.endsWith(sep) ? root : root + sep;
        if (selected.startsWith(prefix)) {
          return selected.slice(prefix.length);
        }
        // Outside project root — surface as an error rather than letting the
        // job fail later with a confusing message from the path resolver.
        setErrors((prev) => ({
          ...prev,
          submit: `Selected file is outside the project root: ${selected}`,
        }));
        return null;
      }
      return selected;
    } catch (err) {
      console.error("File picker failed:", err);
      return null;
    }
  }, []);

  const handleBrowseDataSource = useCallback(async () => {
    const path = await pickFile([
      { name: "JSON / JSONL", extensions: ["json", "jsonl", "ndjson"] },
      { name: "All files", extensions: ["*"] },
    ]);
    if (path) updateField("dataSource", path);
  }, [pickFile]);

  const handleBrowseTransformDataSource = useCallback(async () => {
    const path = await pickFile([
      { name: "JSON / JSONL", extensions: ["json", "jsonl", "ndjson"] },
      { name: "All files", extensions: ["*"] },
    ]);
    if (path) updateTransformField("dataSource", path);
  }, [pickFile]);

  const handleBrowseSchemaFile = useCallback(async () => {
    const path = await pickFile([
      { name: "JSON Schema", extensions: ["json"] },
    ]);
    if (path) updateField("jsonSchemaFile", path);
  }, [pickFile]);

  const handleBrowseTransformScript = useCallback(async () => {
    const path = await pickFile([
      { name: "JavaScript", extensions: ["js"] },
    ]);
    if (path) updateTransformField("scriptFile", path);
  }, [pickFile]);

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.name.trim()) {
      newErrors.name = "Job name is required";
    }

    if (!formData.promptFile.trim()) {
      newErrors.promptFile = "Prompt file is required";
    }

    if (!formData.dataSource.trim()) {
      newErrors.dataSource = "Data source is required";
    }

    if (!formData.model.trim()) {
      newErrors.model = "Model name is required";
    }

    if (!formData.serverUrl.trim()) {
      newErrors.serverUrl = "Server URL is required";
    } else {
      try {
        new URL(formData.serverUrl);
      } catch {
        newErrors.serverUrl = "Invalid URL format";
      }
    }

    if (formData.samples < 1) {
      newErrors.samples = "Must have at least 1 sample";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const validateTransformForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!transformData.name.trim()) {
      newErrors.name = "Job name is required";
    }
    if (!transformData.dataSource.trim()) {
      newErrors.dataSource = "Data source is required";
    }
    if (!transformData.scriptFile.trim()) {
      newErrors.scriptFile = "Transform script is required";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = useCallback(async () => {
    if (activeJobType === "transform") {
      if (!validateTransformForm()) return;
      if (transformRuntimeError) {
        setErrors({ submit: transformRuntimeError });
        return;
      }

      setIsSubmitting(true);
      try {
        const jobId = await invoke<number>("create_transform_job", {
          input: {
            name: transformData.name,
            dataSource: transformData.dataSource,
            scriptFile: transformData.scriptFile,
            errorMode: transformData.errorMode,
            outputMode: transformData.outputMode,
          },
        });
        onSuccess(jobId);
      } catch (error) {
        const errorMessage = formatSubmitError(error, "Failed to create transform job");
        console.error("Failed to create transform job:", error);
        setErrors({ submit: errorMessage });
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);

    try {
      // Create the job via Tauri command
      const jobId = await invoke<number>("create_inference_job", {
        input: {
          name: formData.name,
          promptFile: formData.promptFile,
          dataSource: formData.dataSource,
          provider: formData.provider,
          model: formData.model,
          serverUrl: formData.serverUrl,
          outputMode: formData.outputMode,
          temperature: formData.temperature,
          maxTokens: formData.maxTokens,
          thinkingBudget: formData.thinkingBudget,
          samples: formData.samples,
          strategy: formData.strategy.toLowerCase(),
          jsonSchemaFile: formData.jsonSchemaFile || null,
        },
      });

      console.log("Successfully created job with ID:", jobId);
      onSuccess(jobId);
    } catch (error) {
      const errorMessage = formatSubmitError(error, "Failed to create job");
      console.error("Failed to create inference job:", error);
      setErrors({ submit: errorMessage });
    } finally {
      setIsSubmitting(false);
    }
  }, [activeJobType, formData, onSuccess, transformData, transformRuntimeError]);

  const updateField = <K extends keyof JobConfig>(field: K, value: JobConfig[K]) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  const updateTransformField = <K extends keyof TransformJobConfig>(
    field: K,
    value: TransformJobConfig[K],
  ) => {
    setTransformData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  // If not open, don't render anything (for backward compatibility with modal usage)
  if (!isOpen) return null;

  return (
    <div className="inference-job-form-container">
      <h2 className="form-title">Create New Job</h2>
      <div className="job-type-tabs" role="tablist" aria-label="Job type">
        <button
          type="button"
          role="tab"
          className={activeJobType === "inference" ? "active" : ""}
          aria-selected={activeJobType === "inference"}
          onClick={() => setActiveJobType("inference")}
        >
          Inference Job
        </button>
        <button
          type="button"
          role="tab"
          className={activeJobType === "transform" ? "active" : ""}
          aria-selected={activeJobType === "transform"}
          onClick={() => setActiveJobType("transform")}
        >
          Transform Job
        </button>
      </div>

      {errors.submit && (
        <div className="form-error">{errors.submit}</div>
      )}

      {activeJobType === "transform" ? (
        <>
          {transformRuntimeError && (
            <div className="form-error">{transformRuntimeError}</div>
          )}

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="transform-job-name">Job Name *</label>
              <input
                id="transform-job-name"
                type="text"
                value={transformData.name}
                onChange={(e) => updateTransformField("name", e.target.value)}
                placeholder="Enter job name"
                className={errors.name ? "error" : ""}
              />
              {errors.name && <span className="error-message">{errors.name}</span>}
            </div>

            <div className="form-group">
              <label htmlFor="transform-script">Transform Script *</label>
              {scriptFiles.length > 0 ? (
                <select
                  id="transform-script"
                  value={transformData.scriptFile}
                  onChange={(e) => updateTransformField("scriptFile", e.target.value)}
                  className={errors.scriptFile ? "error" : ""}
                >
                  <option value="">Select a .js file...</option>
                  {scriptFiles.map((file) => (
                    <option key={file} value={file}>{file}</option>
                  ))}
                </select>
              ) : (
                <div className="file-picker-row">
                  <input
                    id="transform-script"
                    type="text"
                    value={transformData.scriptFile}
                    onChange={(e) => updateTransformField("scriptFile", e.target.value)}
                    placeholder="path/to/transform.js"
                    className={errors.scriptFile ? "error" : ""}
                  />
                  <button type="button" className="btn-secondary" onClick={handleBrowseTransformScript}>
                    Browse
                  </button>
                </div>
              )}
              {errors.scriptFile && <span className="error-message">{errors.scriptFile}</span>}
            </div>
          </div>

          <fieldset className="sampling-section">
            <legend>Transform Input</legend>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="transform-data-source">Data Source *</label>
                <DataSourceSelect
                  id="transform-data-source"
                  value={transformData.dataSource}
                  error={errors.dataSource}
                  dataFiles={dataFiles}
                  collections={collections}
                  onChange={(value) => updateTransformField("dataSource", value)}
                  onBrowse={handleBrowseTransformDataSource}
                />
                {errors.dataSource && <span className="error-message">{errors.dataSource}</span>}
              </div>

              <div className="form-group">
                <label htmlFor="transform-output-mode">Output Behavior</label>
                <select
                  id="transform-output-mode"
                  value={transformData.outputMode}
                  onChange={(e) =>
                    updateTransformField(
                      "outputMode",
                      e.target.value as "one_to_one" | "unwrap_arrays",
                    )
                  }
                >
                  <option value="one_to_one">One row per input</option>
                  <option value="unwrap_arrays">Unwrap returned arrays</option>
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="transform-error-mode">On Error</label>
                <select
                  id="transform-error-mode"
                  value={transformData.errorMode}
                  onChange={(e) => updateTransformField("errorMode", e.target.value as "stop" | "skip")}
                >
                  <option value="stop">Stop job</option>
                  <option value="skip">Skip failed item</option>
                </select>
              </div>
            </div>
          </fieldset>

          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={handleSubmit}
              disabled={isSubmitting || Boolean(transformRuntimeError)}
            >
              {isSubmitting ? "Creating..." : "Create Transform Job"}
            </button>
          </div>
        </>
      ) : (
        <>

      {/* Top: Job Name + Prompt Spec side by side */}
      <div className="form-row">
      <div className="form-group">
        <label htmlFor="job-name">Job Name *</label>
        <input
          id="job-name"
          type="text"
          value={formData.name}
          onChange={(e) => updateField("name", e.target.value)}
          placeholder="Enter job name"
          className={errors.name ? "error" : ""}
        />
        {errors.name && <span className="error-message">{errors.name}</span>}
      </div>

      <div className="form-group">
        <label htmlFor="prompt-file">Prompt Spec *</label>
        {isLoadingPrompts ? (
          <div className="loading-prompts">Loading prompts...</div>
        ) : promptFiles.length > 0 ? (
          <select
            id="prompt-file"
            value={formData.promptFile}
            onChange={(e) => updateField("promptFile", e.target.value)}
            className={errors.promptFile ? "error" : ""}
          >
            <option value="">Select a prompt file...</option>
            {promptFiles.map((file) => (
              <option key={file} value={file}>{file}</option>
            ))}
          </select>
        ) : (
          <>
            <input
              id="prompt-file"
              type="text"
              value={formData.promptFile}
              onChange={(e) => updateField("promptFile", e.target.value)}
              placeholder="path/to/prompt.jinja2"
              className={errors.promptFile ? "error" : ""}
            />
            <div className="prompt-hint">
              No prompt files found — add .jinja2 / .prompt files to your project.
            </div>
          </>
        )}
        {errors.promptFile && <span className="error-message">{errors.promptFile}</span>}
      </div>
      </div>

      {/* Fieldsets in responsive 2-col grid */}
      <div className="form-fieldsets-grid">
      {/* LLM Configuration Section */}
      <fieldset className="llm-config-section">
        <legend>LLM Configuration</legend>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="provider">Provider *</label>
            <select
              id="provider"
              value={formData.provider}
              onChange={(e) => updateField("provider", e.target.value)}
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
              value={formData.model}
              onChange={(e) => updateField("model", e.target.value)}
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
              value={formData.serverUrl}
              onChange={(e) => updateField("serverUrl", e.target.value)}
              placeholder="http://localhost:1234 (base URL, /v1/chat/completions appended automatically)"
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
              value={formData.maxTokens?.toString() || ""}
              onChange={(e) => updateField("maxTokens", e.target.value ? parseInt(e.target.value) : undefined)}
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
              value={formData.temperature?.toString() || ""}
              onChange={(e) => updateField("temperature", e.target.value ? parseFloat(e.target.value) : undefined)}
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
              value={formData.thinkingBudget?.toString() || ""}
              onChange={(e) => updateField("thinkingBudget", e.target.value ? parseInt(e.target.value) : undefined)}
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
              value={formData.outputMode}
              onChange={(e) => updateField("outputMode", e.target.value)}
            >
              {OUTPUT_MODES.map((mode) => (
                <option key={mode} value={mode}>{mode}</option>
              ))}
            </select>
          </div>

          {formData.outputMode === "JSON Schema" && (
            <div className="form-group">
              <label htmlFor="json-schema-file">Schema File</label>
              {schemaFiles.length > 0 ? (
                <select
                  id="json-schema-file"
                  value={formData.jsonSchemaFile || ""}
                  onChange={(e) => updateField("jsonSchemaFile", e.target.value)}
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
                    value={formData.jsonSchemaFile || ""}
                    onChange={(e) => updateField("jsonSchemaFile", e.target.value)}
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

      {/* Sampling Controls */}
      <fieldset className="sampling-section">
        <legend>Samples & Strategy</legend>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="samples">
              {formData.strategy === "Exhaustive" ? "Samples per row" : "Number of Samples"}
            </label>
            <select
              id="samples"
              value={formData.samples}
              onChange={(e) => updateField("samples", parseInt(e.target.value))}
              disabled={formData.strategy === "Single"}
            >
              {[1, 5, 10, 25, 50, 100, 250, 500, 1000].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            {formData.strategy === "Exhaustive" && (
              <span className="hint">Each row in the source is evaluated this many times.</span>
            )}
            {formData.strategy === "Single" && (
              <span className="hint">Single runs the first row only.</span>
            )}
          </div>

          <div className="form-group">
            <label htmlFor="strategy">Strategy</label>
            <select
              id="strategy"
              value={formData.strategy}
              onChange={(e) => updateField("strategy", e.target.value)}
            >
              {STRATEGIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="data-source">Data Source *</label>
            <DataSourceSelect
              id="data-source"
              value={formData.dataSource}
              error={errors.dataSource}
              dataFiles={dataFiles}
              collections={collections}
              onChange={(value) => updateField("dataSource", value)}
              onBrowse={handleBrowseDataSource}
            />
            {errors.dataSource && <span className="error-message">{errors.dataSource}</span>}
          </div>
        </div>
      </fieldset>
      </div>

      {/* Action Buttons */}
      <div className="form-actions">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={isSubmitting}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={handleSubmit}
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            "Creating..."
          ) : (
            <>
              Create <PipetteIcon />
            </>
          )}
        </button>
      </div>
      </>
      )}
    </div>
  );
}
