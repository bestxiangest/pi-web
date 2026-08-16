/**
 * Shared types for the Usage dashboard.
 *
 * The data source is the pi-token-usage-statistics plugin's durable store
 * (`~/.pi/agent/token-usage-statistics/records.jsonl`). We read it read-only,
 * exactly like the plugin's own standalone viewer, and mirror its aggregation
 * contract (dedupe by recordId, cache-hit-rate formula, cost provenance
 * policy, epoch-aligned trend buckets) so both surfaces always agree.
 *
 * Keep this file client-safe: pure types and constants only, no node imports.
 */

/** Cost provenance for an aggregate ("--" in the UI when unavailable). */
export type UsageCostStatus = "recorded" | "estimated" | "mixed" | "unavailable";

export type UsageCostDisplay = {
  /** null means unavailable — never fabricate a zero price. */
  amount: number | null;
  status: UsageCostStatus;
};

export type UsageTotals = {
  totalTokens: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** cacheRead / (input + cacheRead + cacheWrite) * 100; null when denominator is 0. */
  cacheHitRate: number | null;
  cost: UsageCostDisplay;
};

export type UsageTrendPoint = {
  startMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: UsageCostDisplay;
};

/** One local calendar day in the heatmap window (startMs is local midnight). */
export type UsageDailyPoint = {
  startMs: number;
  totalTokens: number;
  cost: UsageCostDisplay;
};

export type UsageModelRow = {
  /** `${provider}/${model}` — unique display key. */
  key: string;
  provider: string;
  model: string;
  requestCount: number;
  totalTokens: number;
  cost: UsageCostDisplay;
  avgCost: UsageCostDisplay;
};

export type UsageRangeId = "today" | "7d" | "14d" | "30d" | "1y" | "all";

export type UsageRangePreset = {
  id: UsageRangeId;
  labelKey: string;
  /** Hours back from now; null = special window (today = local midnight, all = earliest record). */
  hours: number | null;
  /** Trend bucket width; 0 = auto (pick from the ladder based on span). */
  bucketMs: number;
};

/** Cycle order matches the plugin's TUI: today → 1d → 7d → 14d → 30d → 1y → all. */
export const USAGE_RANGE_PRESETS: readonly UsageRangePreset[] = [
  { id: "today", labelKey: "usage.range.today", hours: null, bucketMs: 30 * 60_000 },
  { id: "7d", labelKey: "usage.range.7d", hours: 24 * 7, bucketMs: 3 * 3_600_000 },
  { id: "14d", labelKey: "usage.range.14d", hours: 24 * 14, bucketMs: 6 * 3_600_000 },
  { id: "30d", labelKey: "usage.range.30d", hours: 24 * 30, bucketMs: 12 * 3_600_000 },
  { id: "1y", labelKey: "usage.range.1y", hours: 24 * 365, bucketMs: 7 * 24 * 3_600_000 },
  { id: "all", labelKey: "usage.range.all", hours: null, bucketMs: 0 },
] as const;

export function isUsageRangeId(value: string): value is UsageRangeId {
  return USAGE_RANGE_PRESETS.some((preset) => preset.id === value);
}

export type UsageDashboardData = {
  totals: UsageTotals;
  trend: UsageTrendPoint[];
  /** Daily heatmap series (last ~year), filtered by scope/models but not by the selected range. */
  daily: UsageDailyPoint[];
  byModel: UsageModelRow[];
  meta: {
    /** Records in the filtered set (assistant responses + summaries when included). */
    recordCount: number;
    refreshedAtMs: number;
    bucketMs: number;
    rangeId: UsageRangeId;
    scope: "global" | "project";
    project: string | null;
  };
};

export type UsageApiResponse =
  | { available: true; data: UsageDashboardData }
  | { available: false; reason: "no-plugin" };

/** Chart palette — fixed hues that stay legible in both light and dark themes. */
export const USAGE_SERIES_COLORS = {
  input: "#3b82f6",
  output: "#a855f7",
  cacheRead: "#10b981",
  cacheWrite: "#f59e0b",
  cost: "#ec4899",
} as const;

export const USAGE_MODEL_PALETTE = [
  "#3b82f6", "#10b981", "#f59e0b", "#ec4899", "#a855f7",
  "#14b8a6", "#f97316", "#6366f1", "#84cc16", "#e11d48",
] as const;
