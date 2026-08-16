"use client";

/**
 * VS Code-style Git sidebar: replaces the session sidebar while active.
 * Changed files open their diff in the right file panel (pi-web's built-in
 * viewer); history/commit diffs go through the same viewer pinned to a ref.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { GitFileStatus, GitRepoInfo } from "@/lib/git/types";
import { GitStatusBadge } from "./git-diff";
import { GitGraph } from "./git-graph";
import { GitBranchesTab, GitRemotesTab, GitStashTab, GitTagsTab } from "./git-refs";

type GitView = "changes" | "history" | "branches" | "remotes" | "tags" | "stash";

const VIEW_ORDER: { id: GitView; labelKey: string; icon: React.ReactNode }[] = [
  {
    id: "changes", labelKey: "git.tab.changes",
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M6 9v6" /><path d="M15 6h.01" /><path d="M18 9h.01" /><path d="M15 12h.01" /><path d="M18 15h.01" /><path d="M15 18h.01" /></svg>,
  },
  {
    id: "history", labelKey: "git.tab.history",
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></svg>,
  },
  {
    id: "branches", labelKey: "git.tab.branches",
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>,
  },
  {
    id: "remotes", labelKey: "git.tab.remotes",
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.6" y1="13.5" x2="15.4" y2="17.5" /><line x1="15.4" y1="6.5" x2="8.6" y2="10.5" /></svg>,
  },
  {
    id: "tags", labelKey: "git.tab.tags",
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 2H2v10l9.3 9.3a2 2 0 0 0 2.8 0l7.2-7.2a2 2 0 0 0 0-2.8L12 2Z" /><circle cx="7" cy="7" r="1.5" /></svg>,
  },
  {
    id: "stash", labelKey: "git.tab.stash",
    icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 8v13H3V8" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" /></svg>,
  },
];

type GitSidebarProps = {
  cwd: string | null;
  borrowSessionId: string | null;
  /** Open a file's diff in the right panel; ref pins it to a commit. */
  onOpenDiff: (absolutePath: string, fileName: string, ref?: string | null) => void;
};

const AI_MODEL_STORAGE_KEY = "pi-git-ai-model";

type ModelOption = { id: string; name: string; provider: string };

export function GitSidebar({ cwd, borrowSessionId, onOpenDiff }: GitSidebarProps) {
  const { t } = useI18n();
  const [view, setView] = useState<GitView>("changes");
  const [repo, setRepo] = useState<GitRepoInfo | null>(null);
  const [repoChecked, setRepoChecked] = useState(false);
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState<{ message: string; isError: boolean } | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [aiModel, setAiModel] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(AI_MODEL_STORAGE_KEY) ?? "";
  });
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOption[] | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((message: string, isError = false) => {
    setNotice({ message, isError });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), isError ? 6000 : 2600);
  }, []);

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  useEffect(() => {
    setRepoChecked(false);
    setRepo(null);
    setFiles([]);
    setRefreshKey((key) => key + 1);
  }, [cwd]);

  const gitFetch = useCallback(async <T,>(payload: Record<string, unknown>): Promise<T> => {
    const response = await fetch("/api/git", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, ...payload }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body as T;
  }, [cwd]);

  useEffect(() => {
    if (!cwd) return;
    void gitFetch({ op: "status" })
      .then((body) => {
        const data = body as { repo: GitRepoInfo | null; files?: GitFileStatus[] };
        setRepo(data.repo);
        setFiles(data.files ?? []);
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : String(error), true))
      .finally(() => setRepoChecked(true));
  }, [gitFetch, notify, refreshKey, cwd]);

  const act = useCallback(async (payload: Record<string, unknown>, done?: string) => {
    setBusy(String(payload.op));
    try {
      await gitFetch(payload);
      if (done) notify(done);
      setRefreshKey((key) => key + 1);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(null);
    }
  }, [gitFetch, notify]);

  const sync = useCallback(async (op: "fetch" | "pull" | "push") => {
    setBusy(op);
    try {
      const result = await gitFetch({ op }) as { output?: string };
      const output = (result.output ?? "").split("\n").filter(Boolean).slice(-2).join(" · ");
      notify(output || t(`git.${op}Done`));
      setRefreshKey((key) => key + 1);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(null);
    }
  }, [gitFetch, notify, t]);

  const generateMessage = useCallback(async () => {
    setAiLoading(true);
    try {
      const [provider, ...rest] = aiModel ? aiModel.split(":") : [];
      const body = await gitFetch({
        op: "aiCommitMessage",
        borrowSessionId,
        ...(provider && rest.length > 0 ? { modelProvider: provider, modelId: rest.join(":") } : {}),
      }) as { message: string; model?: { provider: string; id: string } | null };
      setCommitMessage(body.message);
      if (body.model) {
        const option = modelOptions?.find((m) => m.provider === body.model!.provider && m.id === body.model!.id);
        notify(`${t("git.aiMessage")}: ${option?.name || body.model.id}`);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      setAiLoading(false);
    }
  }, [aiModel, borrowSessionId, gitFetch, modelOptions, notify, t]);

  // Model list for the AI-message picker — loaded lazily on first open.
  useEffect(() => {
    if (!modelMenuOpen || modelOptions) return;
    fetch("/api/models", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        setModelOptions((body.modelList ?? []) as ModelOption[]);
      })
      .catch(() => setModelOptions([]));
  }, [modelMenuOpen, modelOptions]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-git-ai-model-menu]")) setModelMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [modelMenuOpen]);

  const selectedModelOption = useMemo(() => {
    if (!aiModel || !modelOptions) return null;
    const [provider, ...rest] = aiModel.split(":");
    return modelOptions.find((m) => m.provider === provider && m.id === rest.join(":")) ?? null;
  }, [aiModel, modelOptions]);

  const stagedFiles = useMemo(() => files.filter((file) => file.staged), [files]);
  const unstagedFiles = useMemo(() => files.filter((file) => !file.staged && !file.untracked), [files]);
  const untrackedFiles = useMemo(() => files.filter((file) => file.untracked), [files]);

  const openDiff = useCallback((relPath: string, ref?: string | null) => {
    if (!repo) return;
    const absolute = `${repo.root}/${relPath}`;
    onOpenDiff(absolute, relPath.split("/").pop() ?? relPath, ref ?? null);
  }, [onOpenDiff, repo]);

  const fileRow = (file: GitFileStatus, stagedList: boolean) => {
    const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
    const base = file.path.slice(dir.length);
    return (
      <div
        key={`${file.code}-${file.path}`}
        onClick={() => openDiff(file.oldPath ?? file.path)}
        style={{
          display: "flex", alignItems: "center", gap: 6, padding: "3px 10px",
          cursor: "pointer", fontSize: 11.5, fontFamily: "var(--font-mono)",
        }}
        onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      >
        <GitStatusBadge status={stagedList ? file.code[0] : file.code === "??" ? "U" : file.code[1]} />
        <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{dir}</span>
        <span style={{ color: "var(--text)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {base}
        </span>
        <span style={{ display: "flex", gap: 1, flexShrink: 0 }}>
          <button
            type="button"
            title={stagedList ? t("git.unstage") : t("git.stage")}
            onClick={(event) => {
              event.stopPropagation();
              void act({ op: stagedList ? "unstage" : "stage", paths: [file.path] });
            }}
            style={{ border: "none", background: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "0 2px" }}
          >
            {stagedList ? "−" : "＋"}
          </button>
          <button
            type="button"
            title={file.untracked ? t("git.deleteFile") : t("git.discard")}
            onClick={(event) => {
              event.stopPropagation();
              if (window.confirm(file.untracked ? t("git.confirmDeleteFile", { path: file.path }) : t("git.confirmDiscard", { path: file.path }))) {
                void act({ op: "discard", paths: [file.path] });
              }
            }}
            style={{ border: "none", background: "none", color: "#dc2626", cursor: "pointer", fontSize: 10.5, padding: "0 2px", opacity: 0.75 }}
          >
            ✕
          </button>
        </span>
      </div>
    );
  };

  const section = (id: string, label: string, count: number, action: React.ReactNode, children: React.ReactNode) => {
    const isCollapsed = collapsed[id] ?? false;
    return (
      <div style={{ borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", fontSize: 10.5, color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, userSelect: "none" }}>
          <button
            type="button"
            onClick={() => setCollapsed((current) => ({ ...current, [id]: !isCollapsed }))}
            style={{ border: "none", background: "none", color: "var(--text-muted)", cursor: "pointer", padding: 0, fontSize: 9, width: 12 }}
          >
            {isCollapsed ? "▸" : "▾"}
          </button>
          <span>{label}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontWeight: 400 }}>{count}</span>
          {!isCollapsed && action}
        </div>
        {!isCollapsed && children}
      </div>
    );
  };

  const stageAllAction = (list: GitFileStatus[], op: "stage" | "unstage") => (
    <button
      type="button"
      onClick={() => void act({ op, paths: list.map((file) => file.path) })}
      title={op === "stage" ? t("git.stageAll") : t("git.unstageAll")}
      style={{ marginLeft: "auto", border: "none", background: "none", color: "var(--accent)", cursor: "pointer", fontSize: 11, padding: 0 }}
    >
      {op === "stage" ? "＋" : "−"}
    </button>
  );

  const renderChanges = () => (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
      {/* commit box */}
      <div style={{ padding: 10, borderBottom: "1px solid var(--border)" }}>
        <textarea
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          placeholder={t("git.commitPlaceholder")}
          rows={2}
          style={{
            width: "100%", resize: "none", border: "1px solid var(--border)", borderRadius: 8,
            padding: "6px 8px", fontSize: 11.5, background: "var(--bg)", color: "var(--text)",
            fontFamily: "var(--font-mono)", marginBottom: 6, boxSizing: "border-box",
          }}
        />
        <div style={{ display: "flex", gap: 6, alignItems: "center", position: "relative" }}>
          <button
            type="button"
            disabled={aiLoading || files.length === 0}
            onClick={() => void generateMessage()}
            title={selectedModelOption
              ? `${t("git.aiMessage")} · ${selectedModelOption.name}`
              : `${t("git.aiMessage")} · ${t("git.aiModelDefault")}`}
            style={{
              border: "1px solid var(--border)", background: "var(--bg)", color: "var(--accent)",
              borderRadius: 7, padding: "4px 8px", fontSize: 11, cursor: "pointer", flexShrink: 0,
            }}
          >
            {aiLoading ? "…" : "✨"}
          </button>
          <button
            type="button"
            data-git-ai-model-menu
            onClick={() => setModelMenuOpen((open) => !open)}
            title={t("git.aiModel")}
            aria-label={t("git.aiModel")}
            style={{
              border: "1px solid var(--border)", background: modelMenuOpen || aiModel ? "var(--bg-subtle)" : "var(--bg)",
              color: "var(--text-muted)", borderRadius: 7, padding: "4px 7px", fontSize: 11,
              cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </button>
          {modelMenuOpen && (
            <div
              data-git-ai-model-menu
              style={{
                position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 40,
                background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10,
                boxShadow: "0 8px 28px rgba(0,0,0,0.2)", padding: 10,
              }}
            >
              <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginBottom: 6 }}>
                {t("git.aiModel")}
              </div>
              <select
                value={aiModel}
                onChange={(event) => {
                  setAiModel(event.target.value);
                  window.localStorage.setItem(AI_MODEL_STORAGE_KEY, event.target.value);
                }}
                style={{
                  width: "100%", border: "1px solid var(--border)", borderRadius: 7,
                  padding: "5px 6px", fontSize: 11, background: "var(--bg)", color: "var(--text)",
                }}
              >
                <option value="">{t("git.aiModelDefault")}</option>
                {modelOptions === null && <option disabled>…</option>}
                {modelOptions !== null && (() => {
                  const byProvider = new Map<string, ModelOption[]>();
                  for (const option of modelOptions) {
                    const list = byProvider.get(option.provider) ?? [];
                    list.push(option);
                    byProvider.set(option.provider, list);
                  }
                  return [...byProvider.entries()].map(([provider, options]) => (
                    <optgroup key={provider} label={provider}>
                      {options.map((option) => (
                        <option key={`${option.provider}:${option.id}`} value={`${option.provider}:${option.id}`}>
                          {option.name || option.id}
                        </option>
                      ))}
                    </optgroup>
                  ));
                })()}
              </select>
            </div>
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10.5, color: "var(--text-muted)", cursor: "pointer", flexShrink: 0 }} title={t("git.amend")}>
            <input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} style={{ margin: 0 }} />
            {t("git.amend")}
          </label>
          <button
            type="button"
            disabled={files.length === 0 || !commitMessage.trim() || busy === "commit"}
            onClick={() => {
              // VS Code semantics: with nothing staged, commit everything;
              // with staged files, commit exactly the index.
              const commitAll = stagedFiles.length === 0;
              void act({ op: "commit", message: commitMessage, amend, ...(commitAll ? { all: true } : {}) }, t("git.committed"))
                .then(() => setCommitMessage(""));
            }}
            style={{
              marginLeft: "auto", border: "none", borderRadius: 7, padding: "4px 12px", fontSize: 11, fontWeight: 600,
              background: files.length > 0 && commitMessage.trim() ? "var(--accent)" : "var(--bg-subtle)",
              color: files.length > 0 && commitMessage.trim() ? "#fff" : "var(--text-dim)",
              cursor: files.length > 0 && commitMessage.trim() ? "pointer" : "default", whiteSpace: "nowrap",
            }}
          >
            {stagedFiles.length > 0
              ? `${t("git.commit")} (${stagedFiles.length})`
              : `${t("git.commitAll")} (${files.length})`}
          </button>
        </div>
      </div>
      {/* file sections */}
      {stagedFiles.length > 0 && section("staged", t("git.staged"), stagedFiles.length, stageAllAction(stagedFiles, "unstage"),
        stagedFiles.map((file) => fileRow(file, true)))}
      {unstagedFiles.length > 0 && section("changes", t("git.changes"), unstagedFiles.length, stageAllAction(unstagedFiles, "stage"),
        unstagedFiles.map((file) => fileRow(file, false)))}
      {untrackedFiles.length > 0 && section("untracked", t("git.untracked"), untrackedFiles.length, stageAllAction(untrackedFiles, "stage"),
        untrackedFiles.map((file) => fileRow(file, false)))}
      {files.length === 0 && (
        <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 11.5 }}>
          {t("git.cleanTree")}
        </div>
      )}
    </div>
  );

  const renderBody = () => {
    if (!cwd) {
      return <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 11.5 }}>{t("git.noProject")}</div>;
    }
    if (!repoChecked) {
      return <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 11.5 }}>…</div>;
    }
    if (!repo) {
      return <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 11.5 }}>{t("git.notARepo")}</div>;
    }
    switch (view) {
      case "changes": return renderChanges();
      case "history": return <GitGraph cwd={cwd} refreshKey={refreshKey} onNotify={notify} onOpenFile={openDiff} />;
      case "branches": return <GitBranchesTab cwd={cwd} refreshKey={refreshKey} onRefresh={() => setRefreshKey((key) => key + 1)} onNotify={notify} />;
      case "remotes": return <GitRemotesTab cwd={cwd} refreshKey={refreshKey} onRefresh={() => setRefreshKey((key) => key + 1)} onNotify={notify} />;
      case "tags": return <GitTagsTab cwd={cwd} refreshKey={refreshKey} onRefresh={() => setRefreshKey((key) => key + 1)} onNotify={notify} />;
      case "stash": return <GitStashTab cwd={cwd} refreshKey={refreshKey} onRefresh={() => setRefreshKey((key) => key + 1)} onNotify={notify} />;
    }
  };

  const headerButton = (label: string, onClick: () => void, disabled: boolean, spinning: boolean, children: React.ReactNode, title?: string) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 24, height: 24, borderRadius: 6, padding: 0,
        background: "none", border: "none",
        color: disabled ? "var(--text-dim)" : "var(--text-muted)",
        cursor: disabled ? "default" : "pointer", flexShrink: 0,
      }}
    >
      {spinning ? <span className="animate-spin" style={{ display: "inline-flex", fontSize: 11 }}>◌</span> : children}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0, position: "relative" }}>
      {/* Header: branch + sync */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {repo ? repo.branch : "—"}
        </span>
        {repo && (repo.ahead > 0 || repo.behind > 0) && (
          <span style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", flexShrink: 0, color: "var(--text-muted)" }}>
            ↑{repo.ahead} ↓{repo.behind}
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 1 }}>
          {headerButton(t("git.fetch"), () => void sync("fetch"), busy !== null || !repo, busy === "fetch",
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>)}
          {headerButton(t("git.pull"), () => void sync("pull"), busy !== null || !repo, busy === "pull",
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>)}
          {headerButton(t("git.push"), () => void sync("push"), busy !== null || !repo, busy === "push",
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 21V9" /><path d="m7 14 5-5 5 5" /><path d="M5 3h14" /></svg>)}
        </span>
      </div>

      {/* View switcher */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--border)", flexShrink: 0, overflowX: "auto" }}>
        {VIEW_ORDER.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setView(entry.id)}
            title={t(entry.labelKey)}
            style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
              padding: "7px 0", minWidth: 42, border: "none",
              borderBottom: view === entry.id ? "2px solid var(--accent)" : "2px solid transparent",
              background: view === entry.id ? "var(--bg-subtle)" : "none",
              color: view === entry.id ? "var(--text)" : "var(--text-dim)",
              cursor: "pointer", fontSize: 10.5,
            }}
          >
            {entry.icon}
          </button>
        ))}
      </div>

      {/* Body */}
      {renderBody()}

      {notice && (
        <div style={{
          position: "absolute", bottom: 10, left: 10, right: 10,
          background: notice.isError ? "rgba(220,38,38,0.94)" : "rgba(17,24,39,0.94)",
          color: "#fff", borderRadius: 8, padding: "7px 12px", fontSize: 11,
          boxShadow: "0 6px 24px rgba(0,0,0,0.25)", overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap", zIndex: 30,
        }}>
          {notice.message}
        </div>
      )}
    </div>
  );
}
