import type { SessionAgentInfo } from "../app/types";

/** Split a shell command line into words (handles simple '…' / "…" quoting). */
export function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += command[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      current += command[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

/** Quote a word for a POSIX shell only when needed. */
export function shellQuoteWord(word: string): string {
  if (word !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

// Codex options that consume the next word as their value (`codex --help`).
const CODEX_VALUE_OPTIONS = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "-m",
  "--model",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-a",
  "--ask-for-approval",
  "-C",
  "--cd",
  "--add-dir",
  "--local-provider",
  "--remote",
  "--remote-auth-token-env",
]);
// Options that only make sense for the original launch, not a resume.
const CODEX_DROP_OPTIONS = new Set(["-i", "--image", "--last", "--all", "--worktree"]);
const CODEX_DROP_SUBCOMMANDS = new Set(["resume", "fork"]);
const CODEX_OTHER_SUBCOMMANDS = new Set([
  "agents", "exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server",
  "remote-control", "app", "completion", "update", "doctor", "sandbox", "debug", "apply",
  "a", "queue", "archive", "delete", "migrate-rollouts", "unarchive", "cloud",
  "exec-server", "features", "help",
]);

/**
 * Keep the option flags from a codex launch command (e.g.
 * `--dangerously-bypass-approvals-and-sandbox --enable multi_agent --search`)
 * and drop positionals: the initial prompt, and the id of an earlier
 * `codex resume <id>`. Returns null when the command isn't a plain `codex`.
 */
export function codexLaunchFlags(command: string | null | undefined): string[] | null {
  const words = splitShellWords(command?.trim() ?? "");
  if (words.length === 0 || words[0] !== "codex") return null;
  let rest = words.slice(1);
  if (rest.length > 0 && CODEX_DROP_SUBCOMMANDS.has(rest[0])) {
    rest = rest.slice(1);
  } else if (rest.length > 0 && CODEX_OTHER_SUBCOMMANDS.has(rest[0])) {
    return null; // e.g. `codex exec …`: its flags don't apply to a resume
  }
  const flags: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i];
    if (word === "--") break; // everything after is the prompt
    if (!word.startsWith("-") || word === "-") continue; // positional (prompt/id)
    const [name] = word.split("=", 1);
    const inlineValue = word.includes("=");
    if (CODEX_DROP_OPTIONS.has(name)) {
      if ((name === "-i" || name === "--image") && !inlineValue) {
        // Skip the image paths that follow.
        while (i + 1 < rest.length && !rest[i + 1].startsWith("-")) i += 1;
      }
      continue;
    }
    flags.push(word);
    if (CODEX_VALUE_OPTIONS.has(name) && !inlineValue && i + 1 < rest.length) {
      flags.push(rest[i + 1]);
      i += 1;
    }
  }
  return flags;
}

/**
 * Build the shell command that resumes (or relaunches) an agent. Prefers
 * continuing the exact prior conversation while keeping the user's original
 * launch flags (e.g. --dangerously-skip-permissions, --search).
 */
export function buildAgentResumeCommand(info: SessionAgentInfo): string {
  const original = info.command?.trim() ?? "";
  if (info.kind === "claude") {
    if (!info.agentSessionId) return original || "claude";
    // Insert `--resume <id>` right after `claude`, keeping the user's flags.
    const rest = /^claude(\s|$)/.test(original) ? original.replace(/^claude\s*/, "") : "";
    return `claude --resume ${shellQuoteWord(info.agentSessionId)}${rest ? ` ${rest}` : ""}`;
  }
  // codex: `codex resume [<id>] <original flags>`. Without a known id, open
  // Codex's resume picker (scoped to the cwd) rather than guessing with
  // `--last`, which may pick another terminal's conversation.
  const flags = (codexLaunchFlags(original) ?? []).map(shellQuoteWord);
  const parts = ["codex", "resume"];
  if (info.agentSessionId) parts.push(shellQuoteWord(info.agentSessionId));
  return [...parts, ...flags].join(" ");
}
