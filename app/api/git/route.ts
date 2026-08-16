import { NextResponse } from "next/server";
import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import {
  branches,
  commitFiles,
  diffText,
  GitError,
  logCommits,
  repoInfo,
  repoRoot,
  runGit,
  stashList,
  statusFiles,
  tags,
} from "@/lib/git/git";
import { generateCommitMessage } from "@/lib/git/commit-message";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { listAllSessions, resolveSessionPath } from "@/lib/session-reader";
import { toNativePath } from "@/lib/paths";

/**
 * POST /api/git — single dispatcher for the Git panel.
 *
 * Body: { op: string, cwd: string, ...opSpecific }.
 * The cwd must pass the same allow-list as /api/files; all git operations run
 * with argument arrays (never a shell), rooted at the repository top-level.
 */
type GitRequest = {
  op: string;
  cwd: string;
  paths?: string[];
  path?: string;
  message?: string;
  amend?: boolean;
  name?: string;
  url?: string;
  from?: string;
  ref?: string;
  remote?: string;
  branch?: string;
  force?: boolean;
  setUpstream?: boolean;
  staged?: boolean;
  kind?: "worktree" | "staged" | "commit";
  limit?: number;
  skip?: number;
  index?: number;
  hash?: string;
  annotated?: boolean;
  borrowSessionId?: string | null;
  /** AI commit-message model override: provider + modelId. */
  modelProvider?: string;
  modelId?: string;
  /** Commit everything (stage all changes first) instead of the index only. */
  all?: boolean;
};

export async function POST(request: Request) {
  let body: GitRequest;
  try {
    body = await request.json() as GitRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.cwd || typeof body.cwd !== "string") {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(body.cwd, allowedRoots)) {
    return NextResponse.json({ error: "This directory is not accessible" }, { status: 403 });
  }

  try {
    // Resolve the repo root once; ops that must work outside a repo handle null.
    const root = await repoRoot(body.cwd);
    const gitRoot = root ?? body.cwd;

    switch (body.op) {
      case "info": {
        if (!root) return NextResponse.json({ repo: null });
        return NextResponse.json({ repo: await repoInfo(root) });
      }
      case "status": {
        if (!root) return NextResponse.json({ error: "Not a git repository" }, { status: 400 });
        const [files, info] = await Promise.all([statusFiles(root), repoInfo(root)]);
        return NextResponse.json({ files, repo: info });
      }
      case "stage": {
        await runGit(gitRoot, ["add", "--", ...(body.paths ?? [])]);
        return NextResponse.json({ ok: true });
      }
      case "unstage": {
        // Files just added (A) have no HEAD entry — reset works for tracked, add -N not needed here.
        await runGit(gitRoot, ["reset", "HEAD", "--", ...(body.paths ?? [])]).catch(() =>
          runGit(gitRoot, ["rm", "--cached", "--", ...(body.paths ?? [])]),
        );
        return NextResponse.json({ ok: true });
      }
      case "discard": {
        const paths = body.paths ?? [];
        const status = await statusFiles(gitRoot);
        const tracked: string[] = [];
        const untracked: string[] = [];
        for (const p of paths) {
          const entry = status.find((file) => file.path === p);
          if (entry?.untracked) untracked.push(p);
          else tracked.push(p);
        }
        if (tracked.length > 0) await runGit(gitRoot, ["checkout", "HEAD", "--", ...tracked]);
        if (untracked.length > 0) await runGit(gitRoot, ["clean", "-f", "--", ...untracked]);
        return NextResponse.json({ ok: true });
      }
      case "commit": {
        if (!body.message?.trim()) {
          return NextResponse.json({ error: "Commit message is empty" }, { status: 400 });
        }
        // all: stage every change (including untracked) first — VS Code's
        // "commit all" behavior, no manual staging round-trip needed.
        if (body.all) {
          await runGit(gitRoot, ["add", "-A"]);
        }
        const args = ["commit", "-m", body.message];
        if (body.amend) args.push("--amend", "--no-edit");
        if (body.paths && body.paths.length > 0) args.push("--", ...body.paths);
        const output = await runGit(gitRoot, args);
        return NextResponse.json({ ok: true, output: output.trim() });
      }
      case "log": {
        if (!root) return NextResponse.json({ error: "Not a git repository" }, { status: 400 });
        const commits = await logCommits(root, {
          limit: body.limit ?? 100,
          skip: body.skip,
          path: body.path,
          ref: body.ref,
        });
        return NextResponse.json({ commits });
      }
      case "branches": {
        if (!root) return NextResponse.json({ error: "Not a git repository" }, { status: 400 });
        return NextResponse.json({ branches: await branches(root) });
      }
      case "branchCreate": {
        if (!body.name) return NextResponse.json({ error: "Branch name is required" }, { status: 400 });
        const args = ["branch", body.name];
        if (body.from) args.push(body.from);
        await runGit(gitRoot, args);
        return NextResponse.json({ ok: true });
      }
      case "branchSwitch": {
        if (!body.name) return NextResponse.json({ error: "Branch is required" }, { status: 400 });
        const all = await branches(gitRoot);
        const isRemote = all.find((b) => b.name === body.name)?.remote;
        if (isRemote) {
          const localName = body.name.split("/").slice(1).join("/");
          await runGit(gitRoot, ["checkout", "-b", localName, "--track", body.name]);
        } else {
          await runGit(gitRoot, ["checkout", body.name]);
        }
        return NextResponse.json({ ok: true });
      }
      case "branchDelete": {
        if (!body.name) return NextResponse.json({ error: "Branch is required" }, { status: 400 });
        await runGit(gitRoot, ["branch", "-D", body.name]);
        return NextResponse.json({ ok: true });
      }
      case "remotes": {
        if (!root) return NextResponse.json({ error: "Not a git repository" }, { status: 400 });
        return NextResponse.json({ remotes: (await repoInfo(root)).remotes });
      }
      case "remoteAdd": {
        if (!body.name || !body.url) return NextResponse.json({ error: "Name and URL are required" }, { status: 400 });
        await runGit(gitRoot, ["remote", "add", body.name, body.url]);
        return NextResponse.json({ ok: true });
      }
      case "remoteRemove": {
        if (!body.name) return NextResponse.json({ error: "Remote name is required" }, { status: 400 });
        await runGit(gitRoot, ["remote", "remove", body.name]);
        return NextResponse.json({ ok: true });
      }
      case "remoteSetUrl": {
        if (!body.name || !body.url) return NextResponse.json({ error: "Name and URL are required" }, { status: 400 });
        await runGit(gitRoot, ["remote", "set-url", body.name, body.url]);
        return NextResponse.json({ ok: true });
      }
      case "fetch": {
        const args = ["fetch", ...(body.remote ? [body.remote] : []), "--prune"];
        const output = await runGit(gitRoot, args, { timeoutMs: 180_000 });
        return NextResponse.json({ ok: true, output: output.trim() });
      }
      case "pull": {
        const args = ["pull"];
        if (body.remote) args.push(body.remote);
        if (body.branch) args.push(body.branch);
        const output = await runGit(gitRoot, args, { timeoutMs: 180_000 });
        return NextResponse.json({ ok: true, output: output.trim() });
      }
      case "push": {
        const args = ["push"];
        if (body.force) args.push("--force-with-lease");
        if (body.setUpstream && body.remote && body.branch) args.push("-u", body.remote, body.branch);
        else if (body.remote) args.push(body.remote, ...(body.branch ? [body.branch] : []));
        const output = await runGit(gitRoot, args, { timeoutMs: 180_000 });
        return NextResponse.json({ ok: true, output: output.trim() });
      }
      case "tags": {
        if (!root) return NextResponse.json({ error: "Not a git repository" }, { status: 400 });
        return NextResponse.json({ tags: await tags(root) });
      }
      case "tagCreate": {
        if (!body.name) return NextResponse.json({ error: "Tag name is required" }, { status: 400 });
        const args = ["tag"];
        if (body.annotated) args.push("-a", body.name, "-m", body.message ?? body.name);
        else args.push(body.name);
        if (body.ref) args.push(body.ref);
        await runGit(gitRoot, args);
        return NextResponse.json({ ok: true });
      }
      case "tagDelete": {
        if (!body.name) return NextResponse.json({ error: "Tag name is required" }, { status: 400 });
        await runGit(gitRoot, ["tag", "-d", body.name]);
        return NextResponse.json({ ok: true });
      }
      case "stashList": {
        if (!root) return NextResponse.json({ error: "Not a git repository" }, { status: 400 });
        return NextResponse.json({ stashes: await stashList(root) });
      }
      case "stashSave": {
        const args = ["stash", "push", "-u"];
        if (body.message) args.push("-m", body.message);
        await runGit(gitRoot, args);
        return NextResponse.json({ ok: true });
      }
      case "stashPop": {
        await runGit(gitRoot, ["stash", "pop", `stash@{${body.index ?? 0}}`]);
        return NextResponse.json({ ok: true });
      }
      case "stashDrop": {
        await runGit(gitRoot, ["stash", "drop", `stash@{${body.index ?? 0}}`]);
        return NextResponse.json({ ok: true });
      }
      case "diff": {
        if (!root) return NextResponse.json({ error: "Not a git repository" }, { status: 400 });
        const patch = await diffText(root, {
          kind: body.kind ?? "worktree",
          path: body.path,
          ref: body.ref,
        });
        return NextResponse.json({ patch });
      }
      case "commitDetail": {
        if (!root || !body.hash) return NextResponse.json({ error: "hash is required" }, { status: 400 });
        const [commits, files, patch] = await Promise.all([
          logCommits(root, { limit: 1, ref: body.hash }),
          commitFiles(root, body.hash),
          diffText(root, { kind: "commit", ref: body.hash }).catch(() => ""),
        ]);
        if (commits.length === 0) return NextResponse.json({ error: "Commit not found" }, { status: 404 });
        return NextResponse.json({ detail: { commit: commits[0], files, patch } });
      }
      case "fileHistory": {
        if (!root || !body.path) return NextResponse.json({ error: "path is required" }, { status: 400 });
        const commits = await logCommits(root, { limit: 100, path: body.path });
        return NextResponse.json({ commits, path: toNativePath(body.path) });
      }
      case "aiCommitMessage": {
        if (!root) return NextResponse.json({ error: "Not a git repository" }, { status: 400 });
        let diff = await diffText(root, { kind: "staged" });
        if (diff.trim() === "") {
          diff = await diffText(root, { kind: "worktree" });
        }
        if (diff.trim() === "") {
          return NextResponse.json({ error: "No changes to describe — stage or edit files first" }, { status: 400 });
        }

        // Optional model override, resolved through the same registry the
        // session uses. The borrowed agent's streamFn/getApiKey dispatch
        // dynamically by model, so any configured model is usable.
        let modelOverride: unknown;
        if (body.modelProvider && body.modelId) {
          const services = await createAgentSessionServices({ cwd: root, agentDir: getAgentDir() });
          const model = services.modelRuntime.getModel(body.modelProvider, body.modelId);
          if (!model) {
            return NextResponse.json(
              { error: `Model not found: ${body.modelProvider}/${body.modelId}` },
              { status: 400 },
            );
          }
          modelOverride = model;
        }

        // Borrow any existing session's provider config; prefer the caller's
        // current session, then a session from this repo, then the latest.
        const sessions = await listAllSessions();
        const candidate =
          (body.borrowSessionId && sessions.find((s) => s.id === body.borrowSessionId))
          ?? sessions.find((s) => root === (s.projectRoot ?? s.cwd) || root === s.cwd)
          ?? sessions.find((s) => (s.projectRoot ?? s.cwd) === body.cwd)
          ?? [...sessions].sort((a, b) => b.modified.localeCompare(a.modified))[0];
        if (!candidate) {
          return NextResponse.json({ error: "No pi session available to borrow model config from" }, { status: 400 });
        }
        const filePath = await resolveSessionPath(candidate.id);
        if (!filePath) return NextResponse.json({ error: "Session file not found" }, { status: 400 });
        const existing = getRpcSession(candidate.id);
        const { session } = existing?.isAlive()
          ? { session: existing }
          : await startRpcSession(candidate.id, filePath, undefined);
        await session.waitUntilReady?.();
        const { message, model } = await generateCommitMessage(
          session.inner as unknown as Parameters<typeof generateCommitMessage>[0],
          diff,
          modelOverride,
        );
        return NextResponse.json({ message, model });
      }
      default:
        return NextResponse.json({ error: `Unknown op: ${body.op}` }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof GitError) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
