/** Client-safe unified-diff parser for the Git panel diff viewer. */
import type { DiffFileBlock, DiffHunk } from "./types";

const FILE_HEADER = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse `git diff` output into per-file blocks with hunks and line numbers.
 * Rename lines ("similarity index", "rename from/to", "old mode"…) are kept as
 * file-level meta via hunks staying empty for meta-only files.
 */
export function parseUnifiedDiff(patch: string): DiffFileBlock[] {
  const blocks: DiffFileBlock[] = [];
  let block: DiffFileBlock | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of patch.split("\n")) {
    const fileMatch = rawLine.match(FILE_HEADER);
    if (fileMatch) {
      block = { path: fileMatch[2], oldPath: fileMatch[1] !== fileMatch[2] ? fileMatch[1] : undefined, hunks: [], additions: 0, deletions: 0 };
      blocks.push(block);
      hunk = null;
      continue;
    }
    if (!block) continue;
    if (rawLine.startsWith("rename from ") || rawLine.startsWith("rename to ")) {
      const renamePath = rawLine.slice(rawLine.startsWith("rename from ") ? 12 : 10).replace(/^"|"$/g, "");
      if (rawLine.startsWith("rename from ")) block.oldPath = renamePath;
      else block.path = renamePath;
      continue;
    }
    const hunkMatch = rawLine.match(HUNK_HEADER);
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1], 10);
      newLine = Number.parseInt(hunkMatch[2], 10);
      hunk = { oldStart: oldLine, newStart: newLine, lines: [] };
      block.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue; // commit index / mode / --- / +++ / similarity meta
    if (rawLine.startsWith("+")) {
      hunk.lines.push({ type: "add", text: rawLine.slice(1), newLine });
      newLine += 1;
      block.additions += 1;
    } else if (rawLine.startsWith("-")) {
      hunk.lines.push({ type: "del", text: rawLine.slice(1), oldLine });
      oldLine += 1;
      block.deletions += 1;
    } else if (rawLine.startsWith(" ") || rawLine === "") {
      hunk.lines.push({ type: "context", text: rawLine.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else if (rawLine.startsWith("\\ No newline")) {
      hunk.lines.push({ type: "context", text: rawLine });
    }
  }
  return blocks;
}
