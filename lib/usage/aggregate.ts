/**
 * Pure aggregation over the plugin's normalized UsageRecords.
 *
 * Semantics deliberately mirror pi-token-usage-statistics `src/domain/aggregate.ts`:
 * - dedupe by recordId (last occurrence wins) before filtering;
 * - requestCount counts finalized assistant responses only; summary usage
 *   contributes tokens/cost but never requests (excluded by default);
 * - cacheHitRate = cacheRead / (input + cacheRead + cacheWrite) * 100;
 * - cost provenance: any unavailable record makes the aggregate "--", an empty
 *   set is a well-defined $0 (recorded), otherwise recorded + estimated with a
 *   mixed/estimated/recorded status;
 * - trend buckets are epoch-aligned, empty buckets are emitted, and the "all"
 *   window starts at the earliest filtered record instead of the Unix epoch;
 * - project paths compare normalized (slash direction, case, trailing slash).
 */
import type {
  UsageCostDisplay,
  UsageCostStatus,
  UsageDailyPoint,
  UsageModelRow,
  UsageRangeId,
  UsageTotals,
  UsageTrendPoint,
} from "./types";

/** Minimal record shape the aggregator needs — a structural subset of the plugin's UsageRecord. */
export type UsageRecordInput = {
  recordId: string;
  sessionId: string;
  projectCwd: string;
  timestampMs: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  recordedCost?: { total: number };
  estimatedCost?: { total: number };
  costKind: "recorded" | "estimated" | "unavailable";
  sourceKind: "assistant" | "summary";
};

export type AggregateOptions = {
  fromMs: number;
  toMs: number;
  /** 0 = auto: pick a bucket from the ladder so the point count stays bounded. */
  bucketMs: number;
  projects?: string[];
  /** `${provider}/${model}` keys; empty = all models. */
  modelKeys?: string[];
  includeSummary: boolean;
};

/** Bucket ladder for auto selection (30m → 90d). */
const BUCKET_LADDER_MS = [
  30 * 60_000,
  3_600_000,
  3 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  86_400_000,
  3 * 86_400_000,
  7 * 86_400_000,
  14 * 86_400_000,
  30 * 86_400_000,
  90 * 86_400_000,
];

/** Upper bound on emitted trend points (the plugin allows 10k for its TUI; a web chart wants fewer). */
const MAX_TREND_POINTS = 480;

export type AggregateResult = {
  totals: UsageTotals;
  trend: UsageTrendPoint[];
  byModel: UsageModelRow[];
  recordCount: number;
  bucketMs: number;
};

const normalizePath = (p: string): string => {
  const s = p.replace(/\\/g, "/").toLowerCase();
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
};

const isCacheHitComputable = (input: number, cacheRead: number, cacheWrite: number) =>
  input + cacheRead + cacheWrite > 0;

export function cacheHitRate(inputTokens: number, cacheReadTokens: number, cacheWriteTokens: number): number | null {
  const denominator = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (denominator === 0) return null;
  return (cacheReadTokens / denominator) * 100;
}

type CostSums = { recorded: number; estimated: number; unavailableCount: number };

const costDisplayFromSums = (sums: CostSums, count: number): UsageCostDisplay => {
  if (count === 0) return { amount: 0, status: "recorded" };
  if (sums.unavailableCount > 0) return { amount: null, status: "unavailable" };
  const amount = sums.recorded + sums.estimated;
  let status: UsageCostStatus = "recorded";
  if (sums.recorded > 0 && sums.estimated > 0) status = "mixed";
  else if (sums.estimated > 0) status = "estimated";
  return { amount, status };
};

const recordCostTotal = (record: UsageRecordInput): "unavailable" | { kind: "recorded" | "estimated"; total: number } => {
  if (record.costKind === "recorded" && record.recordedCost) return { kind: "recorded", total: record.recordedCost.total };
  if (record.costKind === "estimated" && record.estimatedCost) return { kind: "estimated", total: record.estimatedCost.total };
  return "unavailable";
};

const addRecordCost = (sums: CostSums, record: UsageRecordInput): void => {
  const cost = recordCostTotal(record);
  if (cost === "unavailable") sums.unavailableCount += 1;
  else if (cost.kind === "recorded") sums.recorded += cost.total;
  else sums.estimated += cost.total;
};

const avgCostDisplay = (cost: UsageCostDisplay, requestCount: number): UsageCostDisplay =>
  cost.amount !== null && requestCount > 0
    ? { amount: cost.amount / requestCount, status: cost.status }
    : { amount: null, status: "unavailable" };

const modelKeyOf = (record: UsageRecordInput): string => `${record.provider}/${record.model}`;

function chooseBucketMs(spanMs: number): number {
  for (const bucket of BUCKET_LADDER_MS) {
    if (spanMs / bucket <= MAX_TREND_POINTS) return bucket;
  }
  return BUCKET_LADDER_MS[BUCKET_LADDER_MS.length - 1];
}

function effectiveBucketMs(fromMs: number, toMs: number, bucketMs: number): number {
  const effective = bucketMs > 0 ? bucketMs : chooseBucketMs(toMs - fromMs);
  if (toMs <= fromMs) return effective;
  const rawCount = Math.floor((toMs - fromMs) / effective) + 1;
  if (rawCount <= MAX_TREND_POINTS) return effective;
  const scale = Math.floor((toMs - fromMs) / (effective * MAX_TREND_POINTS)) + 1;
  return effective * scale;
}

const matches = (record: UsageRecordInput, options: AggregateOptions): boolean => {
  if (record.sourceKind === "summary" && !options.includeSummary) return false;
  if (!Number.isFinite(record.timestampMs)) return false;
  if (record.timestampMs < options.fromMs || record.timestampMs > options.toMs) return false;
  if (options.projects && options.projects.length > 0) {
    const normalized = options.projects.map(normalizePath);
    if (!normalized.includes(normalizePath(record.projectCwd))) return false;
  }
  if (options.modelKeys && options.modelKeys.length > 0) {
    if (!options.modelKeys.includes(modelKeyOf(record))) return false;
  }
  return true;
};

/** Dedupe by recordId, last occurrence wins — append-only writes can leave repeated ids on disk. */
export function dedupeRecords(records: readonly UsageRecordInput[]): UsageRecordInput[] {
  const byId = new Map<string, UsageRecordInput>();
  for (const record of records) byId.set(record.recordId, record);
  return [...byId.values()];
}

const trendPoint = (startMs: number, records: readonly UsageRecordInput[]): UsageTrendPoint => {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  const costSums: CostSums = { recorded: 0, estimated: 0, unavailableCount: 0 };
  for (const record of records) {
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    cacheReadTokens += record.cacheReadTokens;
    cacheWriteTokens += record.cacheWriteTokens;
    addRecordCost(costSums, record);
  }
  return {
    startMs,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    cost: costDisplayFromSums(costSums, records.length),
  };
};

function buildTrend(
  records: readonly UsageRecordInput[],
  options: AggregateOptions,
): { points: UsageTrendPoint[]; bucketMs: number } {
  if (options.fromMs > options.toMs) return { points: [], bucketMs: options.bucketMs };
  const upper = options.toMs;
  let lower = options.fromMs;
  if (lower <= 0) {
    if (records.length === 0) return { points: [], bucketMs: options.bucketMs };
    lower = Number.POSITIVE_INFINITY;
    for (const record of records) {
      if (Number.isFinite(record.timestampMs) && record.timestampMs < lower) lower = record.timestampMs;
    }
    if (!Number.isFinite(lower)) return { points: [], bucketMs: options.bucketMs };
  }
  const bucket = effectiveBucketMs(lower, upper, options.bucketMs);
  const firstStart = Math.floor(lower / bucket) * bucket;
  const lastStart = Math.floor(upper / bucket) * bucket;
  if (!Number.isFinite(firstStart) || !Number.isFinite(lastStart) || lastStart < firstStart) {
    return { points: [], bucketMs: bucket };
  }
  const count = Math.floor((lastStart - firstStart) / bucket) + 1;
  if (!Number.isFinite(count) || count <= 0 || count > MAX_TREND_POINTS * 2) {
    return { points: [], bucketMs: bucket };
  }
  const buckets = new Map<number, UsageRecordInput[]>();
  for (const record of records) {
    const start = Math.floor(record.timestampMs / bucket) * bucket;
    if (start < firstStart || start > lastStart) continue;
    const list = buckets.get(start);
    if (list) list.push(record);
    else buckets.set(start, [record]);
  }
  const points: UsageTrendPoint[] = [];
  for (let i = 0; i < count; i++) {
    const startMs = firstStart + i * bucket;
    points.push(trendPoint(startMs, buckets.get(startMs) ?? []));
  }
  return { points, bucketMs: bucket };
}

function buildByModel(records: readonly UsageRecordInput[]): UsageModelRow[] {
  const byKey = new Map<string, UsageRecordInput[]>();
  for (const record of records) {
    if (record.model === "") continue;
    const key = modelKeyOf(record);
    const list = byKey.get(key);
    if (list) list.push(record);
    else byKey.set(key, [record]);
  }
  return [...byKey.entries()]
    .map(([key, modelRecords]) => {
      let requestCount = 0;
      let totalTokens = 0;
      const costSums: CostSums = { recorded: 0, estimated: 0, unavailableCount: 0 };
      for (const record of modelRecords) {
        if (record.sourceKind === "assistant") requestCount += 1;
        totalTokens += record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens;
        addRecordCost(costSums, record);
      }
      const cost = costDisplayFromSums(costSums, modelRecords.length);
      return {
        key,
        provider: modelRecords[0].provider,
        model: modelRecords[0].model,
        requestCount,
        totalTokens,
        cost,
        avgCost: avgCostDisplay(cost, requestCount),
      };
    })
    .sort((a, b) => b.requestCount - a.requestCount || a.key.localeCompare(b.key));
}

export function aggregateUsage(
  records: readonly UsageRecordInput[],
  options: AggregateOptions,
): AggregateResult {
  const filtered = dedupeRecords(records).filter((record) => matches(record, options));

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let requestCount = 0;
  const costSums: CostSums = { recorded: 0, estimated: 0, unavailableCount: 0 };
  for (const record of filtered) {
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    cacheReadTokens += record.cacheReadTokens;
    cacheWriteTokens += record.cacheWriteTokens;
    if (record.sourceKind === "assistant") requestCount += 1;
    addRecordCost(costSums, record);
  }

  const totals: UsageTotals = {
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    requestCount,
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    cacheHitRate: isCacheHitComputable(inputTokens, cacheReadTokens, cacheWriteTokens)
      ? cacheHitRate(inputTokens, cacheReadTokens, cacheWriteTokens)
      : null,
    cost: costDisplayFromSums(costSums, filtered.length),
  };

  const trend = buildTrend(filtered, options);

  return {
    totals,
    trend: trend.points,
    byModel: buildByModel(filtered),
    recordCount: filtered.length,
    bucketMs: trend.bucketMs,
  };
}

/** Start of the local day containing `timeMs` (the "today" window is local, like the plugin's TUI). */
export function startOfLocalDay(timeMs: number): number {
  const date = new Date(timeMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Daily heatmap series: one point per local calendar day in [fromMs, toMs],
 * including empty days. Filters apply the same scope/model/summary semantics
 * as aggregateUsage; the caller passes the heatmap window as fromMs/toMs.
 * Day iteration goes through Date so DST transitions never skip or double a day.
 */
export function buildDailyUsage(
  records: readonly UsageRecordInput[],
  options: AggregateOptions,
): UsageDailyPoint[] {
  const filtered = dedupeRecords(records).filter((record) => matches(record, options));
  const byDay = new Map<number, { tokens: number; sums: CostSums; count: number }>();
  for (const record of filtered) {
    const dayStart = startOfLocalDay(record.timestampMs);
    const entry = byDay.get(dayStart);
    const tokens = record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens;
    if (entry) {
      entry.tokens += tokens;
      entry.count += 1;
      addRecordCost(entry.sums, record);
    } else {
      const sums: CostSums = { recorded: 0, estimated: 0, unavailableCount: 0 };
      addRecordCost(sums, record);
      byDay.set(dayStart, { tokens, sums, count: 1 });
    }
  }

  const points: UsageDailyPoint[] = [];
  const endDay = startOfLocalDay(options.toMs);
  const cursor = new Date(startOfLocalDay(options.fromMs));
  while (cursor.getTime() <= endDay) {
    const startMs = cursor.getTime();
    const entry = byDay.get(startMs);
    points.push({
      startMs,
      totalTokens: entry?.tokens ?? 0,
      cost: entry ? costDisplayFromSums(entry.sums, entry.count) : { amount: 0, status: "recorded" },
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return points;
}

/** Resolve the [fromMs, toMs] window for a range preset. */
export function rangeWindow(rangeId: UsageRangeId, nowMs: number, hours: number | null): { fromMs: number; toMs: number } {
  if (rangeId === "today") return { fromMs: startOfLocalDay(nowMs), toMs: nowMs };
  if (rangeId === "all" || hours === null) return { fromMs: 0, toMs: nowMs };
  return { fromMs: nowMs - hours * 3_600_000, toMs: nowMs };
}
