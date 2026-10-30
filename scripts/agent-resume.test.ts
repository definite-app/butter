// Unit tests for resuming agents with the flags they ran with. Run: npm run test:composer
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentArgsFromArgv,
  agentFlagsFromArgv,
  agentToResumeOnReopen,
  buildAgentResumeCommand,
  claudeFlagsFromArgs,
  codexLaunchFlags,
} from "../src/utils/agentResume.ts";
import type { SessionAgentInfo } from "../src/app/types.ts";

const SKIP = "--dangerously-skip-permissions";

test("claude flags from a live argv", () => {
  assert.deepEqual(agentFlagsFromArgv("claude", ["claude", SKIP]), [SKIP]);
  assert.deepEqual(agentFlagsFromArgv("claude", ["claude", "--resume", "abc", SKIP]), [SKIP]);
  assert.deepEqual(
    agentFlagsFromArgv("claude", ["/opt/homebrew/bin/claude", "--model", "opus", "fix the bug"]),
    ["--model", "opus"]
  );
  assert.deepEqual(agentFlagsFromArgv("claude", ["node", "/x/cli.js", SKIP]), [SKIP]);
  assert.deepEqual(
    agentFlagsFromArgv("claude", ["node", "--no-warnings", "/opt/homebrew/bin/claude", "-c", SKIP]),
    [SKIP]
  );
  // Native installs exec a versioned binary.
  assert.deepEqual(
    agentFlagsFromArgv("claude", ["/Users/me/.local/share/claude/versions/2.1.0", SKIP]),
    [SKIP]
  );
  assert.deepEqual(agentFlagsFromArgv("claude", ["claude"]), []);
});

test("claude argv that isn't a conversation", () => {
  assert.equal(agentFlagsFromArgv("claude", null), null);
  assert.equal(agentFlagsFromArgv("claude", []), null);
  assert.equal(agentFlagsFromArgv("claude", ["vim", "notes.md"]), null);
  assert.equal(agentFlagsFromArgv("claude", ["claude", "mcp", "serve"]), null);
  assert.equal(agentArgsFromArgv("claude", ["node"]), null);
});

test("claude drops conversation and launch-only options, keeps the rest", () => {
  assert.deepEqual(
    claudeFlagsFromArgs([
      "-r", "abc", "--session-id", "u-1", "--fork-session", "-c", "-p", "--worktree", "wt",
      "--permission-mode", "plan", "--add-dir", "/a", "/b", "--mcp-config", "m.json",
      "--model=sonnet", SKIP, "--verbose", "hello there",
    ]),
    ["--permission-mode", "plan", "--add-dir", "/a", "/b", "--mcp-config", "m.json", "--model=sonnet", SKIP, "--verbose"]
  );
  // `--resume` without an id (picker) doesn't swallow the next flag.
  assert.deepEqual(claudeFlagsFromArgs(["--resume", SKIP]), [SKIP]);
  // A prompt after a boolean flag or a known value is dropped.
  assert.deepEqual(claudeFlagsFromArgs([SKIP, "fix it"]), [SKIP]);
  assert.deepEqual(claudeFlagsFromArgs(["--effort", "high", "fix it"]), ["--effort", "high"]);
  // An unknown flag keeps the word after it as its value.
  assert.deepEqual(claudeFlagsFromArgs(["--new-thing", "x", SKIP]), ["--new-thing", "x", SKIP]);
  // Everything after `--` is the prompt.
  assert.deepEqual(claudeFlagsFromArgs([SKIP, "--", "--model", "x"]), [SKIP]);
});

test("codex flags from a live argv", () => {
  assert.deepEqual(
    agentFlagsFromArgv("codex", ["codex", "--dangerously-bypass-approvals-and-sandbox", "fix it"]),
    ["--dangerously-bypass-approvals-and-sandbox"]
  );
  assert.deepEqual(
    agentFlagsFromArgv("codex", [
      "/opt/homebrew/bin/codex", "resume", "019a-id", "--search", "-m", "gpt-5", "-c", "model_reasoning_effort=high",
    ]),
    ["--search", "-m", "gpt-5", "-c", "model_reasoning_effort=high"]
  );
  assert.deepEqual(
    agentFlagsFromArgv("codex", ["node", "/opt/homebrew/bin/codex", "--enable", "multi_agent"]),
    ["--enable", "multi_agent"]
  );
  assert.equal(agentFlagsFromArgv("codex", ["codex", "exec", "--json", "do it"]), null);
  // The launch-command parser shares the logic.
  assert.deepEqual(codexLaunchFlags("codex --search 'fix the bug'"), ["--search"]);
});

const info = (overrides: Partial<SessionAgentInfo>): SessionAgentInfo => ({
  kind: "claude",
  agentSessionId: "abc",
  cwd: null,
  lastSeenAt: 1,
  ...overrides,
});

test("resume uses the recorded flags (alias launch, hand-typed in a shell)", () => {
  assert.equal(
    buildAgentResumeCommand(info({ command: "cc", flags: [SKIP] })),
    `claude --resume abc ${SKIP}`
  );
  assert.equal(
    buildAgentResumeCommand(info({ command: null, flags: ["--model", "opus 4", SKIP] })),
    `claude --resume abc --model 'opus 4' ${SKIP}`
  );
  // The launch command has the same flag: no duplicate.
  assert.equal(
    buildAgentResumeCommand(info({ command: `claude ${SKIP}`, flags: [SKIP] })),
    `claude --resume abc ${SKIP}`
  );
  // Recorded empty flags win over the launch command's (claude was restarted without them).
  assert.equal(buildAgentResumeCommand(info({ command: `claude ${SKIP}`, flags: [] })), "claude --resume abc");
  assert.equal(
    buildAgentResumeCommand(info({ kind: "codex", agentSessionId: "019a", command: "cx", flags: ["--search"] })),
    "codex resume 019a --search"
  );
  assert.equal(
    buildAgentResumeCommand(info({ kind: "codex", agentSessionId: null, flags: ["--search"] })),
    "codex resume --search"
  );
});

test("resume falls back to the launch command's flags when none were recorded", () => {
  assert.equal(buildAgentResumeCommand(info({ command: `claude ${SKIP}` })), `claude --resume abc ${SKIP}`);
  assert.equal(buildAgentResumeCommand(info({ command: "cc", flags: null })), "claude --resume abc");
  // The prompt and an earlier --resume aren't carried over.
  assert.equal(
    buildAgentResumeCommand(info({ command: `claude --resume old ${SKIP} "fix it"` })),
    `claude --resume abc ${SKIP}`
  );
  // Shell syntax is kept verbatim.
  assert.equal(
    buildAgentResumeCommand(info({ command: 'claude --append-system-prompt "$(cat x.md)"' })),
    'claude --resume abc --append-system-prompt "$(cat x.md)"'
  );
  assert.equal(
    buildAgentResumeCommand(info({ kind: "codex", agentSessionId: "019a", command: "codex --search hi" })),
    "codex resume 019a --search"
  );
  assert.equal(buildAgentResumeCommand(info({ agentSessionId: null, command: "cc" })), "cc");
  // Recorded flags too long to type into a fresh tty use the launch command.
  assert.equal(
    buildAgentResumeCommand(
      info({ command: `claude ${SKIP}`, flags: ["--append-system-prompt", "x".repeat(2000), SKIP] })
    ),
    `claude --resume abc ${SKIP}`
  );
});

test("Cmd+Shift+T resumes an agent that was live at close", () => {
  const row = (overrides: Partial<Parameters<typeof agentToResumeOnReopen>[0]>) => ({
    agent_kind: "claude",
    agent_last_seen_at: 1000,
    closed_at: 1030,
    command: "cc",
    ...overrides,
  });
  // Launched through an alias, or typed in a plain shell: resume anyway.
  assert.equal(agentToResumeOnReopen(row({}), 90), "claude");
  assert.equal(agentToResumeOnReopen(row({ command: null }), 90), "claude");
  assert.equal(agentToResumeOnReopen(row({ command: "claude" }), 90), "claude");
  assert.equal(agentToResumeOnReopen(row({ agent_kind: "codex", command: "cx" }), 90), "codex");
  // No agent live near close: reopen as it was.
  assert.equal(agentToResumeOnReopen(row({ closed_at: 1200 }), 90), null);
  assert.equal(agentToResumeOnReopen(row({ agent_last_seen_at: null }), 90), null);
  assert.equal(agentToResumeOnReopen(row({ agent_kind: null }), 90), null);
  // Remote transports re-run their command.
  assert.equal(agentToResumeOnReopen(row({ command: 'ssh -t box "claude"' }), 90), null);
  assert.equal(agentToResumeOnReopen(row({ command: "/usr/bin/mosh box -- codex" }), 90), null);
});
