import { useRef, useEffect } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";

interface EditorProps {
  code: string;
  language?: string;
  onChange?: (code: string) => void;
}

function getLanguageExtension(lang?: string) {
  if (!lang) return [];
  const l = lang.toLowerCase();
  if (["js"].includes(l)) return [javascript()];
  if (["json"].includes(l)) return [json()];
  if (["markdown", "md", "mdx"].includes(l)) return [markdown()];
  return [];
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
