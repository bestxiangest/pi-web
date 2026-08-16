/**
 * Server-side git runner and parsers for the Git panel.
 *
 * Every operation spawns the user's `git` binary with argument arrays (never a
 * shell), confined to a cwd that passes the same allow-list as /api/files.
 * Parsers are exported pure functions so they can be unit-tested without a repo.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  GitBranch,
  GitCommit,
  GitDiffFile,
  GitFileStatus,
  GitRepoInfo,
  GitStashEntry,
  GitTag,
} from "./types";

const execFileAsync = promisify(execFile);

const FIELD = "\u001f";
const RECORD = "\u001e";

/** Longer budget for network operations (fetch/pull/push can be slow behind proxies). */
const DEFAULT_TIMEOUT_MS = 30_000;

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export async function runGit(cwd: string, args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    });
    return stdout;
  } catch (error) {
    const err = error as { stderr?: string; message?: string; killed?: boolean };
    if (err.killed) {
      throw new GitError(`git ${args[0]} timed out`, "");
    }
    const stderr = (err.stderr ?? "").toString().trim();
    throw new GitError(stderr || err.message || `git ${args[0]} failed`, stderr);
  }
}

/** `git rev-parse --show-toplevel` — null when cwd is not inside a repository. */
export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
    return root || null;
  } catch {
    return null;
  }
}

export async function repoInfo(root: string): Promise<GitRepoInfo> {
  const [branchRaw, upstreamRaw, remoteVerbose] = await Promise.all([
    runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => null),
    runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => null),
    runGit(root, ["remote", "-v"]),
  ]);

  const branch = branchRaw?.trim() || (await runGit(root, ["rev-parse", "--short", "HEAD"])).trim();
  const upstream = upstreamRaw?.trim() || null;

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await runGit(root, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    const [behindRaw, aheadRaw] = counts.trim().split(/\s+/);
    behind = Number.parseInt(behindRaw ?? "0", 10) || 0;
    ahead = Number.parseInt(aheadRaw ?? "0", 10) || 0;
  }

  const remotes: GitRepoInfo["remotes"] = [];
  for (const line of remoteVerbose.split("\n")) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)/);
    if (!match) continue;
    const [, name, url, kind] = match;
    let entry = remotes.find((remote) => remote.name === name);
    if (!entry) {
      entry = { name, fetchUrl: "", pushUrl: "" };
      remotes.push(entry);
    }
    if (kind === "fetch") entry.fetchUrl = url;
    else entry.pushUrl = url;
  }

  const statusOut = await runGit(root, ["status", "--porcelain"]);
  return {
    root,
    branch,
    detached: !branchRaw,
    upstream,
    ahead,
    behind,
    dirty: statusOut.trim().length > 0,
    remotes,
  };
}

/**
 * Parse `git status --porcelain=v1 -z -b` output.
 * With -z, records are NUL separated; renames carry the original path in the
 * following record.
 */
export function parseStatusZ(raw: string): { branchLine: string; files: GitFileStatus[] } {
  const parts = raw.split("\0").filter((part) => part !== "");
  let branchLine = "";
  const records: string[] = [];
  for (const part of parts) {
    if (branchLine === "" && part.startsWith("## ")) {
      branchLine = part.slice(3);
      continue;
    }
    records.push(part);
  }

  const files: GitFileStatus[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    let path = record.slice(3);
    let oldPath: string | undefined;
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") {
      oldPath = records[i + 1];
      i += 1;
    }
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    files.push({
      code,
      path,
      oldPath,
      staged: code[0] !== " " && code[0] !== "?",
      unstaged: code[1] !== " ",
      untracked: code === "??",
    });
  }
  return { branchLine, files };
}

export async function statusFiles(root: string): Promise<GitFileStatus[]> {
  const raw = await runGit(root, ["status", "--porcelain=v1", "-z", "-b"]);
  return parseStatusZ(raw).files;
}

/** Parse `git log` with the FIELD/RECORD delimiter format used by logCommits. */
export function parseLog(raw: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of raw.split(RECORD)) {
    // `git log --format=` is terminator-format: every entry is followed by a
    // newline, so records after the first start with "\n". Strip it.
    const clean = record.replace(/^\r?\n/, "");
    if (clean.trim() === "") continue;
    const fields = clean.split(FIELD);
    if (fields.length < 8) continue;
    const [hash, shortHash, parents, authorName, authorEmail, timestampRaw, decorations, subject, ...bodyParts] = fields;
    const refs = decorations
      .split(", ")
      .flatMap((ref) => ref.trim().split(/\s*->\s*/))
      .map((ref) => ref.trim())
      .filter((ref) => ref !== "");
    commits.push({
      hash,
      shortHash,
      parentHashes: parents === "" ? [] : parents.split(" "),
      authorName,
      authorEmail,
      timestamp: Number.parseInt(timestampRaw, 10) || 0,
      refs,
      subject,
      body: bodyParts.join(FIELD).trim(),
    });
  }
  return commits;
}

const LOG_FORMAT = `${[
  "%H", "%h", "%P", "%an", "%ae", "%at", "%D", "%s", "%b",
].join(FIELD)}${RECORD}`;

export async function logCommits(
  root: string,
  options: { limit?: number; skip?: number; path?: string; ref?: string } = {},
): Promise<GitCommit[]> {
  const args = ["log", `--format=${LOG_FORMAT}`, `--max-count=${options.limit ?? 100}`];
  if (options.skip && options.skip > 0) args.push(`--skip=${options.skip}`);
  // Topo order keeps each branch's commits contiguous, which makes the graph
  // lanes read like GitHub's. --follow rewrites history order on its own.
  if (!options.path) args.push("--topo-order");
  if (options.ref) args.push(options.ref);
  if (options.path) args.push("--follow", "--", options.path);
  const raw = await runGit(root, args);
  return parseLog(raw);
}

export async function branches(root: string): Promise<GitBranch[]> {
  const format = `%(refname)${FIELD}%(upstream:short)${FIELD}%(upstream:track)${FIELD}%(objectname:short)${FIELD}%(committerdate:unix)${FIELD}%(contents:subject)${FIELD}%(HEAD)${RECORD}`;
  const raw = await runGit(root, [
    "for-each-ref", `--format=${format}`, "refs/heads", "refs/remotes",
  ]);
  const result: GitBranch[] = [];
  for (const record of raw.split(RECORD)) {
    const clean = record.replace(/^\r?\n/, "");
    if (clean.trim() === "") continue;
    const [fullName, upstream, trackRaw, tipShortHash, timestampRaw, subject, headMark] = clean.split(FIELD);
    if (!fullName) continue;
    const remote = fullName.startsWith("refs/remotes/");
    const name = fullName.replace(/^refs\/(heads|remotes)\//, "");
    // Skip remote HEAD symbolic refs (origin/HEAD -> origin/main)
    if (remote && name.endsWith("/HEAD")) continue;
    result.push({
      name,
      fullName,
      isHead: headMark === "*",
      upstream: upstream || null,
      track: (trackRaw || "").replace(/^\[|\]$/g, ""),
      tipShortHash,
      timestamp: Number.parseInt(timestampRaw, 10) || 0,
      subject,
      remote,
    });
  }
  return result;
}

export async function tags(root: string): Promise<GitTag[]> {
  const format = [
    "%(refname:short)",
    "%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)",
    "%(objecttype)",
    "%(creatordate:unix)",
    "%(contents:subject)",
  ].join(FIELD) + RECORD;
  const raw = await runGit(root, ["for-each-ref", `--format=${format}`, "refs/tags"]);
  const result: GitTag[] = [];
  for (const record of raw.split(RECORD)) {
    const clean = record.replace(/^\r?\n/, "");
    if (clean.trim() === "") continue;
    const [name, commitHash, objecttype, timestampRaw, subject] = clean.split(FIELD);
    if (!name) continue;
    result.push({
      name,
      commitShortHash: commitHash.slice(0, 8),
      timestamp: Number.parseInt(timestampRaw, 10) || 0,
      subject,
      annotated: objecttype === "tag",
    });
  }
  return result;
}

export async function stashList(root: string): Promise<GitStashEntry[]> {
  const format = ["%gd", "%gs", "%h", "%ct"].join(FIELD) + RECORD;
  let raw = "";
  try {
    raw = await runGit(root, ["stash", "list", `--format=${format}`]);
  } catch {
    return [];
  }
  const result: GitStashEntry[] = [];
  for (const record of raw.split(RECORD)) {
    const clean = record.replace(/^\r?\n/, "");
    if (clean.trim() === "") continue;
    const [ref, message, shortHash, timestampRaw] = clean.split(FIELD);
    const indexMatch = ref.match(/stash@\{(\d+)\}/);
    if (!indexMatch) continue;
    result.push({
      index: Number.parseInt(indexMatch[1], 10),
      message,
      shortHash,
      timestamp: Number.parseInt(timestampRaw, 10) || 0,
    });
  }
  return result;
}

/** Per-file change list of one commit (status letter + add/del counts). */
export async function commitFiles(root: string, hash: string): Promise<GitDiffFile[]> {
  const [statusRaw, numstatRaw] = await Promise.all([
    runGit(root, ["diff-tree", "--no-commit-id", "-r", "-M", "--name-status", hash]).catch(() => ""),
    runGit(root, ["diff-tree", "--no-commit-id", "-r", "-M", "--numstat", hash]).catch(() => ""),
  ]);
  const counts = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstatRaw.split("\n")) {
    if (line.trim() === "") continue;
    const [adds, dels, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t").split(" => ").pop() ?? "";
    counts.set(path, {
      additions: adds === "-" ? 0 : Number.parseInt(adds, 10) || 0,
      deletions: dels === "-" ? 0 : Number.parseInt(dels, 10) || 0,
    });
  }
  const files: GitDiffFile[] = [];
  for (const line of statusRaw.split("\n")) {
    if (line.trim() === "") continue;
    const [status, path, oldPath] = line.split("\t");
    const cleanPath = path.split(" => ").pop() ?? path;
    const count = counts.get(cleanPath) ?? { additions: 0, deletions: 0 };
    files.push({ status: status.slice(0, 1), path, oldPath, ...count });
  }
  return files;
}

/** Unified diff text. kind: "worktree" | "staged" | "commit". */
export async function diffText(
  root: string,
  options: { kind: "worktree" | "staged" | "commit"; path?: string; ref?: string },
): Promise<string> {
  const args =
    options.kind === "commit" && options.ref
      // `git show --format=` renders the commit's own diff (vs first parent);
      // plain `git diff <ref>` would diff against the worktree instead.
      ? ["show", "--no-color", "-M", "--first-parent", "--format=", options.ref]
      : ["diff", "--no-color", "-M"];
  if (options.kind === "staged") args.push("--cached");
  if (options.path) args.push("--", options.path);
  return runGit(root, args);
}
