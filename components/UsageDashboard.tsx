"use client";

/**
 * Global usage dashboard: reads the pi-token-usage-statistics plugin's shared
 * records through /api/usage and renders totals, a stacked trend chart, a
 * per-model table, and a share donut. Opened from the sidebar's global Usage
 * button; works without any project selected (global scope).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  formatCompactTokens,
  formatCostDisplay,
  formatHitRate,
  formatRefreshedAt,
  formatTokens,
} from "@/lib/usage/format";
import {
  isUsageRangeId,
  USAGE_RANGE_PRESETS,
  type UsageDashboardData,
  type UsageModelRow,
  type UsageRangeId,
} from "@/lib/usage/types";
import { DonutChart, HEATMAP_LEVEL_COLORS, modelColor, TOKEN_SERIES, TrendChart, UsageHeatmap, type TokenSeriesKey } from "./usage-chart";

const RANGE_STORAGE_KEY = "pi-usage-range";
const SCOPE_STORAGE_KEY = "pi-usage-scope";
const AUTO_REFRESH_MS = 10_000;
const DONUT_TOP_SLICES = 7;

type UsageScope = "global" | "project";

type UsageDashboardProps = {
  onClose: () => void;
  activeCwd: string | null;
};

function restoreRange(): UsageRangeId {
  if (typeof window === "undefined") return "7d";
  const stored = window.localStorage.getItem(RANGE_STORAGE_KEY);
  return stored && isUsageRangeId(stored) ? stored : "7d";
}

function restoreScope(): UsageScope {
  if (typeof window === "undefined") return "global";
  return window.localStorage.getItem(SCOPE_STORAGE_KEY) === "project" ? "project" : "global";
}

export function UsageDashboard({ onClose, activeCwd }: UsageDashboardProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [rangeId, setRangeId] = useState<UsageRangeId>(restoreRange);
  const [scope, setScope] = useState<UsageScope>(restoreScope);
  const [selectedModelKeys, setSelectedModelKeys] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<UsageModelRow[]>([]);
  const [modelFilterOpen, setModelFilterOpen] = useState(false);
  const [data, setData] = useState<UsageDashboardData | null>(null);
  const [pluginMissing, setPluginMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [chartMode, setChartMode] = useState<"tokens" | "cost">("tokens");
  const [visibleSeries, setVisibleSeries] = useState<Set<TokenSeriesKey>>(
    () => new Set(TOKEN_SERIES.map((series) => series.key)),
  );
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);

  const modelsParam = useMemo(() => selectedModelKeys.join(","), [selectedModelKeys]);
  const effectiveScope: UsageScope = scope === "project" && !activeCwd ? "global" : scope;

  useEffect(() => {
    window.localStorage.setItem(RANGE_STORAGE_KEY, rangeId);
  }, [rangeId]);
  useEffect(() => {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, scope);
  }, [scope]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({ range: rangeId, scope: effectiveScope });
    if (effectiveScope === "project" && activeCwd) params.set("project", activeCwd);
    if (modelsParam !== "") params.set("models", modelsParam);
    fetch(`/api/usage?${params.toString()}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok || !body) throw new Error(`HTTP ${response.status}`);
        if (body.available === false) {
          setPluginMissing(true);
          setData(null);
          return;
        }
        setPluginMissing(false);
        setError(null);
        setData(body.data as UsageDashboardData);
        if (modelsParam === "") setAvailableModels((body.data as UsageDashboardData).byModel);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [rangeId, effectiveScope, activeCwd, modelsParam, refreshTick]);

  // Live updates while the dashboard is open — the plugin appends records as
  // sessions finish, and the API re-parses only when the file changed.
  useEffect(() => {
    if (pluginMissing) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setRefreshTick((tick) => tick + 1);
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [pluginMissing]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (modelFilterOpen) {
        event.stopPropagation();
        setModelFilterOpen(false);
        return;
      }
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [modelFilterOpen, onClose]);

  useEffect(() => {
    if (!modelFilterOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setModelFilterOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [modelFilterOpen]);

  const toggleSeries = useCallback((key: TokenSeriesKey) => {
    setVisibleSeries((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        if (next.size === 1) return previous;
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const toggleModel = useCallback((key: string) => {
    setSelectedModelKeys((previous) => (
      previous.includes(key) ? previous.filter((entry) => entry !== key) : [...previous, key]
    ));
  }, []);

  const totals = data?.totals ?? null;
  const meta = data?.meta ?? null;
  const noData = data !== null && data.meta.recordCount === 0;

  const donutSlices = useMemo(() => {
    const rows = data?.byModel ?? [];
    const slices = rows.slice(0, DONUT_TOP_SLICES).map((row, index) => ({
      id: row.key,
      label: row.model,
      value: row.totalTokens,
      color: modelColor(index),
    }));
    const rest = rows.slice(DONUT_TOP_SLICES).reduce((sum, row) => sum + row.totalTokens, 0);
    if (rest > 0) slices.push({ id: "__other__", label: t("usage.donut.other"), value: rest, color: "var(--text-dim)" });
    return slices;
  }, [data, t]);

  const maxModelTokens = useMemo(
    () => Math.max(1, ...(data?.byModel ?? []).map((row) => row.totalTokens)),
    [data],
  );

  const chartLabels = useMemo(() => ({
    total: t("usage.series.total"),
    input: t("usage.series.input"),
    output: t("usage.series.output"),
    cacheRead: t("usage.series.cacheRead"),
    cacheWrite: t("usage.series.cacheWrite"),
    cost: t("usage.series.cost"),
  }), [t]);

  const renderRangeControl = () => (
    <div style={{ display: "flex", gap: 2, background: "var(--bg-subtle)", borderRadius: 9, padding: 3, overflowX: "auto", flexShrink: 0 }}>
      {USAGE_RANGE_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          onClick={() => setRangeId(preset.id)}
          style={{
            border: "none",
            borderRadius: 7,
            padding: "4px 11px",
            fontSize: 12,
            whiteSpace: "nowrap",
            background: rangeId === preset.id ? "var(--bg)" : "transparent",
            color: rangeId === preset.id ? "var(--text)" : "var(--text-muted)",
            boxShadow: rangeId === preset.id ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
            cursor: "pointer",
            fontWeight: rangeId === preset.id ? 600 : 400,
            transition: "background 0.12s, color 0.12s",
          }}
        >
          {t(preset.labelKey)}
        </button>
      ))}
    </div>
  );

  const renderScopeControl = () => {
    const options: { id: UsageScope; label: string; disabled: boolean; title: string }[] = [
        { id: "global", label: t("usage.scope.global"), disabled: false, title: "" },
        { id: "project", label: t("usage.scope.project"), disabled: !activeCwd, title: !activeCwd ? t("usage.scope.projectHint") : "" },
    ];
    return (
      <div style={{ display: "flex", gap: 2, background: "var(--bg-subtle)", borderRadius: 9, padding: 3, flexShrink: 0 }}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={option.disabled}
            title={option.title || undefined}
            onClick={() => setScope(option.id)}
            style={{
              border: "none",
              borderRadius: 7,
              padding: "4px 11px",
              fontSize: 12,
              whiteSpace: "nowrap",
              background: effectiveScope === option.id ? "var(--bg)" : "transparent",
              color: effectiveScope === option.id ? "var(--text)" : option.disabled ? "var(--text-dim)" : "var(--text-muted)",
              boxShadow: effectiveScope === option.id ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
              cursor: option.disabled ? "default" : "pointer",
              fontWeight: effectiveScope === option.id ? 600 : 400,
              opacity: option.disabled ? 0.55 : 1,
              transition: "background 0.12s, color 0.12s",
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  };

  const renderModelFilter = () => {
    const selectionCount = selectedModelKeys.length;
    const label = selectionCount === 0
      ? t("usage.models.all")
      : selectionCount === 1
        ? t("usage.models.selectedOne")
        : t("usage.models.selected", { count: String(selectionCount) });
    return (
      <div ref={modelDropdownRef} style={{ position: "relative", flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => setModelFilterOpen((open) => !open)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            border: "1px solid var(--border)",
            borderRadius: 9,
            padding: "5px 11px",
            fontSize: 12,
            background: modelFilterOpen || selectionCount > 0 ? "var(--bg-subtle)" : "var(--bg)",
            color: selectionCount > 0 ? "var(--text)" : "var(--text-muted)",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
          {label}
        </button>
        {modelFilterOpen && (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              right: 0,
              width: 300,
              maxHeight: 320,
              overflowY: "auto",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              boxShadow: "0 10px 36px rgba(0,0,0,0.22)",
              padding: 6,
              zIndex: 20,
            }}
          >
            <div style={{ padding: "6px 9px 4px", fontSize: 10.5, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4 }}>
              {t("usage.models.title")}
            </div>
            {availableModels.length === 0 && (
              <div style={{ padding: "10px 9px", fontSize: 12, color: "var(--text-dim)" }}>--</div>
            )}
            {availableModels.map((row, index) => {
              const checked = selectedModelKeys.includes(row.key);
              return (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => toggleModel(row.key)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    border: "none",
                    background: "none",
                    padding: "6px 9px",
                    borderRadius: 8,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                  onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = "none"; }}
                >
                  <span style={{ width: 13, height: 13, borderRadius: 4, border: `1.5px solid ${modelColor(index)}`, background: checked ? modelColor(index) : "transparent", flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    {checked && (
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.model}</span>
                    <span style={{ display: "block", fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.provider}</span>
                  </span>
                  <span style={{ fontSize: 10.5, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                    {formatCompactTokens(row.totalTokens)}
                  </span>
                </button>
              );
            })}
            {selectionCount > 0 && (
              <button
                type="button"
                onClick={() => setSelectedModelKeys([])}
                style={{
                  width: "100%",
                  border: "none",
                  borderTop: "1px solid var(--border)",
                  background: "none",
                  padding: "8px 9px",
                  fontSize: 12,
                  color: "var(--accent)",
                  cursor: "pointer",
                  textAlign: "center",
                  marginTop: 3,
                }}
              >
                {t("usage.models.clear")}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderCostChip = (status: string) => {
    const colors: Record<string, { color: string; background: string }> = {
      recorded: { color: "#059669", background: "rgba(16,185,129,0.12)" },
      estimated: { color: "#b45309", background: "rgba(245,158,11,0.14)" },
      mixed: { color: "#7c3aed", background: "rgba(168,85,247,0.12)" },
      unavailable: { color: "var(--text-dim)", background: "var(--bg-subtle)" },
    };
    const palette = colors[status] ?? colors.unavailable;
    return (
      <span style={{
        fontSize: 9.5,
        fontWeight: 600,
        padding: "1.5px 7px",
        borderRadius: 99,
        color: palette.color,
        background: palette.background,
        whiteSpace: "nowrap",
      }}>
        {t(`usage.cost.${status}`)}
      </span>
    );
  };

  const renderTokenProportionBar = () => {
    if (!totals || totals.totalTokens === 0) return null;
    const parts = [
      { key: "input", value: totals.inputTokens, color: TOKEN_SERIES[0].color },
      { key: "output", value: totals.outputTokens, color: TOKEN_SERIES[1].color },
      { key: "cacheRead", value: totals.cacheReadTokens, color: TOKEN_SERIES[2].color },
      { key: "cacheWrite", value: totals.cacheWriteTokens, color: TOKEN_SERIES[3].color },
    ].filter((part) => part.value > 0);
    return (
      <div style={{ display: "flex", height: 5, borderRadius: 99, overflow: "hidden", marginTop: 8, background: "var(--bg-subtle)" }}>
        {parts.map((part) => (
          <span key={part.key} style={{ width: `${(part.value / totals.totalTokens) * 100}%`, minWidth: 2, background: part.color }} />
        ))}
      </div>
    );
  };

  const kpiCardStyle: React.CSSProperties = {
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "12px 14px",
    minWidth: 0,
  };
  const kpiLabelStyle: React.CSSProperties = { fontSize: 11, color: "var(--text-muted)", marginBottom: 5, whiteSpace: "nowrap" };
  const kpiValueStyle: React.CSSProperties = { fontSize: 21, fontWeight: 700, color: "var(--text)", fontVariantNumeric: "tabular-nums", lineHeight: 1.15 };

  const renderKpis = () => {
    if (!totals) return null;
    return (
      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${isMobile ? 130 : 158}px, 1fr))`, gap: 10 }}>
        <div style={kpiCardStyle}>
          <div style={{ ...kpiLabelStyle, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
            <span>{t("usage.kpi.totalCost")}</span>
            {renderCostChip(totals.cost.status)}
          </div>
          <div style={{ ...kpiValueStyle, color: totals.cost.amount === null ? "var(--text-dim)" : "var(--text)" }}>
            {formatCostDisplay(totals.cost)}
          </div>
        </div>
        <div style={kpiCardStyle}>
          <div style={kpiLabelStyle}>{t("usage.kpi.totalTokens")}</div>
          <div style={kpiValueStyle}>{formatCompactTokens(totals.totalTokens)}</div>
          {renderTokenProportionBar()}
        </div>
        <div style={kpiCardStyle}>
          <div style={kpiLabelStyle}>{t("usage.kpi.requests")}</div>
          <div style={kpiValueStyle}>{formatTokens(totals.requestCount)}</div>
        </div>
        <div style={kpiCardStyle}>
          <div style={kpiLabelStyle}>{t("usage.kpi.cacheHitRate")}</div>
          <div style={{ ...kpiValueStyle, color: totals.cacheHitRate === null ? "var(--text-dim)" : "var(--text)" }}>
            {formatHitRate(totals.cacheHitRate)}
          </div>
        </div>
        <div style={kpiCardStyle}>
          <div style={{ ...kpiLabelStyle, display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: TOKEN_SERIES[0].color }} />
            {t("usage.kpi.input")}
          </div>
          <div style={kpiValueStyle}>{formatCompactTokens(totals.inputTokens)}</div>
        </div>
        <div style={kpiCardStyle}>
          <div style={{ ...kpiLabelStyle, display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: TOKEN_SERIES[1].color }} />
            {t("usage.kpi.output")}
          </div>
          <div style={kpiValueStyle}>{formatCompactTokens(totals.outputTokens)}</div>
        </div>
      </div>
    );
  };

  const renderHeatmapCard = () => (
    <section style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t("usage.heatmap.title")}</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "var(--text-dim)" }}>
          <span>{t("usage.heatmap.less")}</span>
          {HEATMAP_LEVEL_COLORS.map((color) => (
            <span key={color} style={{ width: 10, height: 10, borderRadius: 2.5, background: color }} />
          ))}
          <span>{t("usage.heatmap.more")}</span>
        </div>
      </div>
      <UsageHeatmap days={data?.daily ?? []} />
    </section>
  );

  const renderTrendCard = () => (
    <section style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px 8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t("usage.trend.title")}</span>
        <div style={{ display: "flex", gap: 2, background: "var(--bg-subtle)", borderRadius: 8, padding: 2.5 }}>
          {(["tokens", "cost"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setChartMode(mode)}
              style={{
                border: "none",
                borderRadius: 6,
                padding: "2.5px 9px",
                fontSize: 11,
                background: chartMode === mode ? "var(--bg)" : "transparent",
                color: chartMode === mode ? "var(--text)" : "var(--text-muted)",
                fontWeight: chartMode === mode ? 600 : 400,
                cursor: "pointer",
                boxShadow: chartMode === mode ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
              }}
            >
              {t(`usage.chart.${mode}`)}
            </button>
          ))}
        </div>
        {chartMode === "tokens" && (
          <div style={{ display: "flex", gap: 4, marginLeft: "auto", flexWrap: "wrap" }}>
            {TOKEN_SERIES.map((series) => {
              const active = visibleSeries.has(series.key);
              const labelKey = {
                inputTokens: "usage.series.input",
                outputTokens: "usage.series.output",
                cacheReadTokens: "usage.series.cacheRead",
                cacheWriteTokens: "usage.series.cacheWrite",
              }[series.key];
              return (
                <button
                  key={series.key}
                  type="button"
                  onClick={() => toggleSeries(series.key)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    border: "none",
                    background: "none",
                    padding: "3px 8px",
                    borderRadius: 99,
                    fontSize: 11,
                    color: active ? "var(--text)" : "var(--text-dim)",
                    cursor: "pointer",
                    opacity: active ? 1 : 0.55,
                    transition: "opacity 0.12s",
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: series.color, opacity: active ? 1 : 0.4 }} />
                  {t(labelKey)}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {data && (
        <TrendChart
          points={data.trend}
          mode={chartMode}
          visibleSeries={visibleSeries}
          rangeId={rangeId}
          labels={chartLabels}
          height={isMobile ? 200 : 250}
        />
      )}
    </section>
  );

  const renderModelTable = () => (
    <section style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px", minWidth: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>{t("usage.byModel.title")}</div>
      <div style={{ overflowY: "auto", minHeight: 0, flex: 1 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: "var(--text-dim)", fontSize: 10.5, textAlign: "right" }}>
              <th style={{ fontWeight: 500, textAlign: "left", padding: "4px 6px", position: "sticky", top: 0, background: "var(--bg)" }}>{t("usage.byModel.model")}</th>
              <th style={{ fontWeight: 500, padding: "4px 6px", position: "sticky", top: 0, background: "var(--bg)" }}>{t("usage.byModel.requests")}</th>
              <th style={{ fontWeight: 500, padding: "4px 6px", position: "sticky", top: 0, background: "var(--bg)" }}>{t("usage.byModel.tokens")}</th>
              <th style={{ fontWeight: 500, padding: "4px 6px", position: "sticky", top: 0, background: "var(--bg)" }}>{t("usage.byModel.cost")}</th>
              <th style={{ fontWeight: 500, padding: "4px 6px", position: "sticky", top: 0, background: "var(--bg)" }}>{t("usage.byModel.avgCost")}</th>
            </tr>
          </thead>
          <tbody>
            {(data?.byModel ?? []).map((row, index) => (
              <tr key={row.key} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "7px 6px", maxWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 12, color: "var(--text)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.model}</span>
                  <span style={{ display: "block", fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.provider}</span>
                </td>
                <td style={{ padding: "7px 6px", textAlign: "right", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                  {formatTokens(row.requestCount)}
                </td>
                <td style={{ padding: "7px 6px", textAlign: "right", whiteSpace: "nowrap" }}>
                  <span style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{formatCompactTokens(row.totalTokens)}</span>
                  <span style={{ display: "block", height: 3, borderRadius: 99, background: "var(--bg-subtle)", marginTop: 4, overflow: "hidden" }}>
                    <span style={{ display: "block", height: "100%", width: `${(row.totalTokens / maxModelTokens) * 100}%`, background: modelColor(index), borderRadius: 99 }} />
                  </span>
                </td>
                <td style={{
                  padding: "7px 6px",
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                  color: row.cost.amount === null ? "var(--text-dim)" : "var(--text)",
                }}>
                  {formatCostDisplay(row.cost)}
                </td>
                <td style={{
                  padding: "7px 6px",
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                  color: row.avgCost.amount === null ? "var(--text-dim)" : "var(--text-muted)",
                }}>
                  {formatCostDisplay(row.avgCost)}
                </td>
              </tr>
            ))}
            {(data?.byModel ?? []).length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: "18px 6px", textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>--</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );

  const renderDonutCard = () => {
    const totalTokens = donutSlices.reduce((sum, slice) => sum + slice.value, 0);
    // 同一模型名可能来自多个 provider（id 是 `${provider}/${model}`），重复时附上 provider 以便区分
    const nameCounts = new Map<string, number>();
    for (const slice of donutSlices) nameCounts.set(slice.label, (nameCounts.get(slice.label) ?? 0) + 1);
    const legendLabel = (slice: { id: string; label: string }): string => {
      if (slice.id === "__other__" || (nameCounts.get(slice.label) ?? 0) <= 1) return slice.label;
      return `${slice.label} · ${slice.id.split("/")[0]}`;
    };
    return (
      <section style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px", flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>{t("usage.donut.title")}</div>
        <div style={{ display: "flex", flexDirection: isMobile ? "column" : "column", alignItems: "center", gap: 12 }}>
          <DonutChart
            slices={donutSlices}
            size={isMobile ? 170 : 185}
            thickness={21}
            centerValue={formatCompactTokens(totalTokens)}
            centerLabel={t("usage.series.total")}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 5, width: "100%", minWidth: 0 }}>
            {donutSlices.map((slice) => {
              const share = totalTokens > 0 ? (slice.value / totalTokens) * 100 : 0;
              return (
                <div key={slice.id} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11.5, minWidth: 0 }}>
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: slice.color, flexShrink: 0 }} />
                  <span style={{ color: "var(--text-muted)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{legendLabel(slice)}</span>
                  <span style={{ color: "var(--text-dim)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{share.toFixed(1)}%</span>
                  <span style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums", flexShrink: 0, width: 52, textAlign: "right" }}>{formatCompactTokens(slice.value)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    );
  };

  const renderNoPlugin = () => (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 32, textAlign: "center" }}>
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
        <line x1="18" y1="20" x2="18" y2="12" /><line x1="12" y1="20" x2="12" y2="5" /><line x1="6" y1="20" x2="6" y2="15" />
      </svg>
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{t("usage.empty.noPlugin.title")}</div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", maxWidth: 430, lineHeight: 1.6 }}>{t("usage.empty.noPlugin.body")}</div>
      <code style={{
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "7px 13px",
        color: "var(--text)",
      }}>
        pi install npm:pi-token-usage-statistics
      </code>
    </div>
  );

  const renderNoData = () => (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 32, textAlign: "center" }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("usage.empty.noData.title")}</div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{t("usage.empty.noData.body")}</div>
      <button
        type="button"
        onClick={() => setRangeId("all")}
        style={{
          border: "1px solid var(--border)",
          background: "var(--bg)",
          color: "var(--text)",
          borderRadius: 8,
          padding: "6px 14px",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        {t("usage.empty.noData.action")}
      </button>
    </div>
  );

  const renderError = () => (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 32 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "#dc2626" }}>{t("usage.error.title")}</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{error}</div>
      <button
        type="button"
        onClick={() => setRefreshTick((tick) => tick + 1)}
        style={{
          border: "1px solid var(--border)",
          background: "var(--bg)",
          color: "var(--text)",
          borderRadius: 8,
          padding: "6px 14px",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        {t("usage.error.retry")}
      </button>
    </div>
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.42)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: isMobile ? "calc(100vw - 16px)" : "min(1160px, calc(100vw - 48px))",
          maxWidth: "100vw",
          height: isMobile ? "calc(100dvh - 16px)" : "min(820px, calc(100dvh - 48px))",
          maxHeight: "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: isMobile ? 12 : 14,
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 12px 48px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "13px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <span style={{
            width: 30, height: 30, borderRadius: 9, flexShrink: 0,
            background: "linear-gradient(135deg, #3b82f6, #a855f7)",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="20" x2="18" y2="11" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
            </svg>
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--text)" }}>{t("usage.title")}</div>
            {meta && (
              <div style={{ fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {t("usage.records", { count: String(meta.recordCount), time: formatRefreshedAt(meta.refreshedAtMs) })}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setRefreshTick((tick) => tick + 1)}
            title={t("usage.refresh")}
            aria-label={t("usage.refresh")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 30, height: 30, borderRadius: 8, padding: 0,
              background: "none", border: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0,
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={loading ? "animate-spin" : undefined}
              aria-hidden="true"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t("common.ok")}
            aria-label={t("common.ok")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 30, height: 30, borderRadius: 8, padding: 0,
              background: "none", border: "1px solid transparent",
              color: "var(--text-muted)", cursor: "pointer", fontSize: 17, lineHeight: 1, flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* Controls */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          padding: "10px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0,
        }}>
          {renderRangeControl()}
          {renderScopeControl()}
          <div style={{ marginLeft: "auto" }}>{renderModelFilter()}</div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {error && renderError()}
          {!error && pluginMissing && renderNoPlugin()}
          {!error && !pluginMissing && data === null && (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg className="animate-spin" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="var(--text-dim)" strokeWidth="2" opacity="0.25" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
          )}
          {!error && !pluginMissing && noData && renderNoData()}
          {!error && !pluginMissing && !noData && data !== null && (
            <>
              {renderKpis()}
              {renderHeatmapCard()}
              {renderTrendCard()}
              <div style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 3fr) minmax(0, 2fr)",
                gap: 10,
                flex: 1,
                minHeight: 0,
              }}>
                {renderModelTable()}
                {renderDonutCard()}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
          padding: "7px 18px", borderTop: "1px solid var(--border)", flexShrink: 0,
          fontSize: 10.5, color: "var(--text-dim)",
        }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("usage.footer.source", { path: "~/.pi/agent/token-usage-statistics/records.jsonl" })}
          </span>
          <span style={{ flexShrink: 0 }}>pi-token-usage-statistics</span>
        </div>
      </div>
    </div>
  );
}
