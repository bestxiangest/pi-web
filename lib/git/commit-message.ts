/**
 * AI commit-message generation.
 *
 * Reuses the session-title mechanism: build a temporary Agent from an existing
 * session's provider config with shadowed (non-executable) tools, so the model
 * context is reused but nothing in the project can be mutated. The diff text is
 * supplied as the prompt; no repository data beyond it is sent.
 */
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { buildSessionTitleAgentOptions } from "@/lib/session-title";

const COMMIT_MESSAGE_TIMEOUT_MS = 120_000;
const MAX_DIFF_CHARS = 24_000;

/** Minimal model shape needed to override the borrowed agent's model. */
export type CommitMessageModelOverride = {
  provider: string;
  id: string;
  api: unknown;
  [key: string]: unknown;
};

const COMMIT_PROMPT = `Write a git commit message for the changes below.

Requirements:
- First line: a concise summary in imperative mood, max 72 characters, no trailing period.
- If the change needs explanation, add a blank line and a short body; wrap body lines at 72 characters.
- Match the primary language of the code comments and changes (English by default).
- Do not call any tools.
- Return ONLY the commit message as plain text: no quotes, no markdown fences, no labels, no explanation.

Diff:

`;

function stripWrappingQuotes(value: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["\u201c", "\u201d"],
  ];
  for (const [start, end] of pairs) {
    if (value.startsWith(start) && value.endsWith(end) && value.length > start.length + end.length) {
      return value.slice(start.length, value.length - end.length).trim();
    }
  }
  return value;
}

export function parseCommitMessage(raw: string): string {
  let value = raw.trim();
  const fenced = value.match(/^```(?:text|markdown)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) value = fenced[1].trim();
  value = stripWrappingQuotes(value);
  value = value.replace(/^(?:commit\s+message|message)\s*[:：-]\s*/i, "");
  const lines = value.split(/\r?\n/).map((line) => line.replace(/\s+$/, ""));
  const subject = (lines[0] ?? "").slice(0, 72).trim();
  const body = lines.slice(1).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const result = body ? `${subject}\n\n${body}` : subject;
  if (!/[\p{L}\p{N}]/u.test(result)) {
    throw new Error("The model did not return a usable commit message");
  }
  return result;
}

export async function generateCommitMessage(
  source: AgentSession,
  diff: string,
  modelOverride?: unknown,
): Promise<{ message: string; model: { provider: string; id: string } | null }> {
  const trimmedDiff = diff.length > MAX_DIFF_CHARS
    ? `${diff.slice(0, MAX_DIFF_CHARS / 2)}\n\n… (diff truncated)\n\n${diff.slice(-MAX_DIFF_CHARS / 2)}`
    : diff;

  const sourceAgent = source.agent;
  await sourceAgent.waitForIdle();

  const options = buildSessionTitleAgentOptions(sourceAgent);
  // The borrowed agent's streamFn/getApiKey dispatch dynamically by model and
  // provider, so swapping initialState.model is enough to change the model.
  if (modelOverride && typeof modelOverride === "object") {
    options.initialState!.model = modelOverride as never;
  }
  options.initialState!.messages = [{
    role: "user",
    content: `${COMMIT_PROMPT}${trimmedDiff}`,
    timestamp: Date.now(),
  } as never];

  const temporaryAgent = new Agent(options);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      temporaryAgent.prompt("Generate the commit message now."),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          temporaryAgent.abort();
          reject(new Error("Commit message generation timed out"));
        }, COMMIT_MESSAGE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    temporaryAgent.abort();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  for (let i = temporaryAgent.state.messages.length - 1; i >= 0; i--) {
    const message = temporaryAgent.state.messages[i];
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error") {
      throw new Error(message.errorMessage || "The model request failed");
    }
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) {
      const used = temporaryAgent.state.model as { provider?: string; id?: string } | undefined;
      return {
        message: parseCommitMessage(text),
        model: used?.provider && used?.id ? { provider: used.provider, id: used.id } : null,
      };
    }
  }
  throw new Error("The model did not return a commit message");
}
