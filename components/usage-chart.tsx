"use client";

/**
 * Hand-rolled SVG charts for the Usage dashboard: a stacked-area trend chart
 * (tokens) / area chart (cost) with hover crosshair + tooltip, and a donut for
 * per-model share. No chart library — keeps the bundle light and lets every
 * pixel follow the app's CSS-variable theming.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatBucketFull,
  formatBucketLabel,
  formatCompactTokens,
  formatCost,
  formatDayLabel,
  formatMonthLabel,
  formatWeekdayLabel,
} from "@/lib/usage/format";
import {
  USAGE_MODEL_PALETTE,
  USAGE_SERIES_COLORS,
  type UsageDailyPoint,
  type UsageRangeId,
  type UsageTrendPoint,
} from "@/lib/usage/types";

export function modelColor(index: number): string {
  return USAGE_MODEL_PALETTE[index % USAGE_MODEL_PALETTE.length];
}

/** Track an element's content width via ResizeObserver (chart is drawn at real pixels, viewBox would distort text). */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth((prev) => (Math.abs(prev - next) > 0.5 ? next : prev));
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export type TokenSeriesKey = "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens";

export const TOKEN_SERIES: { key: TokenSeriesKey; color: string }[] = [
  { key: "inputTokens", color: USAGE_SERIES_COLORS.input },
  { key: "outputTokens", color: USAGE_SERIES_COLORS.output },
  { key: "cacheReadTokens", color: USAGE_SERIES_COLORS.cacheRead },
  { key: "cacheWriteTokens", color: USAGE_SERIES_COLORS.cacheWrite },
];

/** Visual stack order bottom → top. */
const STACK_ORDER: TokenSeriesKey[] = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

const niceCeil = (value: number): number => {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const frac = value / 10 ** exp;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return nice * 10 ** exp;
};

const formatAxisTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  return String(value);
};

const formatAxisCost = (value: number): string => {
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  if (value >= 1) return `$${value.toFixed(value % 1 === 0 ? 0 : 1)}`;
  if (value === 0) return "$0";
  return `$${value.toFixed(2)}`;
};

export type TrendChartLabels = {
  total: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  cost: string;
};

type TrendChartProps = {
  points: UsageTrendPoint[];
  mode: "tokens" | "cost";
  visibleSeries: Set<TokenSeriesKey>;
  rangeId: UsageRangeId;
  labels: TrendChartLabels;
  height?: number;
};

type HoverState = {
  index: number;
  px: number;
} | null;

export function TrendChart({ points, mode, visibleSeries, rangeId, labels, height = 250 }: TrendChartProps) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<HoverState>(null);

const padL = 46;
const padR = 10;
const padT = 12;
const padB = 24;
/** How far the pointer-capture surface extends beyond the plot area on each side. */
const CAPTURE_BLEED = 6;
  const innerW = Math.max(0, width - padL - padR);
  const innerH = Math.max(0, height - padT - padB);

  const seriesLabel = (key: TokenSeriesKey): string => {
    switch (key) {
      case "inputTokens": return labels.input;
      case "outputTokens": return labels.output;
      case "cacheReadTokens": return labels.cacheRead;
      case "cacheWriteTokens": return labels.cacheWrite;
    }
  };

  const { x, yFor, maxY, visibleOrder } = useMemo(() => {
    const count = points.length;
    const order = STACK_ORDER.filter((key) => visibleSeries.has(key));
    let peak = 0;
    if (mode === "cost") {
      for (const point of points) peak = Math.max(peak, point.cost.amount ?? 0);
    } else {
      for (const point of points) {
        let cumulative = 0;
        for (const key of order) {
          cumulative += point[key];
          peak = Math.max(peak, cumulative);
        }
      }
    }
    const top = niceCeil(peak);
    const xAt = (index: number) => padL + (count <= 1 ? innerW / 2 : (index / (count - 1)) * innerW);
    const yAt = (value: number) => padT + innerH - (value / top) * innerH;
    return { x: xAt, yFor: yAt, maxY: top, visibleOrder: order };
  }, [points, mode, visibleSeries, innerW, innerH]);

  const stacks = useMemo(() => {
    if (mode !== "tokens") return [];
    // cumulative[value][seriesIndex]
    const cumulative: number[][] = [];
    for (const point of points) {
      const levels: number[] = [];
      let running = 0;
      for (const key of visibleOrder) {
        running += point[key];
        levels.push(running);
      }
      cumulative.push(levels);
    }
    return cumulative;
  }, [mode, points, visibleOrder]);

  const areaPath = (seriesIndex: number): string => {
    const count = points.length;
    if (count === 0) return "";
    const baseAt = (index: number) => (seriesIndex === 0 ? 0 : stacks[index][seriesIndex - 1]);
    const topAt = (index: number) => stacks[index][seriesIndex];
    let path = `M ${x(0)} ${yFor(baseAt(0))}`;
    for (let i = 1; i < count; i++) path += ` L ${x(i)} ${yFor(baseAt(i))}`;
    for (let i = count - 1; i >= 0; i--) path += ` L ${x(i)} ${yFor(topAt(i))}`;
    return `${path} Z`;
  };

  const costPath = useMemo(() => {
    if (mode !== "cost" || points.length === 0) return { line: "", area: "" };
    const valueAt = (index: number) => points[index].cost.amount ?? 0;
    let line = `M ${x(0)} ${yFor(valueAt(0))}`;
    for (let i = 1; i < points.length; i++) line += ` L ${x(i)} ${yFor(valueAt(i))}`;
    const area = `${line} L ${x(points.length - 1)} ${padT + innerH} L ${x(0)} ${padT + innerH} Z`;
    return { line, area };
  }, [mode, points, x, yFor, innerH]);

  const xTicks = useMemo(() => {
    const count = points.length;
    if (count === 0) return [];
    const stride = Math.max(1, Math.ceil(count / 6));
    const ticks: number[] = [];
    for (let i = 0; i < count; i += stride) ticks.push(i);
    if (ticks[ticks.length - 1] !== count - 1) ticks.push(count - 1);
    return ticks;
  }, [points]);

  const yTicks = [0, 0.25, 0.5, 0.75, 1];

  const handlePointerMove = (event: React.PointerEvent<SVGRectElement>) => {
    if (points.length === 0) return;
    // The capture rect starts CAPTURE_BLEED left of the plot area; account for
    // it so the crosshair lands exactly under the cursor (snapped to a point).
    const rect = event.currentTarget.getBoundingClientRect();
    const intoPlot = event.clientX - rect.left - CAPTURE_BLEED;
    const count = points.length;
    const index = count <= 1
      ? 0
      : Math.round((intoPlot / Math.max(1, innerW)) * (count - 1));
    const clamped = Math.max(0, Math.min(count - 1, index));
    setHover({ index: clamped, px: x(clamped) });
  };

  const clearHover = () => {
    setHover(null);
  };

  const hovered = hover ? points[hover.index] : null;
  const tooltipFlip = hover !== null && hover.px > (width * 2) / 3;

  const renderTooltip = (): React.ReactNode => {
    if (!hover || !hovered) return null;
    const rows = mode === "cost"
      ? [{ color: USAGE_SERIES_COLORS.cost, label: labels.cost, value: formatCost(hovered.cost.amount) }]
      : visibleOrder.map((key) => ({
        color: TOKEN_SERIES.find((series) => series.key === key)!.color,
        label: seriesLabel(key),
        value: formatCompactTokens(hovered[key] as number),
      }));
    const extraRows = mode === "cost"
      ? [{ color: "transparent", label: labels.total, value: formatCompactTokens(hovered.totalTokens) }]
      : [{ color: "transparent", label: labels.cost, value: formatCost(hovered.cost.amount) }];
    return (
      <div
        style={{
          position: "absolute",
          top: 8,
          left: hover.px,
          transform: tooltipFlip ? "translateX(calc(-100% - 14px))" : "translateX(14px)",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 6px 24px rgba(0,0,0,0.16)",
          padding: "8px 11px",
          pointerEvents: "none",
          minWidth: 148,
          zIndex: 2,
        }}
      >
        <div style={{ fontSize: 10.5, color: "var(--text-muted)", marginBottom: 5, whiteSpace: "nowrap" }}>
          {formatBucketFull(hovered.startMs)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--text)", flexShrink: 0 }} />
            <span style={{ color: "var(--text-muted)", flex: 1 }}>{labels.total}</span>
            <span style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
              {formatCompactTokens(hovered.totalTokens)}
            </span>
          </div>
          {rows.map((row) => (
            <div key={row.label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: row.color, flexShrink: 0 }} />
              <span style={{ color: "var(--text-muted)", flex: 1 }}>{row.label}</span>
              <span style={{ color: "var(--text)", fontVariantNumeric: "tabular-nums" }}>{row.value}</span>
            </div>
          ))}
          {extraRows.map((row) => (
            <div key={row.label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
              <span style={{ width: 7, height: 7, flexShrink: 0 }} />
              <span style={{ color: "var(--text-dim)", flex: 1 }}>{row.label}</span>
              <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{row.value}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const hasData = points.length > 0 && (mode === "cost"
    ? points.some((point) => (point.cost.amount ?? 0) > 0)
    : points.some((point) => point.totalTokens > 0));

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%", height }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          style={{ display: "block" }}
          onPointerLeave={clearHover}
        >
          <defs>
            <linearGradient id="usage-cost-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={USAGE_SERIES_COLORS.cost} stopOpacity={0.28} />
              <stop offset="100%" stopColor={USAGE_SERIES_COLORS.cost} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          {/* gridlines + y labels */}
          {yTicks.map((tick) => {
            const value = maxY * tick;
            const y = yFor(value);
            return (
              <g key={tick}>
                <line x1={padL} x2={width - padR} y1={y} y2={y} stroke="var(--border)" strokeWidth={1} />
                <text x={padL - 8} y={y + 3.5} textAnchor="end" fontSize={10.5} fill="var(--text-dim)" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {mode === "cost" ? formatAxisCost(value) : formatAxisTokens(value)}
                </text>
              </g>
            );
          })}
          {/* x labels */}
          {xTicks.map((index) => (
            <text
              key={index}
              x={x(index)}
              y={height - 7}
              textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
              fontSize={10.5}
              fill="var(--text-dim)"
            >
              {formatBucketLabel(points[index].startMs, rangeId)}
            </text>
          ))}
          {/* series */}
          {mode === "tokens"
            ? visibleOrder.map((key, seriesIndex) => {
              const color = TOKEN_SERIES.find((series) => series.key === key)!.color;
              return (
                <g key={key}>
                  <path d={areaPath(seriesIndex)} fill={color} fillOpacity={0.5} />
                  <path
                    d={topEdgePath(seriesIndex)}
                    fill="none"
                    stroke={color}
                    strokeWidth={1.6}
                    strokeLinejoin="round"
                  />
                </g>
              );
            })
            : (
              <g>
                <path d={costPath.area} fill="url(#usage-cost-area)" />
                <path d={costPath.line} fill="none" stroke={USAGE_SERIES_COLORS.cost} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            )}
          {/* hover crosshair */}
          {hover && (
            <g pointerEvents="none">
              <line x1={hover.px} x2={hover.px} y1={padT} y2={padT + innerH} stroke="var(--text-dim)" strokeWidth={1} strokeDasharray="3 3" />
              {mode === "cost"
                ? (
                  <circle cx={hover.px} cy={yFor(points[hover.index].cost.amount ?? 0)} r={3.5} fill={USAGE_SERIES_COLORS.cost} stroke="var(--bg)" strokeWidth={1.5} />
                )
                : visibleOrder.map((key, seriesIndex) => {
                  if (stacks.length === 0) return null;
                  const value = stacks[hover.index][seriesIndex];
                  const color = TOKEN_SERIES.find((series) => series.key === key)!.color;
                  return (
                    <circle key={key} cx={hover.px} cy={yFor(value)} r={3} fill={color} stroke="var(--bg)" strokeWidth={1.5} />
                  );
                })}
            </g>
          )}
          {/* pointer capture surface */}
          <rect
            x={padL - CAPTURE_BLEED}
            y={padT}
            width={Math.max(0, innerW + CAPTURE_BLEED * 2)}
            height={innerH}
            fill="transparent"
            onPointerMove={handlePointerMove}
            onPointerDown={handlePointerMove}
            style={{ touchAction: "pan-y" }}
          />
        </svg>
      )}
      {renderTooltip()}
      {!hasData && width > 0 && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12, pointerEvents: "none" }}>
          —
        </div>
      )}
    </div>
  );

  function topEdgePath(seriesIndex: number): string {
    const count = points.length;
    if (count === 0) return "";
    let path = `M ${x(0)} ${yFor(stacks[0][seriesIndex])}`;
    for (let i = 1; i < count; i++) path += ` L ${x(i)} ${yFor(stacks[i][seriesIndex])}`;
    return path;
  }
}

// ── Donut ─────────────────────────────────────────────────────────────────────

export type DonutSlice = {
  /** Unique React key — model name alone can repeat across providers. */
  id: string;
  label: string;
  value: number;
  color: string;
};

type DonutChartProps = {
  slices: DonutSlice[];
  size?: number;
  thickness?: number;
  centerValue: string;
  centerLabel: string;
};

const TAU = Math.PI * 2;

function annularSectorPath(cx: number, cy: number, outerR: number, innerR: number, startAngle: number, endAngle: number): string {
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const oxS = cx + outerR * Math.cos(startAngle);
  const oyS = cy + outerR * Math.sin(startAngle);
  const oxE = cx + outerR * Math.cos(endAngle);
  const oyE = cy + outerR * Math.sin(endAngle);
  const ixS = cx + innerR * Math.cos(startAngle);
  const iyS = cy + innerR * Math.sin(startAngle);
  const ixE = cx + innerR * Math.cos(endAngle);
  const iyE = cy + innerR * Math.sin(endAngle);
  return [
    `M ${ixS} ${iyS}`,
    `L ${oxS} ${oyS}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${oxE} ${oyE}`,
    `L ${ixE} ${iyE}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${ixS} ${iyS}`,
    "Z",
  ].join(" ");
}

export function DonutChart({ slices, size = 190, thickness = 22, centerValue, centerLabel }: DonutChartProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size / 2 - 2;
  const innerR = outerR - thickness;
  const padAngle = slices.length > 1 ? 0.022 : 0;

  const arcs = useMemo(() => {
    if (total <= 0) return [];
    let angle = -Math.PI / 2;
    return slices.map((slice) => {
      const sweep = (slice.value / total) * TAU;
      const start = angle + padAngle / 2;
      const end = angle + sweep - padAngle / 2;
      angle += sweep;
      return { slice, start, end: Math.max(end, start + 0.001) };
    });
  }, [slices, total, padAngle]);

  const center = hovered !== null && slices[hovered]
    ? { value: formatCompactTokens(slices[hovered].value), label: slices[hovered].label }
    : { value: centerValue, label: centerLabel };

  return (
    <svg width={size} height={size} style={{ display: "block" }}>
      {total <= 0 && (
        <circle cx={cx} cy={cy} r={(outerR + innerR) / 2} fill="none" stroke="var(--border)" strokeWidth={thickness} />
      )}
      {arcs.map((arc, index) => (
        <path
          key={arc.slice.id}
          d={annularSectorPath(cx, cy, outerR, innerR, arc.start, arc.end)}
          fill={arc.slice.color}
          opacity={hovered === null || hovered === index ? 1 : 0.28}
          onPointerEnter={() => setHovered(index)}
          onPointerLeave={() => setHovered((current) => (current === index ? null : current))}
          style={{ cursor: "default", transition: "opacity 0.15s" }}
        />
      ))}
      <text x={cx} y={cy - 5} textAnchor="middle" fontSize={19} fontWeight={700} fill="var(--text)" style={{ fontVariantNumeric: "tabular-nums" }}>
        {center.value}
      </text>
      <text x={cx} y={cy + 13} textAnchor="middle" fontSize={10.5} fill="var(--text-dim)">
        {center.label.length > 22 ? `${center.label.slice(0, 21)}…` : center.label}
      </text>
    </svg>
  );
}

// ── Daily heatmap (GitHub-contribution style) ────────────────────────────────

const HEATMAP_GAP = 3;
const HEATMAP_LABEL_WIDTH = 28;
const HEATMAP_MONTH_ROW_HEIGHT = 18;
/** Cell size bounds: fill the card width when possible, scroll below the minimum. */
const HEATMAP_CELL_MIN = 9;
const HEATMAP_CELL_MAX = 18;

/** Level 0 = no usage, 1-4 = quartiles of active days (GitHub's green-square semantics, in blue). */
export const HEATMAP_LEVEL_COLORS = [
  "var(--bg-subtle)",
  "rgba(59,130,246,0.35)",
  "rgba(59,130,246,0.55)",
  "rgba(59,130,246,0.78)",
  "rgb(37,99,235)",
] as const;

type HeatmapHover = { col: number; row: number; point: UsageDailyPoint } | null;

export function UsageHeatmap({ days }: { days: UsageDailyPoint[] }) {
  const [hover, setHover] = useState<HeatmapHover>(null);
  const [containerRef, containerWidth] = useElementWidth<HTMLDivElement>();
  // Stable hook seed (0 when empty — the component renders nothing then)
  const seedStartMs = days.length > 0 ? days[0].startMs : 0;

  const byStart = useMemo(() => new Map(days.map((day) => [day.startMs, day])), [days]);

  // Columns are full Sun→Sat weeks; leading pad cells before the data window
  // stay empty (rendered invisibly) so the grid always aligns like GitHub's.
  const columns = useMemo(() => {
    if (days.length === 0) return [] as (UsageDailyPoint | null)[][];
    const leadDays = new Date(days[0].startMs).getDay();
    const cursor = new Date(days[0].startMs);
    cursor.setDate(cursor.getDate() - leadDays);
    const totalCells = leadDays + days.length;
    const cols: (UsageDailyPoint | null)[][] = [];
    for (let col = 0; col * 7 < totalCells; col++) {
      const week: (UsageDailyPoint | null)[] = [];
      for (let row = 0; row < 7; row++) {
        const startMs = cursor.getTime();
        week.push(byStart.get(startMs) ?? null);
        cursor.setDate(cursor.getDate() + 1);
      }
      cols.push(week);
    }
    return cols;
  }, [days, byStart]);

  // Quartile thresholds among active days so a few heavy days don't wash out the map.
  const thresholds = useMemo(() => {
    const active = days.filter((day) => day.totalTokens > 0).map((day) => day.totalTokens).sort((a, b) => a - b);
    if (active.length === 0) return null;
    const at = (p: number) => active[Math.min(active.length - 1, Math.floor(p * active.length))];
    return [at(0.25), at(0.5), at(0.75)];
  }, [days]);

  const levelOf = (tokens: number): number => {
    if (tokens <= 0) return 0;
    if (!thresholds) return 4;
    if (tokens <= thresholds[0]) return 1;
    if (tokens <= thresholds[1]) return 2;
    if (tokens <= thresholds[2]) return 3;
    return 4;
  };

  const monthLabels = useMemo(() => {
    const labels: { col: number; text: string }[] = [];
    let previousMonth = -1;
    // new Date(0) keeps the seed pure for the linter; days is non-empty when rendered
    const probe = new Date(seedStartMs);
    probe.setDate(probe.getDate() - new Date(seedStartMs).getDay());
    for (let col = 0; col < columns.length; col++) {
      const month = probe.getMonth();
      if (col > 0 && month !== previousMonth) {
        labels.push({ col, text: formatMonthLabel(probe.getTime()) });
      }
      previousMonth = month;
      probe.setDate(probe.getDate() + 7);
    }
    return labels;
  }, [columns, seedStartMs]);

  const weekdayLabels = useMemo(() => {
    // rows 1/3/5 → Mon/Wed/Fri, labeled from the first full week anchor (Sunday of column 0)
    const sunday = new Date(seedStartMs);
    sunday.setDate(sunday.getDate() - sunday.getDay());
    return [1, 3, 5].map((row) => {
      const probe = new Date(sunday);
      probe.setDate(probe.getDate() + row);
      return { row, text: formatWeekdayLabel(probe.getTime()) };
    });
  }, [seedStartMs]);

  if (days.length === 0) return null;

  // Scale cells so the last day sits flush against the card's right edge;
  // the exact (fractional) size spreads the sub-pixel remainder across all
  // columns instead of leaving it as trailing blank space. Below the minimum
  // size the grid keeps natural width and scrolls instead.
  const weeks = columns.length;
  const fitted = containerWidth > 0 && weeks > 0
    ? (containerWidth - HEATMAP_LABEL_WIDTH - (weeks - 1) * HEATMAP_GAP) / weeks
    : HEATMAP_CELL_MIN;
  const cellSize = Math.max(HEATMAP_CELL_MIN, Math.min(HEATMAP_CELL_MAX, fitted));
  const cellStep = cellSize + HEATMAP_GAP;
  const hoveredPoint = hover?.point ?? null;
  const tooltipFlip = hover !== null && hover.col > columns.length * 0.6;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <div style={{ overflowX: "auto", paddingBottom: 2 }}>
        <div style={{ display: "inline-block" }} onPointerLeave={() => setHover(null)}>
          {/* month labels */}
          <div style={{ display: "flex", marginLeft: HEATMAP_LABEL_WIDTH, height: HEATMAP_MONTH_ROW_HEIGHT, alignItems: "flex-end", paddingBottom: 3 }}>
            {columns.map((_, col) => {
              const label = monthLabels.find((entry) => entry.col === col);
              return (
                <span key={col} style={{ width: cellStep, flexShrink: 0, fontSize: 9.5, color: "var(--text-dim)", whiteSpace: "nowrap", position: "relative" }}>
                  {label ? label.text : ""}
                </span>
              );
            })}
          </div>
          <div style={{ display: "flex" }}>
            {/* weekday labels */}
            <div style={{ width: HEATMAP_LABEL_WIDTH, flexShrink: 0 }}>
              {Array.from({ length: 7 }, (_, row) => {
                const label = weekdayLabels.find((entry) => entry.row === row);
                return (
                  <div key={row} style={{ height: cellSize, marginBottom: row < 6 ? HEATMAP_GAP : 0, fontSize: 9.5, lineHeight: `${cellSize}px`, color: "var(--text-dim)", textAlign: "right", paddingRight: 5, whiteSpace: "nowrap" }}>
                    {label ? label.text : ""}
                  </div>
                );
              })}
            </div>
            {/* grid */}
            <div style={{ display: "flex" }}>
              {columns.map((week, col) => (
                <div key={col} style={{ display: "flex", flexDirection: "column", marginRight: col < columns.length - 1 ? HEATMAP_GAP : 0 }}>
                  {week.map((point, row) => {
                    if (!point) {
                      return <span key={row} style={{ width: cellSize, height: cellSize, marginBottom: row < 6 ? HEATMAP_GAP : 0, borderRadius: 2.5 }} />;
                    }
                    const level = levelOf(point.totalTokens);
                    const isHovered = hoveredPoint?.startMs === point.startMs;
                    return (
                      <span
                        key={row}
                        style={{
                          width: cellSize,
                          height: cellSize,
                          marginBottom: row < 6 ? HEATMAP_GAP : 0,
                          borderRadius: 2.5,
                          background: HEATMAP_LEVEL_COLORS[level],
                          outline: isHovered ? "1.5px solid var(--text-muted)" : "none",
                          cursor: "default",
                          transition: "outline 0.1s",
                        }}
                        onPointerEnter={() => setHover({ col, row, point })}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {hover && hoveredPoint && (
        <div
          style={{
            position: "absolute",
            top: HEATMAP_MONTH_ROW_HEIGHT + hover.row * cellStep + cellSize + 8,
            left: HEATMAP_LABEL_WIDTH + hover.col * cellStep,
            transform: tooltipFlip ? "translateX(-100%)" : "translateX(14px)",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            boxShadow: "0 6px 24px rgba(0,0,0,0.16)",
            padding: "8px 11px",
            pointerEvents: "none",
            whiteSpace: "nowrap",
            zIndex: 2,
          }}
        >
          <div style={{ fontSize: 10.5, color: "var(--text-muted)", marginBottom: 4 }}>
            {formatDayLabel(hoveredPoint.startMs)}
          </div>
          <div style={{ fontSize: 12, color: "var(--text)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
            {formatCompactTokens(hoveredPoint.totalTokens)} tokens
          </div>
          {(hoveredPoint.cost.amount ?? 0) > 0 && (
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums", marginTop: 2 }}>
              {formatCost(hoveredPoint.cost.amount)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
