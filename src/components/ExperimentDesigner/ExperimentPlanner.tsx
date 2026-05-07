// Orchestrates the multi-turn chat with the planner LLM. Holds the message
// history client-side, parses each assistant turn into a PlannerTurn, and
// renders the right card. The user's confirmation appends to history and
// triggers the next chat_complete call.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { parse as yamlParse } from "yaml";
import {
  parsePlannerTurn,
  PLANNER_TURN_SCHEMA,
  type Experiment,
  type PlannerTurn,
} from "../../utils/experimentSchema";
import { buildSystemPrompt, type PlannerContext } from "../../utils/agentSystemPrompt";
import {
  QuestionCard,
  FreeformCard,
  UserAnswerCard,
  ProposalCard,
  HistoryTurnCard,
} from "./PlannerCards";
import PlannerDebugPanel, { type DebugTrace } from "./PlannerDebugPanel";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompleteResult {
  content: string;
  reasoning: string | null;
  raw_body: string;
}

interface PlannerSettings {
  provider: string;
  model: string;
  server_url: string;
}

const SETTINGS_KEY = "nightshift-planner-settings";

function loadSettings(): PlannerSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {}
  return defaultSettings;
}

const defaultSettings: PlannerSettings = {
  provider: "Local",
  model: "",
  server_url: "http://localhost:8080",
};

interface Props {
  /** When the user saves a new experiment, bump this so the list reloads. */
  onSaved: () => void;
  /** Notifies the parent of the in-flight proposal so the YAML pane can preview it. */
  onProposalChange: (proposal: Experiment | null) => void;
  /** When the user has hand-edited the YAML in the right pane, the planner
   *  should save THAT instead of its cached proposal. The parent supplies
   *  the current text via this getter. */
  getEditedYaml?: () => string | null;
  /** Selected saved experiment id (null = drafting a new one). */
  selectedId: string | null;
  /** When the parent flips selectedId back to null, the planner should reset. */
  resetSignal: number;
}

export default function ExperimentPlanner({
  onSaved,
  onProposalChange,
  getEditedYaml,
  selectedId,
  resetSignal,
}: Props) {
  const [settings, setSettings] = useState<PlannerSettings>(loadSettings);
  const [context, setContext] = useState<PlannerContext | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingTurn, setPendingTurn] = useState<PlannerTurn | null>(null);
  const [proposal, setProposal] = useState<Experiment | null>(null);
  const [proposalAck, setProposalAck] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedExperiment, setSavedExperiment] = useState<Experiment | null>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [lastTrace, setLastTrace] = useState<DebugTrace | null>(null);
  const [pitch, setPitch] = useState("");
  const pitchRef = useRef<string>("");
  useEffect(() => {
    pitchRef.current = pitch;
  }, [pitch]);

  // Persist settings.
  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  // Load file lists each time we (re)start drafting; the lists become part of
  // the system prompt so the agent only proposes existing files.
  const loadContext = useCallback(async () => {
    try {
      const [promptFiles, dataFiles, schemaFiles, scriptFiles] = await Promise.all([
        invoke<string[]>("list_prompt_files"),
        invoke<string[]>("list_data_files"),
        invoke<string[]>("list_schema_files"),
        invoke<string[]>("list_transform_scripts"),
      ]);
      setContext({
        promptFiles,
        dataFiles,
        schemaFiles,
        scriptFiles,
        defaultProvider: settings.provider,
        defaultModel: settings.model,
        defaultServerUrl: settings.server_url,
      });
      setError(null);
    } catch (e) {
      const msg = String(e);
      if (/no folder opened|no project folder is open/i.test(msg)) {
        setError("Open a project folder before starting the planner.");
      } else {
        setError(`Failed to load file lists: ${msg}`);
      }
    }
  }, [settings]);

  // Reset cached context when the project changes so the next Start uses the
  // new project's file lists.
  useEffect(() => {
    const unlistenPromise = listen("project-opened", () => {
      setContext(null);
      setError(null);
    });
    return () => {
      void unlistenPromise.then((u) => u());
    };
  }, []);

  // When the user picks a saved experiment, load it into the preview pane and
  // hide the planner UI (read-only mode in v1).
  useEffect(() => {
    let cancelled = false;
    if (!selectedId) {
      setSavedExperiment(null);
      return;
    }
    invoke<Experiment>("get_experiment", { id: selectedId })
      .then((e) => {
        if (!cancelled) setSavedExperiment(e);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Reset draft state whenever the parent asks (e.g. "+ New experiment").
  // The very first signal (0) fires on mount and should be a no-op; only
  // subsequent bumps reset and try to start the flow automatically.
  useEffect(() => {
    if (resetSignal === 0) return;
    setMessages([]);
    setPendingTurn(null);
    setProposal(null);
    setError(null);
    setContext(null);
    if (settings.model.trim()) {
      void loadContext();
    } else {
      modelInputRef.current?.focus();
    }
    // We intentionally don't depend on settings/loadContext — bumping
    // resetSignal is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  const callPlanner = useCallback(
    async (history: ChatMessage[]) => {
      if (!context) return;
      if (!settings.model.trim()) {
        setError("Set a model in the controls below before starting.");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const responseFormat = {
          type: "json_schema",
          json_schema: {
            name: "planner_turn",
            strict: false,
            schema: PLANNER_TURN_SCHEMA,
          },
        };
        const result = await invoke<ChatCompleteResult>("chat_complete", {
          serverUrl: settings.server_url,
          model: settings.model,
          messages: history,
          responseFormat,
          temperature: 0.6,
        });
        const content = result.content;
        let turn: PlannerTurn | null = null;
        let parseError: string | null = null;
        try {
          turn = parsePlannerTurn(content);
        } catch (e) {
          parseError = (e as Error).message;
        }
        setLastTrace({
          reasoning: result.reasoning,
          rawBody: result.raw_body,
          parsedTurn: turn,
          parseError,
          timestamp: Date.now(),
        });
        if (parseError || !turn) {
          throw new Error(parseError ?? "Planner returned an unparseable turn");
        }
        setMessages([...history, { role: "assistant", content }]);
        if (turn.kind === "experiment") {
          setProposal(turn.experiment);
          setProposalAck(turn.acknowledgment);
          onProposalChange(turn.experiment);
          setPendingTurn(null);
        } else {
          setPendingTurn(turn);
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [context, settings],
  );

  const handleStart = useCallback(async () => {
    await loadContext();
  }, [loadContext]);

  // One-shot draft generator: when the user front-loaded a pitch, skip the
  // multi-turn `kind: question | freeform | experiment` schema entirely.
  // Local models routinely take the "ask a question" branch even when they
  // have everything they need; one-shot generation against a single output
  // shape sidesteps that failure mode. Refinement happens via the chat
  // afterward (the proposal is just a starting draft).
  const runOneShot = useCallback(
    async (userPitch: string) => {
      if (!context) return;
      if (!settings.model.trim()) {
        setError("Set a model in the controls below before starting.");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await invoke<{ experiment: Experiment; raw_body: string }>(
          "generate_experiment_draft",
          {
            serverUrl: settings.server_url,
            model: settings.model,
            pitch: userPitch,
            context: {
              prompt_files: context.promptFiles,
              data_files: context.dataFiles,
              schema_files: context.schemaFiles,
              script_files: context.scriptFiles,
              default_provider: context.defaultProvider,
              default_model: context.defaultModel,
              default_server_url: context.defaultServerUrl,
            },
          },
        );
        setProposal(result.experiment);
        setProposalAck(undefined);
        onProposalChange(result.experiment);
        setPendingTurn(null);
        // Seed the chat with a synthetic acknowledgment so refinement turns
        // have history to work with.
        const system: ChatMessage = { role: "system", content: buildSystemPrompt(context) };
        const seed: ChatMessage = { role: "user", content: userPitch };
        const synth: ChatMessage = {
          role: "assistant",
          content: JSON.stringify({
            kind: "experiment",
            acknowledgment: "Draft generated from your description. Edit the YAML on the right or chat with me to refine.",
            experiment: result.experiment,
          }),
        };
        setMessages([system, seed, synth]);
        setLastTrace({
          reasoning: null,
          rawBody: result.raw_body,
          parsedTurn: null,
          parseError: null,
          timestamp: Date.now(),
        });
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [context, settings, onProposalChange],
  );

  // Once the file-list context is loaded, kick off either the one-shot draft
  // (if pitch present) or the iterative planner chat (otherwise).
  useEffect(() => {
    if (context && messages.length === 0 && !pendingTurn && !proposal && !selectedId) {
      const userPitch = pitchRef.current.trim();
      if (userPitch) {
        void runOneShot(userPitch);
        return;
      }
      const system: ChatMessage = { role: "system", content: buildSystemPrompt(context) };
      const seed: ChatMessage = {
        role: "user",
        content: "Help me design an experiment. Start with the first question.",
      };
      const initial = [system, seed];
      setMessages(initial);
      callPlanner(initial);
    }
  }, [context, messages.length, pendingTurn, proposal, selectedId, callPlanner, runOneShot]);

  const handleAnswer = useCallback(
    (answer: string) => {
      const next: ChatMessage[] = [...messages, { role: "user", content: answer }];
      setMessages(next);
      setPendingTurn(null);
      callPlanner(next);
    },
    [messages, callPlanner],
  );

  // Escape hatch: when the model loops on "I'll generate the experiment now"
  // freeform turns instead of actually emitting `kind: "experiment"`, the
  // user can click this to send a direct system-style nudge.
  const handleForceGenerate = useCallback(() => {
    const nudge: ChatMessage = {
      role: "user",
      content:
        "STOP asking and emit `kind: \"experiment\"` now with every field filled from what we've already discussed. Do not produce another question or freeform turn. If a field is uncertain, pick a sensible default and note it in the acknowledgment.",
    };
    const next = [...messages, nudge];
    setMessages(next);
    setPendingTurn(null);
    callPlanner(next);
  }, [messages, callPlanner]);

  const handleRefine = useCallback(() => {
    setProposal(null);
    onProposalChange(null);
    handleAnswer(
      "Let's revise the proposal — ask another question to drill into anything that needs adjustment.",
    );
  }, [handleAnswer, onProposalChange]);

  const handleSave = useCallback(async () => {
    if (!proposal) return;
    setSaving(true);
    setError(null);
    try {
      // Prefer the user's hand-edited YAML if the right pane has it; this
      // is the escape hatch when the model emits a half-empty experiment.
      const editedYaml = getEditedYaml?.();
      let candidate: Experiment;
      if (editedYaml && editedYaml.trim()) {
        try {
          candidate = yamlParse(editedYaml) as Experiment;
        } catch (e) {
          throw new Error(`YAML parse error: ${(e as Error).message}`);
        }
      } else {
        candidate = proposal;
      }
      const stamped: Experiment = {
        ...candidate,
        created_at: candidate.created_at || new Date().toISOString(),
      };
      await invoke("save_experiment", { experiment: stamped });
      setProposal(null);
      onProposalChange(null);
      setMessages([]);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [proposal, getEditedYaml, onSaved, onProposalChange]);

  // Render the conversation as alternating cards: each assistant turn (read
  // back from its JSON payload) followed by the user's answer. The most
  // recent assistant turn is intentionally NOT included here — the live
  // QuestionCard / FreeformCard / ProposalCard renders that one with its
  // input controls.
  const renderedHistory = useMemo(() => {
    const visible = messages.filter((m) => m.role !== "system");
    // The seed user message ("Help me design an experiment…") is internal
    // scaffolding; skip it.
    const start = visible[0]?.role === "user" ? 1 : 0;
    const out: ReactElement[] = [];
    let pendingAssistant: { header: string; body: string; acknowledgment?: string } | null = null;
    for (let i = start; i < visible.length; i++) {
      const m = visible[i];
      const isLastAssistant = m.role === "assistant" && i === visible.length - 1;
      if (m.role === "assistant" && !isLastAssistant) {
        // Parse the JSON turn back into a card; fall back to raw content if
        // the model emitted something off-schema.
        try {
          const turn = parsePlannerTurn(m.content);
          if (turn.kind === "question") {
            const body = `${turn.question}\n\nOptions: ${turn.options.map((o) => o.label).join(", ")}`;
            pendingAssistant = { header: turn.header, body, acknowledgment: turn.acknowledgment };
          } else if (turn.kind === "freeform") {
            pendingAssistant = {
              header: turn.header,
              body: turn.prompt,
              acknowledgment: turn.acknowledgment,
            };
          } else {
            pendingAssistant = {
              header: "Proposal",
              body: "Proposed full experiment definition.",
              acknowledgment: turn.acknowledgment,
            };
          }
        } catch {
          pendingAssistant = { header: "Agent", body: m.content };
        }
      } else if (m.role === "user") {
        if (pendingAssistant) {
          out.push(
            <HistoryTurnCard
              key={`a-${i}`}
              header={pendingAssistant.header}
              acknowledgment={pendingAssistant.acknowledgment}
              body={pendingAssistant.body}
            />,
          );
          pendingAssistant = null;
        }
        out.push(<UserAnswerCard key={`u-${i}`} text={m.content} />);
      }
    }
    return out;
  }, [messages]);

  // ---------- Render ----------

  if (selectedId && savedExperiment) {
    return (
      <div className="planner-pane">
        <div className="planner-history">
          <div className="planner-card assistant">
            <span className="header">Saved</span>
            <div className="question">{savedExperiment.hypothesis}</div>
            <div className="planner-status">
              IV: {savedExperiment.independent_variable.name} —{" "}
              {savedExperiment.independent_variable.values.length} value(s).
              See the YAML on the right. Editing is not supported in v1.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="planner-pane">
      <div className="planner-history" data-testid="planner-history">
        {renderedHistory}
        {pendingTurn?.kind === "question" ? (
          <QuestionCard turn={pendingTurn} onConfirm={handleAnswer} disabled={loading} />
        ) : null}
        {pendingTurn?.kind === "freeform" ? (
          <FreeformCard turn={pendingTurn} onConfirm={handleAnswer} disabled={loading} />
        ) : null}
        {proposal ? (
          <ProposalCard
            acknowledgment={proposalAck}
            onSave={handleSave}
            onRefine={handleRefine}
            disabled={loading}
            saving={saving}
          />
        ) : null}
        {loading ? <div className="planner-status">Planner is thinking…</div> : null}
        {!loading && messages.filter((m) => m.role === "user").length >= 2 && !proposal ? (
          <div className="planner-status">
            Stuck in a loop?{" "}
            <button type="button" onClick={handleForceGenerate} disabled={loading}>
              Force generate experiment
            </button>
          </div>
        ) : null}
        {error ? <div className="planner-error">{error}</div> : null}
        <PlannerDebugPanel
          open={debugOpen}
          onToggle={setDebugOpen}
          context={context}
          messages={messages}
          trace={lastTrace}
        />
        {messages.length === 0 && !loading && !error ? (
          <div className="planner-status">
            Configure a model below and click <b>Start planning</b> to begin.
          </div>
        ) : null}
      </div>
      <div className="planner-startbar">
        {messages.length === 0 ? (
          <textarea
            className="planner-pitch"
            rows={3}
            value={pitch}
            onChange={(e) => setPitch(e.target.value)}
            placeholder="(Optional) Describe your experiment in any detail you want — hypothesis or goal, the variable to sweep and its values, prompt and data files, evals. The agent will fill defaults for anything missing and produce a draft on the first turn."
            disabled={loading}
          />
        ) : null}
        <div className="planner-startrow">
          <label>
            Server URL{" "}
            <input
              type="text"
              value={settings.server_url}
              onChange={(e) => setSettings({ ...settings, server_url: e.target.value })}
              style={{ width: 200 }}
            />
          </label>
          <label>
            Model{" "}
            <input
              ref={modelInputRef}
              type="text"
              value={settings.model}
              onChange={(e) => setSettings({ ...settings, model: e.target.value })}
              placeholder="e.g. gpt-4o or local-model"
              style={{ width: 180 }}
            />
          </label>
          <button
            type="button"
            className="primary"
            onClick={handleStart}
            disabled={loading || messages.length > 0}
          >
            {messages.length > 0 ? "Planning…" : pitch.trim() ? "Generate draft" : "Start planning"}
          </button>
        </div>
      </div>
    </div>
  );
}

export type { Experiment };
