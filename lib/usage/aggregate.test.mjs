import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  aggregateUsage,
  buildDailyUsage,
  cacheHitRate,
  dedupeRecords,
  rangeWindow,
  startOfLocalDay,
} = await jiti.import("./aggregate.ts");

function record(overrides = {}) {
  return {
    recordId: "r1",
    sessionId: "s1",
    projectCwd: "/proj/a",
    timestampMs: 1000,
    provider: "p",
    model: "m",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costKind: "unavailable",
    sourceKind: "assistant",
    ...overrides,
  };
}

const baseOptions = {
  fromMs: 0,
  toMs: 2000,
  bucketMs: 1000,
  includeSummary: false,
};

test("cache hit rate follows the plugin formula and is null on zero denominator", () => {
  assert.equal(cacheHitRate(0, 0, 0), null);
  assert.equal(cacheHitRate(100, 100, 0), 50);
  // cacheRead / (input + cacheRead + cacheWrite) * 100
  assert.equal(cacheHitRate(50, 50, 100), 25);
});

test("cost display mirrors the plugin policy", () => {
  // empty set is a well-defined $0
  assert.deepEqual(aggregateUsage([], baseOptions).totals.cost, { amount: 0, status: "recorded" });

  // any unavailable record makes the aggregate "--"
  const withUnavailable = aggregateUsage([record()], baseOptions);
  assert.deepEqual(withUnavailable.totals.cost, { amount: null, status: "unavailable" });

  // recorded + estimated → mixed, amount is the sum
  const mixed = aggregateUsage([
    record({ recordId: "a", costKind: "recorded", recordedCost: { total: 0.5 } }),
    record({ recordId: "b", costKind: "estimated", estimatedCost: { total: 0.25 } }),
  ], baseOptions);
  assert.deepEqual(mixed.totals.cost, { amount: 0.75, status: "mixed" });

  // estimated only → estimated
  const estimated = aggregateUsage([
    record({ recordId: "a", costKind: "estimated", estimatedCost: { total: 1 } }),
  ], baseOptions);
  assert.deepEqual(estimated.totals.cost, { amount: 1, status: "estimated" });
});

test("duplicate recordIds are deduped with last occurrence winning", () => {
  const result = aggregateUsage([
    record({ recordId: "a", inputTokens: 100 }),
    record({ recordId: "a", inputTokens: 30 }),
  ], baseOptions);
  assert.equal(result.totals.inputTokens, 30);
  assert.equal(result.recordCount, 1);
  assert.equal(dedupeRecords([{ recordId: "x" }, { recordId: "x" }]).length, 1);
});

test("summary usage contributes tokens only when included, never requests", () => {
  const records = [
    record({ recordId: "a", sourceKind: "assistant", inputTokens: 10 }),
    record({ recordId: "b", sourceKind: "summary", inputTokens: 5 }),
  ];
  const excluded = aggregateUsage(records, baseOptions);
  assert.equal(excluded.totals.inputTokens, 10);
  assert.equal(excluded.totals.requestCount, 1);
  assert.equal(excluded.recordCount, 1);

  const included = aggregateUsage(records, { ...baseOptions, includeSummary: true });
  assert.equal(included.totals.inputTokens, 15);
  assert.equal(included.totals.requestCount, 1);
  assert.equal(included.recordCount, 2);
});

test("trend buckets are epoch-aligned and empty buckets are emitted", () => {
  const result = aggregateUsage([
    record({ recordId: "a", timestampMs: 5, inputTokens: 1 }),
    record({ recordId: "b", timestampMs: 25, inputTokens: 2 }),
  ], { fromMs: 0, toMs: 25, bucketMs: 10, includeSummary: false });
  assert.deepEqual(result.trend.map((point) => point.startMs), [0, 10, 20]);
  assert.deepEqual(result.trend.map((point) => point.inputTokens), [1, 0, 2]);
  assert.equal(result.bucketMs, 10);
});

test("the all window starts at the earliest record, not the Unix epoch", () => {
  const earliest = 1_000_000_000_000;
  const result = aggregateUsage([
    record({ recordId: "a", timestampMs: earliest }),
  ], { fromMs: 0, toMs: 1_095_000_000_000, bucketMs: 0, includeSummary: false });
  // first bucket is the epoch-aligned bucket containing the earliest record
  assert.ok(result.trend[0].startMs <= earliest);
  assert.ok(earliest - result.trend[0].startMs < result.bucketMs);
  assert.ok(result.trend.length <= 481, `expected bounded points, got ${result.trend.length}`);
  // ~3-year span must land on the multi-day rungs of the ladder
  assert.ok(result.bucketMs >= 3 * 86_400_000, `auto bucket should scale up for a long span, got ${result.bucketMs}ms`);
});

test("project paths compare normalized (slashes, case, trailing slash)", () => {
  const records = [
    record({ recordId: "a", projectCwd: "/Users/z/Proj/A/" }),
    record({ recordId: "b", projectCwd: "/Users/z/proj/B" }),
  ];
  const result = aggregateUsage(records, { ...baseOptions, projects: ["/users/z/proj/a"] });
  assert.equal(result.recordCount, 1);
  assert.equal(result.totals.inputTokens, 100);
});

test("model filter matches provider/model keys", () => {
  const records = [
    record({ recordId: "a", provider: "p1", model: "m1", inputTokens: 10 }),
    record({ recordId: "b", provider: "p1", model: "m2", inputTokens: 20 }),
    record({ recordId: "c", provider: "p2", model: "m1", inputTokens: 40 }),
  ];
  const result = aggregateUsage(records, { ...baseOptions, modelKeys: ["p1/m1", "p2/m1"] });
  assert.equal(result.recordCount, 2);
  assert.equal(result.totals.inputTokens, 50);
  assert.deepEqual(result.byModel.map((row) => row.key), ["p1/m1", "p2/m1"]);
});

test("byModel sorts by requestCount desc then key asc, and avg cost divides", () => {
  const result = aggregateUsage([
    record({ recordId: "a", provider: "p", model: "z", inputTokens: 100, costKind: "recorded", recordedCost: { total: 2 } }),
    record({ recordId: "b", provider: "p", model: "a", inputTokens: 10 }),
    record({ recordId: "c", provider: "p", model: "a", inputTokens: 10 }),
  ], baseOptions);
  assert.deepEqual(result.byModel.map((row) => row.model), ["a", "z"]);
  assert.deepEqual(result.byModel[0].avgCost, { amount: null, status: "unavailable" });
  assert.deepEqual(result.byModel[1].avgCost, { amount: 2, status: "recorded" });
});

test("rangeWindow resolves today and hour offsets", () => {
  const now = Date.parse("2026-08-16T15:30:00");
  const today = rangeWindow("today", now, null);
  assert.equal(today.fromMs, Date.parse("2026-08-16T00:00:00"));
  assert.equal(today.toMs, now);

  const week = rangeWindow("7d", now, 24 * 7);
  assert.equal(week.toMs - week.fromMs, 24 * 7 * 3_600_000);

  const all = rangeWindow("all", now, null);
  assert.equal(all.fromMs, 0);
});

test("daily usage groups by local calendar day and emits empty days", () => {
  // 2026-08-14 local midnight; +6h lands on day 0, +30h lands on day 1.
  // The record() helper defaults outputTokens to 50, so totalTokens = input + 50.
  const base = startOfLocalDay(Date.parse("2026-08-14T10:00:00"));
  const daily = buildDailyUsage([
    record({ recordId: "a", timestampMs: base + 6 * 3_600_000, inputTokens: 100 }),
    record({ recordId: "b", timestampMs: base + 30 * 3_600_000, inputTokens: 50 }),
    record({ recordId: "c", timestampMs: base + 30 * 3_600_000, inputTokens: 25 }),
  ], { fromMs: base, toMs: base + 2 * 86_400_000, bucketMs: 86_400_000, includeSummary: false });

  assert.equal(daily.length, 3); // three calendar days, last one empty
  assert.equal(daily[0].totalTokens, 150); // 100 in + 50 out
  assert.equal(daily[1].totalTokens, 175); // (50+50) + (25+50)
  assert.equal(daily[2].totalTokens, 0);
  assert.deepEqual(daily[2].cost, { amount: 0, status: "recorded" });
  // every point starts at local midnight
  for (const point of daily) assert.equal(point.startMs, startOfLocalDay(point.startMs));
});

test("daily usage honors model filters", () => {
  const base = startOfLocalDay(Date.now());
  const daily = buildDailyUsage([
    record({ recordId: "a", timestampMs: base + 1000, provider: "p1", model: "m1", inputTokens: 10 }),
    record({ recordId: "b", timestampMs: base + 2000, provider: "p1", model: "m2", inputTokens: 20 }),
  ], { fromMs: base, toMs: base + 86_400_000 - 1, bucketMs: 86_400_000, modelKeys: ["p1/m2"], includeSummary: false });
  assert.equal(daily.length, 1);
  assert.equal(daily[0].totalTokens, 70); // 20 in + 50 out
});
