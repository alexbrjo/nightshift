import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

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
  preRenderUrl?: string;
  preRenderTimeout?: number;
  preRenderBody?: string;
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

export default function InferenceJobForm({ isOpen, onClose, onSuccess }: InferenceJobFormProps) {
  const [formData, setFormData] = useState<JobConfig>({
    name: "",
    promptFile: "",
    dataSource: "",
    provider: "Local",
    model: "",
    serverUrl: "http://localhost:8000",
    outputMode: "Unstructured",
    samples: 1,
    strategy: "Single",
  });

  const [promptFiles, setPromptFiles] = useState<string[]>([]);
  const [isLoadingPrompts, setIsLoadingPrompts] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load prompt files when form is opened
  useEffect(() => {
    if (isOpen) {
      loadPromptFiles();
    }
  }, [isOpen]);

  const loadPromptFiles = async () => {
    try {
      setIsLoadingPrompts(true);
      // Get current working directory or use a default path
      const basePath = await invoke<string>("get_root_path");
      if (basePath) {
        const prompts = await invoke<string[]>("list_prompt_files", { basePath });
        setPromptFiles(prompts);
      } else {
        // Fallback to current directory
        const prompts = await invoke<string[]>("list_prompt_files", { basePath: "." });
        setPromptFiles(prompts);
      }
    } catch (error) {
      console.error("Failed to load prompt files:", error);
      setPromptFiles([]);
    } finally {
      setIsLoadingPrompts(false);
    }
  };

  // Reset form when opened using useEffect to avoid infinite re-renders
  useEffect(() => {
    if (isOpen) {
      setFormData({
        name: "",
        promptFile: "",
        dataSource: "",
        provider: "Local",
        model: "bonsai-8b",
        serverUrl: "http://localhost:1234",
        outputMode: "Unstructured",
        samples: 1,
        strategy: "Single",
      });
      setErrors({});
    }
  }, [isOpen]);

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
          preRenderUrl: formData.preRenderUrl || null,
          preRenderTimeout: formData.preRenderTimeout || null,
          preRenderBody: formData.preRenderBody || null,
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
          <>
            <select
              id="prompt-file"
              value={formData.promptFile}
              onChange={(e) => updateField("promptFile", e.target.value)}
              className={errors.promptFile ? "error" : ""}
            >
              <option value="">Select a prompt file...</option>
              {promptFiles.map((file) => (
                <option key={file} value={file}>
                  {file}
                </option>
              ))}
            </select>
            <div className="prompt-hint">
              Found {promptFiles.length} prompt file{promptFiles.length !== 1 ? 's' : ''} in your project
            </div>
          </>
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
              No prompt files found. Enter path manually or add .jinja2/.prompt files to your project
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
              placeholder="http://localhost:8000 (base URL, /v1/chat/completions appended automatically)"
              className={errors.serverUrl ? "error" : ""}
            />
            {errors.serverUrl && <span className="error-message">{errors.serverUrl}</span>}
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="max-tokens">Max Tokens</label>
            <div className="number-input">
              <button type="button" onClick={() => updateField("maxTokens", Math.max(1, (formData.maxTokens || 1024) - 256))}>-</button>
              <input
                id="max-tokens"
                type="number"
                value={formData.maxTokens || ""}
                onChange={(e) => updateField("maxTokens", e.target.value ? parseInt(e.target.value) : undefined)}
                placeholder="1024"
              />
              <button type="button" onClick={() => updateField("maxTokens", (formData.maxTokens || 1024) + 256)}>+</button>
            </div>
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
              <div className="file-picker-row">
                <input
                  id="json-schema-file"
                  type="text"
                  value={formData.jsonSchemaFile || ""}
                  onChange={(e) => updateField("jsonSchemaFile", e.target.value)}
                  placeholder="path/to/schema.json"
                />
                <button type="button" className="btn-secondary" onClick={() => {}}>
                  Browse
                </button>
              </div>
            </div>
          )}
        </div>
      </fieldset>

      <div className="form-fieldsets-stack">
      {/* Sampling Controls */}
      <fieldset className="sampling-section">
        <legend>Samples & Strategy</legend>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="samples">Number of Samples</label>
            <select
              id="samples"
              value={formData.samples}
              onChange={(e) => updateField("samples", parseInt(e.target.value))}
            >
              {[1, 5, 10, 25, 50, 100, 250, 500, 1000].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
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
            <div className="file-picker-row">
              <input
                id="data-source"
                type="text"
                value={formData.dataSource}
                onChange={(e) => updateField("dataSource", e.target.value)}
                placeholder="path/to/data.jsonl"
                className={errors.dataSource ? "error" : ""}
              />
              <button type="button" className="btn-secondary" onClick={() => {}}>
                Browse
              </button>
            </div>
            {errors.dataSource && <span className="error-message">{errors.dataSource}</span>}
          </div>
        </div>
      </fieldset>

      {/* Pre-render Request (Optional) */}
      <fieldset className="prerender-section">
        <legend>Pre-render Request (Optional)</legend>

        <div className="form-group">
          <label htmlFor="pre-render-url">URL</label>
          <input
            id="pre-render-url"
            type="text"
            value={formData.preRenderUrl || ""}
            onChange={(e) => updateField("preRenderUrl", e.target.value)}
            placeholder="http://localhost:8081"
          />
        </div>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="pre-render-timeout">Timeout (s)</label>
            <select
              id="pre-render-timeout"
              value={formData.preRenderTimeout?.toString() || ""}
              onChange={(e) => updateField("preRenderTimeout", e.target.value ? parseInt(e.target.value) : undefined)}
            >
              {[5, 10, 15, 30, 60, 120].map((s) => (
                <option key={s} value={s}>{s}s</option>
              ))}
            </select>
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="pre-render-body">Request Body (Jinja2 → JSON)</label>
          <textarea
            id="pre-render-body"
            value={formData.preRenderBody || ""}
            onChange={(e) => updateField("preRenderBody", e.target.value)}
            placeholder='{"query_texts": ["{{ topic }}"], "n_results": 3}'
            rows={4}
          />
        </div>
      </fieldset>
      </div>
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
