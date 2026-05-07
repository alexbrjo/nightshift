import { useEffect, useMemo, useRef } from "react";
import { stringify as yamlStringify } from "yaml";
import Editor from "../Editor";
import type { Experiment } from "../../utils/experimentSchema";

interface Props {
  experiment: Experiment | null;
  /** When true the editor is writable and emits onChange; the parent owns the
   *  text and revalidates / saves when the user is ready. */
  editable?: boolean;
  /** Current editor text when editable; otherwise unused. */
  value?: string;
  onChange?: (next: string) => void;
}

export default function YamlPreview({ experiment, editable, value, onChange }: Props) {
  // When the parent flips into editable mode, seed the buffer once from the
  // current experiment object. After that the buffer is the source of truth
  // — we don't reseed on every experiment change because that would clobber
  // the user's edits.
  const seededRef = useRef<Experiment | null>(null);
  useEffect(() => {
    if (!editable) {
      seededRef.current = null;
      return;
    }
    if (experiment && seededRef.current !== experiment) {
      seededRef.current = experiment;
      onChange?.(yamlStringify(experiment));
    }
  }, [editable, experiment, onChange]);

  const readonlyText = useMemo(() => {
    if (!experiment) return "";
    try {
      return yamlStringify(experiment);
    } catch (e) {
      return `# Failed to render YAML: ${(e as Error).message}\n`;
    }
  }, [experiment]);

  if (!experiment) {
    return (
      <div className="preview-empty">
        The experiment YAML will appear here as the planner narrows down the design.
      </div>
    );
  }

  const code = editable ? (value ?? readonlyText) : readonlyText;

  return (
    <div className="preview-yaml">
      <Editor
        code={code}
        language="yaml"
        onChange={editable ? onChange : undefined}
      />
    </div>
  );
}
