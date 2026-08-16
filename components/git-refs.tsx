"use client";

/** Branch / Remote / Tag / Stash management tabs for the Git panel. */
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { GitBranch, GitStashEntry, GitTag } from "@/lib/git/types";

export type GitNotify = (message: string, isError?: boolean) => void;

type TabProps = {
  cwd: string;
  refreshKey: number;
  onRefresh: () => void;
  onNotify: GitNotify;
};

// ── Branches ─────────────────────────────────────────────────────────────────

export function GitBranchesTab({ cwd, refreshKey, onRefresh, onNotify }: TabProps) {
  const { t } = useI18n();
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "branches", cwd }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setBranches(body.branches as GitBranch[]);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setLoading(false);
    }
  }, [cwd, onNotify]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const act = useCallback(async (payload: Record<string, unknown>, done: string) => {
    try {
      const response = await fetch("/api/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, ...payload }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      onNotify(done);
      onRefresh();
      await load();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), true);
    }
  }, [cwd, load, onNotify, onRefresh]);

  const local = branches.filter((branch) => !branch.remote);
  const remote = branches.filter((branch) => branch.remote);

  const rowStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 8, padding: "7px 12px",
    borderBottom: "1px solid var(--border)", fontSize: 12,
  };

  const actionButton = (label: string, onClick: () => void, color = "var(--accent)", danger = false): React.ReactNode => (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: "none", background: "none", color: danger ? "#dc2626" : color,
        cursor: "pointer", fontSize: 11, padding: "2px 6px", flexShrink: 0, whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder={t("git.newBranchName")}
          style={{
            flex: 1, minWidth: 0, border: "1px solid var(--border)", borderRadius: 8,
            padding: "6px 10px", fontSize: 12, background: "var(--bg)", color: "var(--text)",
            fontFamily: "var(--font-mono)",
          }}
        />
        <button
          type="button"
          disabled={!newName.trim() || creating}
          onClick={() => {
            setCreating(true);
            void act({ op: "branchCreate", name: newName.trim() }, t("git.branchCreated")).finally(() => {
              setCreating(false);
              setNewName("");
            });
          }}
          style={{
            border: "1px solid var(--border)", background: "var(--bg)", color: "var(--accent)",
            borderRadius: 8, padding: "6px 13px", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
          }}
        >
          {t("git.create")}
        </button>
      </div>
      {loading && <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>…</div>}
      {!loading && local.map((branch) => (
        <div key={branch.fullName} style={{ ...rowStyle, background: branch.isHead ? "var(--bg-subtle)" : "transparent" }}>
          <span style={{ color: branch.isHead ? "var(--accent)" : "var(--text)", fontWeight: branch.isHead ? 600 : 400, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {branch.name}
          </span>
          {branch.track && <span style={{ fontSize: 10, color: "#b45309", flexShrink: 0 }}>{branch.track}</span>}
          <span style={{ marginLeft: "auto", display: "flex", gap: 2, alignItems: "center" }}>
            {branch.isHead && <span style={{ fontSize: 10, color: "var(--text-dim)", marginRight: 4 }}>HEAD</span>}
            {!branch.isHead && actionButton(t("git.switch"), () => void act({ op: "branchSwitch", name: branch.name }, t("git.switched")))}
            {!branch.isHead && (confirmDelete === branch.name
              ? actionButton(t("common.ok"), () => {
                setConfirmDelete(null);
                void act({ op: "branchDelete", name: branch.name }, t("git.branchDeleted"));
              }, "", true)
              : actionButton(t("git.delete"), () => setConfirmDelete(branch.name), "", true))}
          </span>
        </div>
      ))}
      {!loading && remote.length > 0 && (
        <div style={{ padding: "8px 12px 4px", fontSize: 10.5, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4 }}>
          {t("git.remoteBranches")}
        </div>
      )}
      {!loading && remote.map((branch) => (
        <div key={branch.fullName} style={rowStyle}>
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {branch.name}
          </span>
          <span style={{ marginLeft: "auto" }}>
            {actionButton(t("git.switch"), () => void act({ op: "branchSwitch", name: branch.name }, t("git.switched")))}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Remotes ──────────────────────────────────────────────────────────────────

export function GitRemotesTab({ cwd, refreshKey, onRefresh, onNotify }: TabProps) {
  const { t } = useI18n();
  const [remotes, setRemotes] = useState<{ name: string; fetchUrl: string; pushUrl: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "remotes", cwd }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setRemotes(body.remotes);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setLoading(false);
    }
  }, [cwd, onNotify]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const act = useCallback(async (payload: Record<string, unknown>, done: string) => {
    try {
      const response = await fetch("/api/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, ...payload }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      onNotify(done);
      onRefresh();
      await load();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), true);
    }
  }, [cwd, load, onNotify, onRefresh]);

  return (
    <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
        <input
          value={name} onChange={(event) => setName(event.target.value)}
          placeholder={t("git.remoteName")}
          style={{ width: 100, flexShrink: 0, border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", fontSize: 12, background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)" }}
        />
        <input
          value={url} onChange={(event) => setUrl(event.target.value)}
          placeholder="git@github.com:user/repo.git"
          style={{ flex: 1, minWidth: 0, border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", fontSize: 12, background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)" }}
        />
        <button
          type="button"
          disabled={!name.trim() || !url.trim()}
          onClick={() => {
            void act({ op: "remoteAdd", name: name.trim(), url: url.trim() }, t("git.remoteAdded")).then(() => {
              setName("");
              setUrl("");
            });
          }}
          style={{ border: "1px solid var(--border)", background: "var(--bg)", color: "var(--accent)", borderRadius: 8, padding: "6px 13px", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}
        >
          {t("git.add")}
        </button>
      </div>
      {loading && <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>…</div>}
      {!loading && remotes.length === 0 && (
        <div style={{ padding: 20, color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>{t("git.noRemotes")}</div>
      )}
      {!loading && remotes.map((remote) => (
        <div key={remote.name} style={{ padding: "9px 12px", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>{remote.name}</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
              <button type="button" onClick={() => { setEditing(remote.name); setEditUrl(remote.fetchUrl); }} style={{ border: "none", background: "none", color: "var(--accent)", cursor: "pointer", fontSize: 11 }}>{t("git.edit")}</button>
              <button type="button" onClick={() => void act({ op: "remoteRemove", name: remote.name }, t("git.remoteRemoved"))} style={{ border: "none", background: "none", color: "#dc2626", cursor: "pointer", fontSize: 11 }}>{t("git.delete")}</button>
            </span>
          </div>
          {editing === remote.name ? (
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <input
                value={editUrl} onChange={(event) => setEditUrl(event.target.value)}
                style={{ flex: 1, minWidth: 0, border: "1px solid var(--border)", borderRadius: 8, padding: "5px 9px", fontSize: 11.5, background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)" }}
              />
              <button type="button" onClick={() => { void act({ op: "remoteSetUrl", name: remote.name, url: editUrl }, t("git.remoteUpdated")).then(() => setEditing(null)); }} style={{ border: "1px solid var(--border)", background: "var(--bg)", color: "var(--accent)", borderRadius: 8, padding: "5px 10px", fontSize: 11, cursor: "pointer" }}>{t("common.ok")}</button>
              <button type="button" onClick={() => setEditing(null)} style={{ border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", borderRadius: 8, padding: "5px 10px", fontSize: 11, cursor: "pointer" }}>×</button>
            </div>
          ) : (
            <div style={{ marginTop: 3, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {remote.fetchUrl}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Tags ─────────────────────────────────────────────────────────────────────

export function GitTagsTab({ cwd, refreshKey, onNotify }: TabProps) {
  const { t } = useI18n();
  const [tags, setTags] = useState<GitTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch("/api/git", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "tags", cwd }),
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        setTags(body.tags as GitTag[]);
      })
      .catch((error: unknown) => onNotify(error instanceof Error ? error.message : String(error), true))
      .finally(() => setLoading(false));
  }, [cwd, refreshKey, onNotify]);

  const act = useCallback(async (payload: Record<string, unknown>, done: string) => {
    try {
      const response = await fetch("/api/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, ...payload }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      onNotify(done);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), true);
    }
  }, [cwd, onNotify]);

  return (
    <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
        <input
          value={name} onChange={(event) => setName(event.target.value)}
          placeholder="v1.0.0"
          style={{ width: 130, flexShrink: 0, border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", fontSize: 12, background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)" }}
        />
        <input
          value={message} onChange={(event) => setMessage(event.target.value)}
          placeholder={t("git.tagMessage")}
          style={{ flex: 1, minWidth: 0, border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", fontSize: 12, background: "var(--bg)", color: "var(--text)" }}
        />
        <button
          type="button"
          disabled={!name.trim()}
          onClick={() => {
            void act({ op: "tagCreate", name: name.trim(), annotated: message.trim() !== "", message: message.trim() || undefined }, t("git.tagCreated")).then(() => {
              setName("");
              setMessage("");
            });
          }}
          style={{ border: "1px solid var(--border)", background: "var(--bg)", color: "var(--accent)", borderRadius: 8, padding: "6px 13px", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}
        >
          {t("git.create")}
        </button>
      </div>
      {loading && <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>…</div>}
      {!loading && tags.length === 0 && (
        <div style={{ padding: 20, color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>{t("git.noTags")}</div>
      )}
      {!loading && tags.map((tag) => (
        <div key={tag.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)", fontWeight: 600 }}>{tag.name}</span>
          {tag.annotated && <span style={{ fontSize: 9.5, padding: "1px 6px", borderRadius: 99, background: "rgba(245,158,11,0.12)", color: "#b45309" }}>{t("git.annotated")}</span>}
          <span style={{ color: "var(--text-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tag.subject}</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 2, alignItems: "center", flexShrink: 0 }}>
            <span style={{ color: "var(--text-dim)", fontSize: 10.5, fontFamily: "var(--font-mono)" }}>{tag.commitShortHash.slice(0, 7)}</span>
            <span style={{ color: "var(--text-dim)", fontSize: 10.5 }}>{new Date(tag.timestamp * 1000).toLocaleDateString()}</span>
            {confirmDelete === tag.name
              ? <button type="button" onClick={() => { setConfirmDelete(null); void act({ op: "tagDelete", name: tag.name }, t("git.tagDeleted")); }} style={{ border: "none", background: "none", color: "#dc2626", cursor: "pointer", fontSize: 11 }}>{t("common.ok")}</button>
              : <button type="button" onClick={() => setConfirmDelete(tag.name)} style={{ border: "none", background: "none", color: "#dc2626", cursor: "pointer", fontSize: 11 }}>{t("git.delete")}</button>}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Stash ────────────────────────────────────────────────────────────────────

export function GitStashTab({ cwd, refreshKey, onRefresh, onNotify }: TabProps) {
  const { t } = useI18n();
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "stashList", cwd }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setStashes(body.stashes as GitStashEntry[]);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setLoading(false);
    }
  }, [cwd, onNotify]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const act = useCallback(async (payload: Record<string, unknown>, done: string) => {
    try {
      const response = await fetch("/api/git", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, ...payload }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      onNotify(done);
      onRefresh();
      await load();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : String(error), true);
    }
  }, [cwd, load, onNotify, onRefresh]);

  return (
    <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
        <input
          value={message} onChange={(event) => setMessage(event.target.value)}
          placeholder={t("git.stashMessage")}
          style={{ flex: 1, minWidth: 0, border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", fontSize: 12, background: "var(--bg)", color: "var(--text)" }}
        />
        <button
          type="button"
          onClick={() => {
            void act({ op: "stashSave", ...(message.trim() ? { message: message.trim() } : {}) }, t("git.stashed")).then(() => setMessage(""));
          }}
          style={{ border: "1px solid var(--border)", background: "var(--bg)", color: "var(--accent)", borderRadius: 8, padding: "6px 13px", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}
        >
          {t("git.stashSave")}
        </button>
      </div>
      {loading && <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>…</div>}
      {!loading && stashes.length === 0 && (
        <div style={{ padding: 20, color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>{t("git.noStashes")}</div>
      )}
      {!loading && stashes.map((stash) => (
        <div key={stash.index} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-dim)", flexShrink: 0 }}>@{stash.index}</span>
          <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{stash.message}</span>
          <span style={{ color: "var(--text-dim)", fontSize: 10.5, flexShrink: 0 }}>{new Date(stash.timestamp * 1000).toLocaleString()}</span>
          <span style={{ display: "flex", gap: 2, flexShrink: 0 }}>
            <button type="button" onClick={() => void act({ op: "stashPop", index: stash.index }, t("git.stashPopped"))} style={{ border: "none", background: "none", color: "var(--accent)", cursor: "pointer", fontSize: 11 }}>{t("git.pop")}</button>
            <button type="button" onClick={() => void act({ op: "stashDrop", index: stash.index }, t("git.stashDropped"))} style={{ border: "none", background: "none", color: "#dc2626", cursor: "pointer", fontSize: 11 }}>{t("git.drop")}</button>
          </span>
        </div>
      ))}
    </div>
  );
}
