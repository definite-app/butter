import type { AgentKind, SessionAgentInfo } from "../app/types";

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
  return codexFlagsFromArgs(words.slice(1));
}

/** `codexLaunchFlags` for the words after `codex` (a command line or a live argv). */
export function codexFlagsFromArgs(args: readonly string[]): string[] | null {
  let rest = args;
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

// Claude options, from `claude --help`. Commander parses them, so a value is
// taken the way commander takes it:
// - required `<v>`: the next word, whatever it is;
const CLAUDE_VALUE_OPTIONS = new Set([
  "--agent", "--agents", "--append-system-prompt", "--append-system-prompt-file", "--autocompact",
  "--debug-file", "--effort", "--environment", "--fallback-model", "--input-format", "--json-schema",
  "--max-budget-usd", "--max-turns", "--model", "-n", "--name", "--output-format", "--permission-mode",
  "--permission-prompt-tool", "--permission-prompts", "--plugin-dir", "--plugin-url",
  "--remote-control-session-name-prefix", "--session-id", "--setting-sources", "--settings",
  "--system-prompt", "--system-prompt-file", "--system-prompt-snapshot",
]);
// - variadic `<v...>`: every following word up to the next option (so a
//   prompt right after one of these is eaten by it, by claude too);
const CLAUDE_VARIADIC_OPTIONS = new Set([
  "--add-dir", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
  "--betas", "--file", "--mcp-config", "--tools",
]);
// - optional `[v]`: the next word unless it starts with "-".
const CLAUDE_OPTIONAL_VALUE_OPTIONS = new Set([
  "-d", "--debug", "--cloud", "--from-pr", "--prompt-suggestions", "--remote-control",
  "-r", "--resume", "--teleport", "-w", "--worktree",
]);
// Options known to take no value: a word after one of these is the prompt.
const CLAUDE_BOOLEAN_OPTIONS = new Set([
  "--allow-dangerously-skip-permissions", "--ax-screen-reader", "--bare", "--bg", "--background",
  "--brief", "--chrome", "--no-chrome", "-c", "--continue", "--dangerously-skip-permissions",
  "--desktop", "--disable-slash-commands", "--exclude-dynamic-system-prompt-sections",
  "--fork-session", "--forward-subagent-text", "-h", "--help", "--ide", "--include-hook-events",
  "--include-partial-messages", "--mcp-debug", "--no-session-persistence", "-p", "--print",
  "--replay-user-messages", "--restricted", "--safe-mode", "--strict-mcp-config", "--tmux",
  "--verbose", "-v", "--version",
]);
// Dropped from a resume: they pick or fork the conversation (the resume names
// it), make the run one-shot, or only make sense when first launching.
const CLAUDE_DROP_OPTIONS = new Set([
  "-r", "--resume", "-c", "--continue", "--session-id", "--fork-session", "-p", "--print",
  "--from-pr", "--teleport", "--cloud", "-w", "--worktree", "--tmux", "--bg", "--background",
  "--desktop", "-h", "--help", "-v", "--version",
]);
const CLAUDE_SUBCOMMANDS = new Set([
  "agents", "attach", "auth", "auto-mode", "config", "doctor", "gateway", "import", "install",
  "logs", "mcp", "migrate-installer", "plugin", "plugins", "purge", "respawn", "rm", "setup-token",
  "stop", "kill", "ultrareview", "update", "upgrade",
]);

/**
 * Keep the flags a `claude` run was started with, given the words after
 * `claude`, and drop what's specific to that run: the conversation it picked
 * (`--resume/-r [id]`, `--continue/-c`, `--session-id <id>`,
 * `--fork-session`), one-shot `-p/--print`, launch-only options (`--worktree`,
 * `--bg`, …) and the positional prompt. Returns null for a subcommand
 * (`claude mcp …`), which isn't a conversation.
 *
 * Positionals are the prompt only when they can't be a flag's value: after a
 * known boolean flag, or after a known option's value. An unknown flag keeps
 * the word after it as its value, so a flag Butter doesn't know about yet is
 * never split from its value (at worst a prompt survives into the resume).
 */
export function claudeFlagsFromArgs(args: readonly string[]): string[] | null {
  const flags: string[] = [];
  let sawPositional = false;
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i];
    if (word === "--") break; // everything after is the prompt
    if (!word.startsWith("-") || word === "-") {
      if (!sawPositional && CLAUDE_SUBCOMMANDS.has(word)) return null;
      sawPositional = true; // the prompt
      continue;
    }
    const eq = word.indexOf("=");
    const name = eq > 0 && word.startsWith("--") ? word.slice(0, eq) : word;
    const inlineValue = name !== word;
    const taken: string[] = [word];
    if (!inlineValue) {
      const next = (j: number) => (j < args.length ? args[j] : undefined);
      if (CLAUDE_VALUE_OPTIONS.has(name)) {
        if (next(i + 1) !== undefined) taken.push(args[++i]);
      } else if (CLAUDE_VARIADIC_OPTIONS.has(name)) {
        while (next(i + 1) !== undefined && !args[i + 1].startsWith("-")) taken.push(args[++i]);
      } else if (CLAUDE_OPTIONAL_VALUE_OPTIONS.has(name)) {
        if (next(i + 1) !== undefined && !args[i + 1].startsWith("-")) taken.push(args[++i]);
      } else if (!CLAUDE_BOOLEAN_OPTIONS.has(name)) {
        // Unknown: the next non-option word may be its value; keep it.
        if (next(i + 1) !== undefined && !args[i + 1].startsWith("-")) taken.push(args[++i]);
      }
    }
    if (!CLAUDE_DROP_OPTIONS.has(name)) flags.push(...taken);
  }
  return flags;
}

const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno"]);
const baseName = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/**
 * The words after the agent program in a live process's argv:
 * `claude …`, `/opt/homebrew/bin/claude …`, `node /x/cli.js …` (an npm
 * install, whose script path may not say claude) or a native install's
 * versioned binary (`…/claude/versions/2.1.0 …`). Null when argv doesn't look
 * like that agent.
 */
export function agentArgsFromArgv(kind: AgentKind, argv: readonly string[]): string[] | null {
  if (argv.length === 0) return null;
  const program = baseName(argv[0]);
  if (program === kind) return argv.slice(1);
  if (INTERPRETERS.has(program)) {
    // `node [node options] <script> <args>`: the script is the first non-option.
    const script = argv.findIndex((word, i) => i > 0 && !word.startsWith("-"));
    return script > 0 ? argv.slice(script + 1) : null;
  }
  if (argv[0].toLowerCase().includes(kind)) return argv.slice(1);
  return null;
}

/**
 * The flags to keep on resume from the argv of the agent process running in a
 * terminal (read by the activity poll). Null when argv couldn't be matched.
 */
export function agentFlagsFromArgv(
  kind: AgentKind,
  argv: readonly string[] | null | undefined
): string[] | null {
  if (!argv) return null;
  const args = agentArgsFromArgv(kind, argv);
  if (!args) return null;
  return kind === "claude" ? claudeFlagsFromArgs(args) : codexFlagsFromArgs(args);
}

// Typed into a shell that may not have started its line editor yet, so the
// tty's canonical line limit (1024 bytes on macOS) applies. Recorded flags
// that would push the resume past this (a long --append-system-prompt, say)
// fall back to the launch command's flags.
const MAX_RESUME_COMMAND_CHARS = 900;
// Expansions, substitutions and operators a launch command may use.
const SHELL_SYNTAX = /[$`|;&<>()*?~!{}]/;

/**
 * Build the shell command that resumes (or relaunches) an agent. Prefers
 * continuing the exact prior conversation while keeping the flags the agent
 * really ran with (e.g. --dangerously-skip-permissions, --search): the ones
 * recorded from the live process (`info.flags`), else those in the launch
 * command, which misses flags hidden behind an alias like `cc`.
 */
export function buildAgentResumeCommand(info: SessionAgentInfo): string {
  if (info.flags) {
    const recorded = buildResumeWithFlags(info, info.flags);
    if (recorded.length <= MAX_RESUME_COMMAND_CHARS) return recorded;
  }
  const original = info.command?.trim() ?? "";
  if (info.kind === "claude") {
    if (!info.agentSessionId) return original || "claude";
    if (!/^claude(\s|$)/.test(original)) return buildResumeWithFlags(info, []);
    // A plain word list: keep its flags, minus a prompt or an earlier --resume.
    const parsed = SHELL_SYNTAX.test(original)
      ? null
      : claudeFlagsFromArgs(splitShellWords(original).slice(1));
    if (parsed) return buildResumeWithFlags(info, parsed);
    // Shell syntax (e.g. "$(cat prompt.md)") would not survive word splitting:
    // insert `--resume <id>` right after `claude` and keep the rest verbatim.
    const rest = original.replace(/^claude\s*/, "");
    return `claude --resume ${shellQuoteWord(info.agentSessionId)}${rest ? ` ${rest}` : ""}`;
  }
  return buildResumeWithFlags(info, codexLaunchFlags(original) ?? []);
}

function buildResumeWithFlags(info: SessionAgentInfo, flags: readonly string[]): string {
  const quoted = flags.map(shellQuoteWord);
  if (info.kind === "claude") {
    const parts = ["claude"];
    if (info.agentSessionId) parts.push("--resume", shellQuoteWord(info.agentSessionId));
    return [...parts, ...quoted].join(" ");
  }
  // codex: `codex resume [<id>] <flags>`. Without a known id, open Codex's
  // resume picker (scoped to the cwd) rather than guessing with `--last`,
  // which may pick another terminal's conversation.
  const parts = ["codex", "resume"];
  if (info.agentSessionId) parts.push(shellQuoteWord(info.agentSessionId));
  return [...parts, ...quoted].join(" ");
}

/** Mirrors `REMOTE_TRANSPORTS` in src-tauri/src/lib.rs. */
const REMOTE_TRANSPORTS = new Set([
  "ssh", "autossh", "mosh", "mosh-client", "et", "tailscale", "aws", "session-manager-plugin",
]);

/** The agent snapshot fields of a closed terminal's DB row. */
export interface ClosedAgentSnapshot {
  agent_kind: string | null;
  agent_last_seen_at: number | null;
  closed_at: number | null;
  command: string | null;
}

/**
 * Whether reopening a closed terminal (Cmd+Shift+T, Recently Closed) should
 * resume its agent's conversation rather than re-run the launch command, and
 * which agent. Yes when an agent was live within `liveAtCloseSecs` of the
 * close, however the terminal was launched (`cc`, a plain shell, a preset).
 * Terminals without a live agent near close reopen as they were, and a
 * remote launch (ssh …) re-runs its command, which reattaches remotely.
 */
export function agentToResumeOnReopen(
  row: ClosedAgentSnapshot,
  liveAtCloseSecs: number
): AgentKind | null {
  const kind = row.agent_kind;
  if (kind !== "claude" && kind !== "codex") return null;
  const launch = baseName(splitShellWords(row.command?.trim() ?? "")[0] ?? "");
  if (REMOTE_TRANSPORTS.has(launch)) return null;
  const lastSeen = row.agent_last_seen_at ?? 0;
  const closedAt = row.closed_at ?? 0;
  // The agent snapshot is refreshed at least every 30s while it runs.
  if (!lastSeen || (closedAt && closedAt - lastSeen > liveAtCloseSecs)) return null;
  return kind;
}
