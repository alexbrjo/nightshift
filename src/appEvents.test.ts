import { describe, expect, it, vi } from "vitest";
import { addAppEventListener, appEventName, emitAppEvent } from "./appEvents";

describe("appEvents", () => {
  it("maps event keys to their DOM event names", () => {
    expect(appEventName("methodDraftMutated")).toBe("nightshift-method-draft-mutated");
  });

  it("emits typed payloads to subscribers and supports unlisten", () => {
    const handler = vi.fn();
    const unlisten = addAppEventListener("methodExecutionStarted", handler);

    emitAppEvent("methodExecutionStarted", {
      executionId: 12,
      method: { title: "current.method.yaml" },
      sourcePanelId: "project-editor:current",
    });

    expect(handler).toHaveBeenCalledWith({
      executionId: 12,
      method: { title: "current.method.yaml" },
      sourcePanelId: "project-editor:current",
    });

    unlisten();
    emitAppEvent("methodExecutionStarted", { executionId: 13 });

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
