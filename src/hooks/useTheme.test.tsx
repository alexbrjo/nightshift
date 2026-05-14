import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTheme } from "./useTheme";

describe("useTheme", () => {
  it("persists dark theme state and applies the document attribute", () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.isDark).toBe(false);
    expect(document.documentElement.dataset.theme).toBeUndefined();

    act(() => result.current.toggleTheme());

    expect(result.current.isDark).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("nightshift-theme")).toBe("dark");

    act(() => result.current.toggleTheme());

    expect(result.current.isDark).toBe(false);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem("nightshift-theme")).toBeNull();
  });
});
