/** Client-safe formatting helpers for the Usage dashboard. */
import type { UsageCostDisplay, UsageCostStatus, UsageRangeId } from "./types";

export function formatCompactTokens(value: number): string {
  if (value >= 1_000_000_000) return `${trimZero((value / 1_000_000_000).toFixed(1))}B`;
  if (value >= 1_000_000) return `${trimZero((value / 1_000_000).toFixed(1))}M`;
  if (value >= 10_000) return `${trimZero((value / 1_000).toFixed(1))}k`;
  if (value >= 1_000) return value.toLocaleString();
  return String(Math.round(value));
}

const trimZero = (text: string): string => (text.endsWith(".0") ? text.slice(0, -2) : text);

export function formatTokens(value: number): string {
  return value.toLocaleString();
}

/** Cost with the plugin's conventions: "--" when unavailable, 4+ decimals for sub-cent amounts. */
export function formatCost(amount: number | null): string {
  if (amount === null) return "--";
  if (amount === 0) return "$0";
  if (amount >= 100) return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(6)}`;
}

export function formatCostDisplay(cost: UsageCostDisplay): string {
  return formatCost(cost.amount);
}

export function formatHitRate(rate: number | null): string {
  return rate === null ? "--" : `${rate.toFixed(1)}%`;
}

export function costStatusLabelKey(status: UsageCostStatus): string {
  return `usage.cost.${status}`;
}

const bucketFormatters = new Map<string, Intl.DateTimeFormat>();

function formatBucket(ms: number, options: Intl.DateTimeFormatOptions): string {
  const key = JSON.stringify(options);
  let formatter = bucketFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, options);
    bucketFormatters.set(key, formatter);
  }
  return formatter.format(ms);
}

/** X-axis / tooltip label for a trend bucket start, adapted to the range density. */
export function formatBucketLabel(ms: number, rangeId: UsageRangeId): string {
  switch (rangeId) {
    case "today":
      return formatBucket(ms, { hour: "2-digit", minute: "2-digit" });
    case "7d":
    case "14d":
      return formatBucket(ms, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    case "30d":
      return formatBucket(ms, { month: "short", day: "numeric" });
    case "1y":
      return formatBucket(ms, { month: "short", day: "numeric" });
    case "all":
      return formatBucket(ms, { year: "numeric", month: "short" });
  }
}

/** Tooltip title line: full date + time for the hovered bucket. */
export function formatBucketFull(ms: number): string {
  return formatBucket(ms, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRefreshedAt(ms: number): string {
  return formatBucket(ms, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Heatmap tooltip date; includes the year when it differs from the current one. */
export function formatDayLabel(ms: number): string {
  const sameYear = new Date(ms).getFullYear() === new Date().getFullYear();
  return formatBucket(ms, sameYear
    ? { weekday: "short", month: "short", day: "numeric" }
    : { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

/** Short month name for heatmap column labels. */
export function formatMonthLabel(ms: number): string {
  return formatBucket(ms, { month: "short" });
}

/** Short weekday name for heatmap row labels. */
export function formatWeekdayLabel(ms: number): string {
  return formatBucket(ms, { weekday: "short" });
}
