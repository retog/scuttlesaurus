/**
 * Formatting of times and counts for display.
 *
 * @module
 */

const MONTH_DAY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const MONTH_DAY_YEAR = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const FULL = new Intl.DateTimeFormat(undefined, {
  dateStyle: "long",
  timeStyle: "short",
});
const DATE_ONLY = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });

/**
 * Compact relative time for a unix timestamp in seconds: "now", "3m", "2h",
 * "4d", then "Nov 3" (with the year when it is not the current one).
 */
export function relativeTime(
  createdAt: number,
  now: number = Date.now() / 1000,
): string {
  const delta = Math.max(0, Math.floor(now - createdAt));
  if (delta < 60) return "now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 7 * 86400) return `${Math.floor(delta / 86400)}d`;
  const date = new Date(createdAt * 1000);
  const sameYear = date.getFullYear() === new Date(now * 1000).getFullYear();
  return (sameYear ? MONTH_DAY : MONTH_DAY_YEAR).format(date);
}

/** "November 3, 2026 at 4:12 PM" in the viewer's locale. */
export function fullDate(createdAt: number): string {
  return FULL.format(new Date(createdAt * 1000));
}

/** "November 3, 2026" in the viewer's locale. */
export function dateOnly(createdAt: number): string {
  return DATE_ONLY.format(new Date(createdAt * 1000));
}

/** 999 → "999", 1234 → "1.2k", 3_400_000 → "3.4M". */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  const trim = (
    v: number,
  ) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

/** "4 min read" for a text, at 220 words a minute (at least one minute). */
export function readingTime(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return `${Math.max(1, Math.round(words / 220))} min read`;
}
