/** Shared types for the Git panel (client-safe: pure types only). */

export type GitFileStatus = {
  /** Two-letter porcelain code, e.g. "M ", " M", "??", "A ", "R ". */
  code: string;
  /** Path relative to the repo root. */
  path: string;
  /** Previous path for renames/copies. */
  oldPath?: string;
  /** true when listed under the staged (index) column: X !== ' ' and X !== '?'. */
  staged: boolean;
  /** true when listed under the worktree column: Y !== ' '. */
  unstaged: boolean;
  untracked: boolean;
};

export type GitRepoInfo = {
  /** Resolved repository root (absolute). */
  root: string;
  /** Current branch name, or detached HEAD short hash. */
  branch: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** true when the working tree or index is dirty. */
  dirty: boolean;
  remotes: { name: string; fetchUrl: string; pushUrl: string }[];
};

export type GitCommit = {
  hash: string;
  shortHash: string;
  parentHashes: string[];
  authorName: string;
  authorEmail: string;
  /** Unix seconds. */
  timestamp: number;
  /** Decorations: branch/tag/HEAD names. */
  refs: string[];
  subject: string;
  body: string;
};

export type GitBranch = {
  name: string;
  fullName: string;
  isHead: boolean;
  upstream: string | null;
  /** e.g. "ahead 2", "behind 1", "ahead 1, behind 2", "" when in sync / no upstream. */
  track: string;
  tipShortHash: string;
  /** Unix seconds of tip commit. */
  timestamp: number;
  subject: string;
  remote: boolean;
};

export type GitTag = {
  name: string;
  /** Commit the tag points at (peeled for annotated tags). */
  commitShortHash: string;
  /** Unix seconds of the tagged commit. */
  timestamp: number;
  subject: string;
  annotated: boolean;
};

export type GitStashEntry = {
  index: number;
  message: string;
  shortHash: string;
  timestamp: number;
};

export type GitDiffFile = {
  path: string;
  oldPath?: string;
  status: string;
  additions: number;
  deletions: number;
};

export type GitCommitDetail = {
  commit: GitCommit;
  files: GitDiffFile[];
  /** Unified diff patch of the whole commit (empty for merges/root edge cases). */
  patch: string;
};

/** Parsed unified-diff structure used by the client diff viewer. */
export type DiffHunk = {
  oldStart: number;
  newStart: number;
  lines: { type: "add" | "del" | "context"; text: string; oldLine?: number; newLine?: number }[];
};

export type DiffFileBlock = {
  path: string;
  oldPath?: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
};
