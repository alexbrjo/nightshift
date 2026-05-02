import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

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

export default function InferenceJobForm({ isOpen, onClose, onSuccess }: InferenceJobFormProps) {
  const [formData, setFormData] = useState<JobConfig>(INITIAL_FORM_STATE);

  const [promptFiles, setPromptFiles] = useState<string[]>([]);
  const [dataFiles, setDataFiles] = useState<string[]>([]);
  const [schemaFiles, setSchemaFiles] = useState<string[]>([]);
  const [collections, setCollections] = useState<
    Array<{ id: number; name: string; itemCount: number }>
  >([]);
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
        const [prompts, datas, schemas, cols] = await Promise.all([
          invoke<string[]>("list_prompt_files"),
          invoke<string[]>("list_data_files"),
          invoke<string[]>("list_schema_files"),
          invoke<Array<{ id: number; name: string; itemCount: number }>>(
            "list_selectable_collections",
          ),
        ]);
        if (cancelled) return;
        setPromptFiles(prompts);
        setDataFiles(datas);
        setSchemaFiles(schemas);
        setCollections(cols);
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

  const handleBrowseSchemaFile = useCallback(async () => {
    const path = await pickFile([
      { name: "JSON Schema", extensions: ["json"] },
    ]);
    if (path) updateField("jsonSchemaFile", path);
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

  const handleSubmit = useCallback(async () => {
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
      const errorMessage = error instanceof Error ? error.message : "Failed to create job";
      console.error("Failed to create inference job:", error);
      setErrors({ submit: errorMessage });
    } finally {
      setIsSubmitting(false);
    }
  }, [formData, onSuccess]);

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

  // If not open, don't render anything (for backward compatibility with modal usage)
  if (!isOpen) return null;

  return (
    <div className="inference-job-form-container">
      <h2 className="form-title">Create New Inference Job</h2>

      {errors.submit && (
        <div className="form-error">{errors.submit}</div>
      )}

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
            {dataFiles.length > 0 || collections.length > 0 ? (
              <select
                id="data-source"
                value={formData.dataSource}
                onChange={(e) => updateField("dataSource", e.target.value)}
                className={errors.dataSource ? "error" : ""}
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
            ) : (
              <div className="file-picker-row">
                <input
                  id="data-source"
                  type="text"
                  value={formData.dataSource}
                  onChange={(e) => updateField("dataSource", e.target.value)}
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
          {isSubmitting ? "Creating..." : "Create & Start"}
        </button>
      </div>
    </div>
  );
}
