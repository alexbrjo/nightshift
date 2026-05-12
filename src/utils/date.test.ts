import { describe, expect, it } from "vitest";
import { formatDetailTimestamp, formatListTimestamp, formatShortDate } from "./date";

describe("date formatting", () => {
  const now = new Date("2026-05-03T10:30:00Z");

  it("formats recent timestamps as Now", () => {
    expect(formatListTimestamp("2026-05-03T10:29:31Z", now)).toBe("Now");
  });

  it("formats minutes", () => {
    expect(formatListTimestamp("2026-05-03T10:27:00Z", now)).toBe("3 Min ago");
  });

  it("formats hours", () => {
    expect(formatListTimestamp("2026-05-03T09:30:00Z", now)).toBe("1 Hour ago");
    expect(formatListTimestamp("2026-05-03T07:30:00Z", now)).toBe("3 Hours ago");
  });

  it("formats days and larger units", () => {
    expect(formatListTimestamp("2026-04-30T10:30:00Z", now)).toBe("3 days ago");
    expect(formatListTimestamp("2026-03-03T10:30:00Z", now)).toBe("2 months ago");
    expect(formatListTimestamp("2025-05-03T10:30:00Z", now)).toBe("1 year ago");
  });

  it("returns empty string for missing or invalid timestamps", () => {
    expect(formatListTimestamp("", now)).toBe("");
    expect(formatListTimestamp("not a date", now)).toBe("");
  });

  it("keeps short and detail timestamp formats available for non-list UI", () => {
    expect(formatShortDate("2026-05-03T10:30:00Z")).toMatch(/May 3, 2026/);
    expect(formatDetailTimestamp("2026-05-03T10:30:00Z")).toContain("2026");
  });
});
