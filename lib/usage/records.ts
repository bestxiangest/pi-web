/**
 * Server-side reader for the pi-token-usage-statistics plugin's durable store.
 *
 * Read-only, exactly like the plugin's own standalone viewer: pi sessions
 * (including pi-web RPC sessions) append normalized records to
 * `<agent-dir>/token-usage-statistics/records.jsonl` and we never write it.
 *
 * Parsed records are cached on globalThis keyed by (mtime, size) so dashboard
 * polling re-parses only after the plugin actually appended something. The
 * cache must survive Next.js hot-reload like every other global here.
 */
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageRecordInput } from "./aggregate";

export function usageRecordsFilePath(): string {
  return join(homedir(), ".pi", "agent", "token-usage-statistics", "records.jsonl");
}

type UsageRecordsCache = {
  key: string;
  records: UsageRecordInput[];
};

const globalUsage = globalThis as unknown as {
  __piUsageRecordsCache?: UsageRecordsCache;
};

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isCostTotal = (value: unknown): value is { total: number } =>
  Boolean(value)
  && typeof value === "object"
  && !Array.isArray(value)
  && isFiniteNonNegative((value as { total?: unknown }).total);

/**
 * Structural guard mirroring the plugin's persisted format: parseable-but-
 * garbage lines are skipped so aggregation can never see NaN token fields.
 */
const isUsageRecordLike = (value: unknown): value is UsageRecordInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.recordId !== "string" || record.recordId === "") return false;
  for (const key of ["timestampMs", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    if (!isFiniteNonNegative(record[key])) return false;
  }
  if (record.costKind !== "recorded" && record.costKind !== "estimated" && record.costKind !== "unavailable") return false;
  if (record.sourceKind !== "assistant" && record.sourceKind !== "summary") return false;
  for (const key of ["sessionId", "projectCwd", "provider", "model"] as const) {
    if (typeof record[key] !== "string") return false;
  }
  return true;
};

function parseRecordsJsonl(text: string): UsageRecordInput[] {
  const records: UsageRecordInput[] = [];
  let start = 0;
  while (start <= text.length) {
    const end = text.indexOf("\n", start);
    const lineEnd = end === -1 ? text.length : end;
    const line = text.slice(start, lineEnd);
    if (line.trim() !== "") {
      try {
        const value: unknown = JSON.parse(line);
        if (isUsageRecordLike(value)) {
          records.push({
            recordId: value.recordId,
            sessionId: value.sessionId,
            projectCwd: value.projectCwd,
            timestampMs: value.timestampMs,
            provider: value.provider,
            model: value.model,
            inputTokens: value.inputTokens,
            outputTokens: value.outputTokens,
            cacheReadTokens: value.cacheReadTokens,
            cacheWriteTokens: value.cacheWriteTokens,
            recordedCost: value.costKind === "recorded" && isCostTotal(value.recordedCost)
              ? { total: value.recordedCost.total }
              : undefined,
            estimatedCost: value.costKind === "estimated" && isCostTotal(value.estimatedCost)
              ? { total: value.estimatedCost.total }
              : undefined,
            costKind: value.costKind,
            sourceKind: value.sourceKind,
          });
        }
      } catch {
        // malformed or truncated final line — skip
      }
    }
    if (end === -1) break;
    start = end + 1;
  }
  return records;
}

export type LoadedUsageRecords =
  | { available: false }
  | { available: true; records: UsageRecordInput[] };

/**
 * Load the shared records file. `available: false` means the plugin has never
 * run on this machine — the dashboard then shows its install hint instead of data.
 */
export async function loadUsageRecords(): Promise<LoadedUsageRecords> {
  const filePath = usageRecordsFilePath();
  let mtimeMs = 0;
  let size = 0;
  try {
    const stats = await stat(filePath);
    mtimeMs = stats.mtimeMs;
    size = stats.size;
  } catch {
    return { available: false };
  }

  const key = `${mtimeMs}:${size}`;
  const cached = globalUsage.__piUsageRecordsCache;
  if (cached && cached.key === key) return { available: true, records: cached.records };

  let text = "";
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return { available: false };
  }
  const records = parseRecordsJsonl(text);
  globalUsage.__piUsageRecordsCache = { key, records };
  return { available: true, records };
}
