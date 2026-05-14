import { getLanguage, type ProjectFileSnapshot } from "../features/project-editor/projectFileModel";

export interface ProjectFileState {
  snapshots: Record<string, ProjectFileSnapshot>;
  baselines: Record<string, string>;
  hydratingPaths: Set<string>;
}

export type ProjectFileAction =
  | { type: "reset" }
  | { type: "beginHydrating"; paths: string[] }
  | { type: "cancelHydrating"; paths: string[] }
  | { type: "finishHydrating"; path: string; snapshot: ProjectFileSnapshot; baseline: string }
  | { type: "finishHydratingMany"; files: Array<{ path: string; snapshot: ProjectFileSnapshot; baseline: string }> }
  | { type: "failHydrating"; path: string; snapshot: ProjectFileSnapshot }
  | { type: "openFromTree"; path: string; name: string; content: string; diskContent: string }
  | { type: "updateContent"; path: string; content: string }
  | { type: "markSaved"; path: string };

export const initialProjectFileState: ProjectFileState = {
  snapshots: {},
  baselines: {},
  hydratingPaths: new Set(),
};

export function projectFileReducer(
  state: ProjectFileState,
  action: ProjectFileAction,
): ProjectFileState {
  switch (action.type) {
    case "reset":
      return initialProjectFileState;
    case "beginHydrating": {
      const hydratingPaths = new Set(state.hydratingPaths);
      action.paths.forEach((path) => hydratingPaths.add(path));
      return { ...state, hydratingPaths };
    }
    case "cancelHydrating": {
      const hydratingPaths = new Set(state.hydratingPaths);
      action.paths.forEach((path) => hydratingPaths.delete(path));
      return { ...state, hydratingPaths };
    }
    case "finishHydrating": {
      const hydratingPaths = new Set(state.hydratingPaths);
      hydratingPaths.delete(action.path);
      return {
        snapshots: { ...state.snapshots, [action.path]: action.snapshot },
        baselines: { ...state.baselines, [action.path]: action.baseline },
        hydratingPaths,
      };
    }
    case "finishHydratingMany": {
      const hydratingPaths = new Set(state.hydratingPaths);
      const snapshots = { ...state.snapshots };
      const baselines = { ...state.baselines };
      for (const file of action.files) {
        hydratingPaths.delete(file.path);
        if (!snapshots[file.path]) {
          snapshots[file.path] = file.snapshot;
        }
        baselines[file.path] = file.baseline;
      }
      return { snapshots, baselines, hydratingPaths };
    }
    case "failHydrating": {
      const hydratingPaths = new Set(state.hydratingPaths);
      hydratingPaths.delete(action.path);
      return {
        snapshots: { ...state.snapshots, [action.path]: action.snapshot },
        baselines: { ...state.baselines, [action.path]: "" },
        hydratingPaths,
      };
    }
    case "openFromTree": {
      const baseline = state.baselines[action.path] ?? action.diskContent;
      return {
        ...state,
        snapshots: {
          ...state.snapshots,
          [action.path]: {
            path: action.path,
            name: action.name,
            content: action.content,
            language: getLanguage(action.name),
          },
        },
        baselines: { ...state.baselines, [action.path]: baseline },
      };
    }
    case "updateContent": {
      const snapshot = state.snapshots[action.path];
      if (!snapshot) return state;
      return {
        ...state,
        snapshots: {
          ...state.snapshots,
          [action.path]: { ...snapshot, content: action.content },
        },
      };
    }
    case "markSaved": {
      const snapshot = state.snapshots[action.path];
      return {
        ...state,
        baselines: {
          ...state.baselines,
          [action.path]: snapshot?.content ?? "",
        },
      };
    }
  }
}
