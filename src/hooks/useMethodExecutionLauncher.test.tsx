import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addAppEventListener } from "../appEvents";
import { mockInvoke } from "../setupTests";
import { useMethodExecutionLauncher } from "./useMethodExecutionLauncher";

describe("useMethodExecutionLauncher", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("does not execute dirty Method files", async () => {
    const { result } = renderHook(() => useMethodExecutionLauncher(new Set(["methods/current.method.yaml"])));

    await act(async () => {
      await result.current.executeMethodFile("methods/current.method.yaml", "panel-1");
    });

    expect(mockInvoke).not.toHaveBeenCalledWith("execute_method_file", expect.anything());
  });

  it("emits a typed execution event and records success feedback", async () => {
    mockInvoke.mockResolvedValue({
      id: 42,
      methodId: "current",
      methodContentHash: "hash",
      status: "queued",
      createdAt: "2026-05-13T00:00:00Z",
    });
    const handler = vi.fn();
    const unlisten = addAppEventListener("methodExecutionStarted", handler);
    const { result } = renderHook(() => useMethodExecutionLauncher(new Set()));

    await act(async () => {
      await result.current.executeMethodFile("methods/current.method.yaml", "panel-1");
    });

    expect(mockInvoke).toHaveBeenCalledWith("execute_method_file", { methodPath: "methods/current.method.yaml" });
    expect(handler).toHaveBeenCalledWith({
      executionId: 42,
      method: { title: "current.method.yaml" },
      sourcePanelId: "panel-1",
    });
    expect(result.current.methodExecutionFeedback["methods/current.method.yaml"]).toEqual({
      tone: "success",
      text: "Started execution #42.",
    });

    unlisten();
  });

  it("blocks duplicate execution while a launch is in flight", async () => {
    let resolveExecution: (value: { id: number }) => void = () => undefined;
    mockInvoke.mockReturnValue(new Promise((resolve) => {
      resolveExecution = resolve;
    }));
    const { result } = renderHook(() => useMethodExecutionLauncher(new Set()));

    void act(() => {
      void result.current.executeMethodFile("methods/current.method.yaml", "panel-1");
    });
    await waitFor(() => expect(result.current.executingMethodPath).toBe("methods/current.method.yaml"));

    await act(async () => {
      await result.current.executeMethodFile("methods/current.method.yaml", "panel-1");
    });

    expect(mockInvoke.mock.calls.filter(([command]) => command === "execute_method_file")).toHaveLength(1);

    await act(async () => {
      resolveExecution({ id: 42 });
      await Promise.resolve();
    });
  });

  it("records error feedback when execution launch fails", async () => {
    mockInvoke.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useMethodExecutionLauncher(new Set()));

    await act(async () => {
      await result.current.executeMethodFile("methods/current.method.yaml", "panel-1");
    });

    expect(result.current.methodExecutionFeedback["methods/current.method.yaml"]).toEqual({
      tone: "error",
      text: "Error: boom",
    });
  });
});
