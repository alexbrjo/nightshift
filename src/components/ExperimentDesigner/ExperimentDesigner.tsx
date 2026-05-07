// Three-pane layout: list of saved experiments | LLM-driven planner chat |
// live YAML preview. Mounted by App.tsx for the "Agent" sidebar tab.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ExperimentList from "./ExperimentList";
import ExperimentPlanner from "./ExperimentPlanner";
import YamlPreview from "./YamlPreview";
import type { Experiment } from "../../utils/experimentSchema";
import "./ExperimentDesigner.css";

export default function ExperimentDesigner() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [resetSignal, setResetSignal] = useState(0);
  const [savedExperiment, setSavedExperiment] = useState<Experiment | null>(null);
  // Live preview while drafting; null whenever the planner has no current
  // proposal (between turns or before the agent emits "kind: experiment").
  const [draftProposal, setDraftProposal] = useState<Experiment | null>(null);
  // YAML buffer the user can hand-edit when the agent fumbles the structured
  // output. Source of truth for save when populated.
  const [editorText, setEditorText] = useState<string>("");
  const editorTextRef = useRef<string>("");

  useEffect(() => {
    editorTextRef.current = editorText;
  }, [editorText]);

  useEffect(() => {
    let cancelled = false;
    if (!selectedId) {
      setSavedExperiment(null);
      return;
    }
    invoke<Experiment>("get_experiment", { id: selectedId })
      .then((e) => !cancelled && setSavedExperiment(e))
      .catch(() => !cancelled && setSavedExperiment(null));
    return () => {
      cancelled = true;
    };
  }, [selectedId, refreshKey]);

  const handleNew = useCallback(() => {
    setSelectedId(null);
    setSavedExperiment(null);
    setDraftProposal(null);
    setEditorText("");
    setResetSignal((n) => n + 1);
  }, []);

  const handleSaved = useCallback(() => {
    setRefreshKey((n) => n + 1);
    setDraftProposal(null);
    setEditorText("");
  }, []);

  const handleProposalChange = useCallback((proposal: Experiment | null) => {
    setDraftProposal(proposal);
    if (!proposal) setEditorText("");
  }, []);

  const previewExperiment = selectedId ? savedExperiment : draftProposal;
  const editable = !selectedId && !!draftProposal;

  return (
    <div className="experiment-designer">
      <ExperimentList
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={handleNew}
        refreshKey={refreshKey}
      />
      <ExperimentPlanner
        onSaved={handleSaved}
        onProposalChange={handleProposalChange}
        getEditedYaml={() => (editable ? editorTextRef.current : null)}
        selectedId={selectedId}
        resetSignal={resetSignal}
      />
      <div className="preview-pane">
        <h3>
          {selectedId
            ? "Saved experiment"
            : editable
              ? "Live preview (editable)"
              : "Live preview"}
        </h3>
        <YamlPreview
          experiment={previewExperiment}
          editable={editable}
          value={editorText}
          onChange={setEditorText}
        />
      </div>
    </div>
  );
}
