"use client";

/**
 * Commit graph for the Git sidebar: lane-based SVG history with merge curves,
 * inline commit detail, and path-filtered file history.
 *
 * Lane model: `occupied` maps lane → the hash that lane expects next. A commit
 * claims the lowest lane expecting it; extra expecting lanes converge into the
 * node with a curve (instead of passing through and dangling). Its first parent
 * continues on the same lane; extra parents fan out to free lanes.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { assignLanes, type GraphRow } from "@/lib/git/graph-lanes";
import type { GitCommit, GitCommitDetail } from "@/lib/git/types";
import { GitStatusBadge } from "./git-diff";

const LANE_COLORS = ["#3b82f6", "#f97316", "#10b981", "#a855f7", "#e11d48", "#0d9488", "#eab308", "#6366f1"];
const LANE_WIDTH = 13;
const ROW_HEIGHT = 40;
const PAGE_SIZE = 100;

const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];
const laneX = (lane: number) => 7 + lane * LANE_WIDTH + LANE_WIDTH / 2;

function relativeTime(timestamp: number): string {
  const diff = Date.now() / 1000 - timestamp;
  if (diff < 60) return `${Math.max(1, Math.floor(diff))}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

type GitGraphProps = {
  cwd: string;
  refreshKey: number;
  onNotify: (message: string, isError?: boolean) => void;
  /** Open a file's diff at a specific commit in the right panel. */
  onOpenFile: (relPath: string, ref: string) => void;
};

export function GitGraph({ cwd, refreshKey, onNotify, onOpenFile }: GitGraphProps) {
  const { t } = useI18n();
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [historyPath, setHistoryPath] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch("/api/git", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "log", cwd, limit: PAGE_SIZE, ...(historyPath ? { path: historyPath } : {}) }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        setCommits(body.commits as GitCommit[]);
        setExhausted((body.commits as GitCommit[]).length < PAGE_SIZE);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        onNotify(error instanceof Error ? error.message : String(error), true);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [cwd, refreshKey, historyPath, onNotify]);

  const loadMore = useCallback(async () => {
    if (loadingMore || exhausted) return;
    setLoadingMore(true);
    try {
      const response = await fetch("/api/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "log", cwd, limit: PAGE_SIZE, skip: commits.length, ...(historyPath ? { path: historyPath } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      const next = body.commits as GitCommit[];
      setCommits((previous) => [...previous, ...next]);
      setExhausted(next.length < PAGE_SIZE);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setLoadingMore(false);
    }
  }, [commits.length, cwd, exhausted, historyPath, loadingMore, onNotify]);

  const openCommit = useCallback(async (hash: string) => {
    if (selectedHash === hash) {
      setSelectedHash(null);
      setDetail(null);
      return;
    }
    setSelectedHash(hash);
    setDetail(null);
    setDetailLoading(true);
    try {
      const response = await fetch("/api/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "commitDetail", cwd, hash }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setDetail(body.detail as GitCommitDetail);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setDetailLoading(false);
    }
  }, [cwd, onNotify, selectedHash]);

  const { rows, laneCount } = useMemo(() => assignLanes(commits), [commits]);
  const graphWidth = 7 + laneCount * LANE_WIDTH + 7;

  const renderBand = (row: GraphRow) => {
    const midY = ROW_HEIGHT / 2;
    return (
      <svg width={graphWidth} height={ROW_HEIGHT} style={{ display: "block", flexShrink: 0 }}>
        {row.passThrough.map((lane) => (
          <line
            key={`p${lane}`}
            x1={laneX(lane)} x2={laneX(lane)} y1={0} y2={ROW_HEIGHT}
            stroke={laneColor(lane)} strokeWidth={1.6} opacity={0.55}
          />
        ))}
        {/* Stem connecting the incoming edge (which ends at this row's top)
            down to the node — without it every node floats 20px below its line. */}
        {row.hasIncoming && (
          <line
            x1={laneX(row.nodeLane)} x2={laneX(row.nodeLane)} y1={0} y2={midY}
            stroke={laneColor(row.nodeLane)} strokeWidth={1.6} opacity={0.85}
          />
        )}
        {row.convergeLanes.map((lane) => (
          <path
            key={`c${lane}`}
            d={`M ${laneX(lane)} 0 C ${laneX(lane)} ${midY * 0.55}, ${laneX(row.nodeLane)} ${midY * 0.45}, ${laneX(row.nodeLane)} ${midY}`}
            fill="none" stroke={laneColor(lane)} strokeWidth={1.6} opacity={0.85}
          />
        ))}
        {row.edges.map((lane) => (
          <path
            key={`e${lane}`}
            d={`M ${laneX(row.nodeLane)} ${midY} C ${laneX(row.nodeLane)} ${midY + ROW_HEIGHT * 0.28}, ${laneX(lane)} ${midY + ROW_HEIGHT * 0.32}, ${laneX(lane)} ${ROW_HEIGHT}`}
            fill="none" stroke={laneColor(lane)} strokeWidth={1.6} opacity={0.85}
          />
        ))}
        <circle
          cx={laneX(row.nodeLane)} cy={midY} r={row.commit.refs.includes("HEAD") ? 4.5 : 3.5}
          fill={laneColor(row.nodeLane)} stroke="var(--bg)" strokeWidth={1.8}
        />
      </svg>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      {historyPath && (
        <div style={{
          display: "flex", alignItems: "center", gap: 6, padding: "5px 10px",
          borderBottom: "1px solid var(--border)", fontSize: 10.5, fontFamily: "var(--font-mono)",
          color: "var(--text-muted)", background: "var(--bg-subtle)",
        }}>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{historyPath}</span>
          <button type="button" onClick={() => setHistoryPath(null)} style={{ border: "none", background: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 13, lineHeight: 1 }}>×</button>
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {loading && <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>…</div>}
        {!loading && commits.length === 0 && (
          <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>{t("git.noCommits")}</div>
        )}
        {!loading && rows.map((row) => {
          const selected = row.commit.hash === selectedHash;
          return (
            <div key={row.commit.hash}>
              <div
                onClick={() => void openCommit(row.commit.hash)}
                style={{
                  display: "flex", alignItems: "center", minHeight: ROW_HEIGHT, cursor: "pointer",
                  background: selected ? "var(--bg-selected)" : "transparent",
                  borderBottom: "1px solid var(--border)",
                }}
                onMouseEnter={(event) => { if (!selected) event.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(event) => { if (!selected) event.currentTarget.style.background = "transparent"; }}
              >
                {renderBand(row)}
                <div style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                    <span style={{ fontSize: 11.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {row.commit.subject}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", display: "flex", gap: 5, alignItems: "center", minWidth: 0 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.commit.authorName}</span>
                    <span>{relativeTime(row.commit.timestamp)}</span>
                    {row.commit.refs.slice(0, 2).map((ref) => (
                      <span key={ref} style={{
                        fontSize: 9, padding: "0 5px", borderRadius: 99, flexShrink: 0, fontFamily: "var(--font-mono)",
                        color: ref === "HEAD" ? "var(--text)" : ref.startsWith("tag:") ? "#b45309" : "#1d4ed8",
                        background: ref === "HEAD" ? "var(--bg-subtle)" : ref.startsWith("tag:") ? "rgba(245,158,11,0.12)" : "rgba(59,130,246,0.12)",
                      }}>
                        {ref.replace(/^tag:/, "")}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              {selected && (
                <div style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
                  {detailLoading && <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 11.5 }}>…</div>}
                  {!detailLoading && detail && (
                    <>
                      <div style={{ padding: "9px 10px 7px" }}>
                        {detail.commit.body && (
                          <div style={{ fontSize: 10.5, color: "var(--text-muted)", whiteSpace: "pre-wrap", marginBottom: 6 }}>{detail.commit.body}</div>
                        )}
                        <div style={{ fontSize: 10, color: "var(--text-dim)", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                          <span>{detail.commit.authorName}</span>
                          <span>{new Date(detail.commit.timestamp * 1000).toLocaleDateString()}</span>
                          <span style={{ fontFamily: "var(--font-mono)" }}>{detail.commit.shortHash}</span>
                          {detail.commit.parentHashes.length > 1 && <span style={{ color: "#a855f7" }}>merge</span>}
                        </div>
                      </div>
                      {detail.files.map((file) => (
                        <div
                          key={file.path}
                          onClick={() => onOpenFile(file.oldPath ?? file.path, detail.commit.hash)}
                          style={{
                            display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", fontSize: 11,
                            cursor: "pointer", fontFamily: "var(--font-mono)",
                          }}
                          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
                        >
                          <GitStatusBadge status={file.status} />
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
                            {file.path}
                          </span>
                          {file.additions > 0 && <span style={{ color: "#059669", flexShrink: 0 }}>+{file.additions}</span>}
                          {file.deletions > 0 && <span style={{ color: "#dc2626", flexShrink: 0 }}>-{file.deletions}</span>}
                          <button
                            type="button"
                            title={t("git.fileHistory")}
                            onClick={(event) => {
                              event.stopPropagation();
                              setHistoryPath(file.path);
                              setSelectedHash(null);
                              setDetail(null);
                            }}
                            style={{ border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", padding: 2, flexShrink: 0, fontSize: 10.5 }}
                          >
                            ⟲
                          </button>
                        </div>
                      ))}
                      {detail.files.length === 0 && (
                        <div style={{ padding: 10, fontSize: 11, color: "var(--text-dim)" }}>{t("git.noFiles")}</div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!loading && !exhausted && commits.length > 0 && (
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            style={{
              width: "100%", border: "none", borderTop: "1px solid var(--border)", background: "none",
              padding: "8px 0", color: "var(--accent)", fontSize: 11.5, cursor: "pointer",
            }}
          >
            {loadingMore ? "…" : t("git.loadMore")}
          </button>
        )}
      </div>
    </div>
  );
}
