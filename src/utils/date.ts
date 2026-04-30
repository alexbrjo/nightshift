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
export function formatDate(dateStr?: string): string {
  if (!dateStr) return "";
  const d = parseSqliteDate(dateStr);
  if (!d) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

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

/** Long, locale-aware date+time (e.g. "4/30/2026, 2:23:45 PM"). Returns "" on parse failure. */
export function formatLongDateTime(dateStr?: string): string {
  if (!dateStr) return "";
  const d = parseSqliteDate(dateStr);
  if (!d) return "";
  return d.toLocaleString();
}
