import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./date";

describe("formatRelativeTime", () => {
  const now = new Date("2026-05-03T10:30:00Z");

  it("formats recent timestamps as Now", () => {
    expect(formatRelativeTime("2026-05-03T10:29:31Z", now)).toBe("Now");
  });

  it("formats minutes", () => {
    expect(formatRelativeTime("2026-05-03T10:27:00Z", now)).toBe("3 Min ago");
  });

  it("formats hours", () => {
    expect(formatRelativeTime("2026-05-03T09:30:00Z", now)).toBe("1 Hour ago");
    expect(formatRelativeTime("2026-05-03T07:30:00Z", now)).toBe("3 Hours ago");
  });

  it("formats days and larger units", () => {
    expect(formatRelativeTime("2026-04-30T10:30:00Z", now)).toBe("3 days ago");
    expect(formatRelativeTime("2026-03-03T10:30:00Z", now)).toBe("2 months ago");
    expect(formatRelativeTime("2025-05-03T10:30:00Z", now)).toBe("1 year ago");
  });

  it("returns empty string for missing or invalid timestamps", () => {
    expect(formatRelativeTime("", now)).toBe("");
    expect(formatRelativeTime("not a date", now)).toBe("");
  });
});
