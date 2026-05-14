import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { parse } from "yaml";
import type { MethodDocument } from "../database";
import type { EditorViewMode } from "../layout";
import MethodGraph from "./MethodGraph";

interface ProjectFileViewProps {
  content: string;
  filePath: string;
  fileName: string;
}

export interface ProjectFileViewOption {
  mode: EditorViewMode;
  label: string;
}

const CODE_VIEW: ProjectFileViewOption = { mode: "code", label: "Code" };
const MARKDOWN_VIEW: ProjectFileViewOption = { mode: "markdown", label: "Markdown preview" };
const METHOD_GRAPH_VIEW: ProjectFileViewOption = { mode: "methodGraph", label: "Method graph" };

export function projectFileViewOptions(filePath: string, fileName: string): ProjectFileViewOption[] {
  const views = [CODE_VIEW];
  if (isMarkdownFile(fileName)) views.push(MARKDOWN_VIEW);
  if (isYamlFile(filePath, fileName)) views.push(METHOD_GRAPH_VIEW);
  return views;
}

export function isProjectFileViewAvailable(
  mode: EditorViewMode | undefined,
  filePath: string,
  fileName: string,
) {
  const normalized = mode ?? "code";
  return projectFileViewOptions(filePath, fileName).some((view) => view.mode === normalized);
}

export function MarkdownPreview({ content }: Pick<ProjectFileViewProps, "content">) {
  return (
    <div className="project-file-preview markdown-preview" data-testid="markdown-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function MethodGraphPreview({ content }: Pick<ProjectFileViewProps, "content">) {
  const result = parseMethodDocument(content);

  if (!result.ok) {
    return (
      <div className="project-file-preview-error" role="status">
        <strong>Method graph unavailable</strong>
        <span>{result.error}</span>
      </div>
    );
  }

  return (
    <div className="project-file-method-graph" data-testid="method-graph-preview">
      <MethodGraph draft={result.method} />
    </div>
  );
}

function parseMethodDocument(content: string): { ok: true; method: MethodDocument } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (err) {
    return { ok: false, error: `Could not parse Method YAML: ${String(err)}` };
  }

  if (!isMethodDocument(parsed)) {
    return { ok: false, error: "This file is not a valid Method document." };
  }

  return { ok: true, method: parsed };
}

function isMarkdownFile(fileName: string) {
  const ext = fileName.split(".").pop()?.toLowerCase();
  return ext === "md" || ext === "markdown" || ext === "mdx";
}

function isYamlFile(filePath: string, fileName: string) {
  const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
  const normalizedName = fileName.toLowerCase();
  return normalizedName.endsWith(".yaml")
    || normalizedName.endsWith(".yml")
    || normalizedPath.endsWith(".yaml")
    || normalizedPath.endsWith(".yml");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMethodDocument(value: unknown): value is MethodDocument {
  if (!isRecord(value)) return false;
  const workflow = value.workflow;
  return (
    typeof value.schema_version === "number"
    && typeof value.id === "string"
    && typeof value.title === "string"
    && isRecord(workflow)
    && Array.isArray(workflow.nodes)
  );
}
