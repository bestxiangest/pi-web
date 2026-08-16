"use client";

/** Unified-diff viewer shared by the Changes tab, commit detail, and file history. */
import { useMemo } from "react";
import { parseUnifiedDiff } from "@/lib/git/parse-diff";

type DiffViewerProps = {
  patch: string;
  /** Rendered above the patch, e.g. the file path being viewed. */
  title?: string;
  emptyText: string;
  maxHeight?: number | string;
  /** When set, only this file's block is rendered (commit detail file click). */
  pathFilter?: string | null;
};

const STATUS_COLORS: Record<string, string> = {
  A: "#059669",
  M: "#2563eb",
  D: "#dc2626",
  R: "#a855f7",
  C: "#0d9488",
};

export function DiffViewer({ patch, title, emptyText, maxHeight = "100%", pathFilter }: DiffViewerProps) {
  const blocks = useMemo(() => {
    const parsed = parseUnifiedDiff(patch);
    return pathFilter ? parsed.filter((block) => block.path === pathFilter) : parsed;
  }, [patch, pathFilter]);

  if (!patch.trim()) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>
        {emptyText}
      </div>
    );
  }

  return (
    <div style={{ overflowY: "auto", maxHeight, minWidth: 0 }}>
      {title && (
        <div style={{
          position: "sticky", top: 0, zIndex: 1, background: "var(--bg)",
          padding: "7px 12px", borderBottom: "1px solid var(--border)",
          fontSize: 12, color: "var(--text)", fontFamily: "var(--font-mono)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {title}
        </div>
      )}
      {blocks.map((block) => (
        <div key={`${block.oldPath ?? ""}->${block.path}`} style={{ marginBottom: 10, minWidth: 0 }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 8, padding: "5px 12px",
            background: "var(--bg-subtle)", fontSize: 12, color: "var(--text)",
            fontFamily: "var(--font-mono)", position: "sticky", top: title ? 31 : 0, zIndex: 1,
          }}>
            <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{block.oldPath && block.oldPath !== block.path ? `${block.oldPath} →` : ""}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{block.path}</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 8, flexShrink: 0, fontSize: 11 }}>
              <span style={{ color: "#059669" }}>+{block.additions}</span>
              <span style={{ color: "#dc2626" }}>-{block.deletions}</span>
            </span>
          </div>
          {block.hunks.map((hunk, hunkIndex) => (
            <div key={hunkIndex}>
              <div style={{
                padding: "3px 12px", fontSize: 11, color: "var(--text-muted)",
                fontFamily: "var(--font-mono)", background: "var(--bg-subtle)",
              }}>
                @@ -{hunk.oldStart} +{hunk.newStart} @@
              </div>
              {hunk.lines.map((line, lineIndex) => (
                <div
                  key={lineIndex}
                  style={{
                    display: "flex", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: "18px",
                    background: line.type === "add"
                      ? "rgba(16,185,129,0.10)"
                      : line.type === "del"
                        ? "rgba(239,68,68,0.10)"
                        : "transparent",
                    whiteSpace: "pre",
                  }}
                >
                  <span style={{ width: 40, flexShrink: 0, textAlign: "right", paddingRight: 7, color: "var(--text-dim)", userSelect: "none", opacity: 0.7 }}>
                    {line.oldLine ?? ""}
                  </span>
                  <span style={{ width: 40, flexShrink: 0, textAlign: "right", paddingRight: 8, color: "var(--text-dim)", userSelect: "none", opacity: 0.7, borderRight: "1px solid var(--border)", marginRight: 8 }}>
                    {line.newLine ?? ""}
                  </span>
                  <span style={{
                    color: line.type === "add" ? "#059669" : line.type === "del" ? "#dc2626" : "var(--text)",
                    minWidth: 0, overflowWrap: "anywhere",
                  }}>
                    {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}{line.text}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Small colored status letter badge (A/M/D/R/…) for file rows. */
export function GitStatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "var(--text-muted)";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 16, height: 16, borderRadius: 4, fontSize: 10, fontWeight: 700,
      color, background: "var(--bg-subtle)", flexShrink: 0, fontFamily: "var(--font-mono)",
    }}>
      {status}
    </span>
  );
}
