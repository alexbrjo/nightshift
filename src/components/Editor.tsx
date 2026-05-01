import { useRef, useEffect } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml as yamlMode } from "@codemirror/legacy-modes/mode/yaml";
import { rust as rustMode } from "@codemirror/legacy-modes/mode/rust";
import { shell as shellMode } from "@codemirror/legacy-modes/mode/shell";
import { jinja2 as jinja2Mode } from "@codemirror/legacy-modes/mode/jinja2";
import { oneDark } from "@codemirror/theme-one-dark";

interface EditorProps {
  code: string;
  language?: string;
  onChange?: (code: string) => void;
}

function getLanguageExtension(lang?: string) {
  if (!lang) return [];
  switch (lang.toLowerCase()) {
    case "javascript":
    case "js":
    case "jsx":
      return [javascript({ jsx: true })];
    case "typescript":
    case "ts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "python":
    case "py":
      return [python()];
    case "html":
    case "htm":
      return [html()];
    case "css":
      return [css()];
    case "json":
    case "jsonl":
      return [json()];
    case "markdown":
    case "md":
    case "mdx":
      return [markdown()];
    case "yaml":
    case "yml":
      return [StreamLanguage.define(yamlMode)];
    case "rust":
    case "rs":
      return [StreamLanguage.define(rustMode)];
    case "bash":
    case "sh":
    case "shell":
      return [StreamLanguage.define(shellMode)];
    case "jinja":
    case "jinja2":
    case "j2":
      return [StreamLanguage.define(jinja2Mode)];
    default:
      return [];
  }
}

export default function Editor({ code, language, onChange }: EditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!editorRef.current) return;

    viewRef.current?.destroy();

    const startState = EditorState.create({
      doc: code,
      extensions: [
        basicSetup,
        oneDark,
        ...getLanguageExtension(language),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange?.(update.state.doc.toString());
          }
        }),
        EditorView.editable.of(true),
      ],
    });

    const view = new EditorView({
      state: startState,
      parent: editorRef.current,
    });

    viewRef.current = view;

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [language]);

  useEffect(() => {
    if (viewRef.current && code !== viewRef.current.state.doc.toString()) {
      const transaction = viewRef.current.state.update({
        changes: {
          from: 0,
          to: viewRef.current.state.doc.length,
          insert: code,
        },
      });
      viewRef.current.dispatch(transaction);
    }
  }, [code]);

  return (
    <div className="cm-editor-wrapper">
      <div ref={editorRef} className="cm-editor-container" />
    </div>
  );
}
