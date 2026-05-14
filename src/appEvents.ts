import { useEffect } from "react";

export interface AppEventMap {
  conversationsUpdated: undefined;
  methodExecutionStarted: {
    executionId: number;
    method?: { title?: string };
    sourcePanelId?: string;
  };
  projectFilesChanged: undefined;
  methodDraftMutated: undefined;
}

const EVENT_NAMES: { [K in keyof AppEventMap]: string } = {
  conversationsUpdated: "nightshift-conversations-updated",
  methodExecutionStarted: "nightshift-method-execution-started",
  projectFilesChanged: "nightshift-project-files-changed",
  methodDraftMutated: "nightshift-method-draft-mutated",
};

type AppEventHandler<K extends keyof AppEventMap> = (detail: AppEventMap[K]) => void;

export function appEventName<K extends keyof AppEventMap>(type: K): string {
  return EVENT_NAMES[type];
}

export function emitAppEvent<K extends keyof AppEventMap>(
  type: K,
  ...args: AppEventMap[K] extends undefined ? [] : [detail: AppEventMap[K]]
) {
  window.dispatchEvent(new CustomEvent(EVENT_NAMES[type], { detail: args[0] }));
}

export function addAppEventListener<K extends keyof AppEventMap>(
  type: K,
  handler: AppEventHandler<K>,
) {
  const listener = (event: Event) => {
    handler((event as CustomEvent<AppEventMap[K]>).detail);
  };
  window.addEventListener(EVENT_NAMES[type], listener);
  return () => window.removeEventListener(EVENT_NAMES[type], listener);
}

export function useAppEvent<K extends keyof AppEventMap>(
  type: K,
  handler: AppEventHandler<K>,
) {
  useEffect(() => addAppEventListener(type, handler), [type, handler]);
}
