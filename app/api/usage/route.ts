import { NextResponse } from "next/server";
import { aggregateUsage, buildDailyUsage, rangeWindow, startOfLocalDay } from "@/lib/usage/aggregate";
import { loadUsageRecords } from "@/lib/usage/records";
import { isUsageRangeId, USAGE_RANGE_PRESETS, type UsageApiResponse } from "@/lib/usage/types";

/** Heatmap window: 53 weeks of superset days; the client aligns the grid to Sunday. */
const DAILY_WINDOW_DAYS = 371;

/**
 * GET /api/usage?range=7d&scope=project&project=<cwd>&models=p1/m1,p2/m2&includeSummary=0
 *
 * Aggregates the pi-token-usage-statistics plugin's shared records store for
 * the Usage dashboard. All aggregation is in-memory over the cached parse, so
 * polling while the dashboard is open stays cheap.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const rangeParam = params.get("range") ?? "7d";
  const preset = USAGE_RANGE_PRESETS.find((entry) => entry.id === rangeParam);
  if (!isUsageRangeId(rangeParam) || !preset) {
    return NextResponse.json({ error: `Unknown range: ${rangeParam}` }, { status: 400 });
  }

  const scope = params.get("scope") === "project" ? "project" : "global";
  const project = scope === "project" ? params.get("project") : null;
  if (scope === "project" && !project) {
    return NextResponse.json({ error: "scope=project requires a project path" }, { status: 400 });
  }

  const modelsParam = params.get("models");
  const modelKeys = modelsParam
    ? modelsParam.split(",").map((value) => value.trim()).filter((value) => value !== "")
    : [];
  const includeSummary = params.get("includeSummary") === "1";

  const loaded = await loadUsageRecords();
  if (!loaded.available) {
    const body: UsageApiResponse = { available: false, reason: "no-plugin" };
    return NextResponse.json(body);
  }

  const nowMs = Date.now();
  const { fromMs, toMs } = rangeWindow(preset.id, nowMs, preset.hours);
  const result = aggregateUsage(loaded.records, {
    fromMs,
    toMs,
    bucketMs: preset.bucketMs,
    projects: scope === "project" && project ? [project] : undefined,
    modelKeys: modelKeys.length > 0 ? modelKeys : undefined,
    includeSummary,
  });

  // The heatmap always shows the last ~year regardless of the selected range,
  // but keeps the same scope/model filters so it stays consistent with the rest.
  const dailyFromMs = startOfLocalDay(nowMs - (DAILY_WINDOW_DAYS - 1) * 86_400_000);
  const daily = buildDailyUsage(loaded.records, {
    fromMs: dailyFromMs,
    toMs: nowMs,
    bucketMs: 86_400_000,
    projects: scope === "project" && project ? [project] : undefined,
    modelKeys: modelKeys.length > 0 ? modelKeys : undefined,
    includeSummary,
  });

  const body: UsageApiResponse = {
    available: true,
    data: {
      totals: result.totals,
      trend: result.trend,
      daily,
      byModel: result.byModel,
      meta: {
        recordCount: result.recordCount,
        refreshedAtMs: nowMs,
        bucketMs: result.bucketMs,
        rangeId: preset.id,
        scope,
        project,
      },
    },
  };
  return NextResponse.json(body);
}
