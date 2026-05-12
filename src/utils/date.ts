/**
 * Parse a SQLite-style timestamp into a Date.
 *
 * SQLite returns datetimes as `YYYY-MM-DD HH:MM:SS` (space separator, no zone).
 * Safari/WebKit (the Tauri runtime on macOS) cannot reliably parse that with
 * `new Date()` and produces "Invalid Date". This normalizes to ISO-8601 with a
 * `T` separator and a `Z` suffix so all engines agree on UTC.
 */
function parseSqliteDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const normalized = dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T") + "Z";
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Short date (e.g. "Apr 30, 2026"). Returns "" on parse failure. */
export function formatShortDate(dateStr?: string): string {
  if (!dateStr) return "";
  const d = parseSqliteDate(dateStr);
  if (!d) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** @deprecated Prefer formatShortDate for date-only UI. */
export const formatDate = formatShortDate;

/** Short date + 24h time (e.g. "Apr 30, 14:23"). Returns "" on parse failure. */
export function formatDateTime(dateStr?: string): string {
  if (!dateStr) return "";
  const d = parseSqliteDate(dateStr);
  if (!d) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Relative time for compact lists (e.g. "Now", "3 Min ago", "1 Hour ago"). */
export function formatListTimestamp(dateStr?: string, now: Date = new Date()): string {
  if (!dateStr) return "";
  const d = parseSqliteDate(dateStr);
  if (!d) return "";

  const diffMs = Math.max(0, now.getTime() - d.getTime());
  const diffSeconds = Math.floor(diffMs / 1000);
  if (diffSeconds < 60) return "Now";

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes} Min ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} ${diffHours === 1 ? "Hour" : "Hours"} ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) {
    return `${diffDays} ${diffDays === 1 ? "day" : "days"} ago`;
  }

  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) {
    return `${diffMonths} ${diffMonths === 1 ? "month" : "months"} ago`;
  }

  const diffYears = Math.floor(diffDays / 365);
  return `${diffYears} ${diffYears === 1 ? "year" : "years"} ago`;
}

/** @deprecated Prefer formatListTimestamp for compact list UI. */
export const formatRelativeTime = formatListTimestamp;

/** Long, locale-aware date+time (e.g. "4/30/2026, 2:23:45 PM"). Returns "" on parse failure. */
export function formatDetailTimestamp(dateStr?: string): string {
  if (!dateStr) return "";
  const d = parseSqliteDate(dateStr);
  if (!d) return "";
  return d.toLocaleString();
}

/** @deprecated Prefer formatDetailTimestamp for detail UI. */
export const formatLongDateTime = formatDetailTimestamp;
