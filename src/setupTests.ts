import "@testing-library/jest-dom";

export const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

export const mockOpen = vi.fn();
export const mockAsk = vi.fn();
export const mockSave = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpen(...args),
  ask: (...args: unknown[]) => mockAsk(...args),
  save: (...args: unknown[]) => mockSave(...args),
}));

Object.defineProperty(window, "innerWidth", { value: 1920, writable: true });
Object.defineProperty(window, "innerHeight", { value: 1080, writable: true });
