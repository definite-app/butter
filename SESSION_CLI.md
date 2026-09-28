# Creating agent sessions from the CLI

With this Butter build running:

```sh
~/.butter/bin/butter-cli session create \
  --directory "$HOME/mike3" --agent codex \
  --prompt 'Read AGENTS.md and summarize the project'
```

Use `--agent claude` for Claude Code. Omit the prompt for an interactive session.
For dictation or other programmatic callers, pass `--prompt-stdin` and write the
exact prompt to stdin. Prompts are single literal CLI arguments, including quotes,
newlines, dollar signs, or text that looks like flags. Optional `--title` sets the
tab title. This command works outside a Butter terminal; Team credentials are not
required.

Butter creates and selects a normal terminal tab using its existing session and
PTY path. A successful JSON response contains `status: "started"`, `session_id`,
and the PTY child `pid`. This confirms the terminal process exists, not that the
agent has authenticated or finished its prompt. The chosen agent must already be
installed and accessible in the terminal's login shell.

Finish Butter's startup restore picker before submitting requests. The CLI waits
20 seconds by default (`--timeout` accepts 1–55). On timeout it removes a pending
request and prints the session ID; inspect Butter before retrying because the
terminal may already have started. It never retries automatically.

The private local transport uses `~/.butter/session-requests` (directory mode 700,
files mode 600), scoped to an app run. Requests expire after 60 seconds, and a
previous app run's requests are rejected. The app removes handled requests; the
CLI removes consumed responses. Interrupted requests can contain the prompt until
the next app poll. The dev flavor uses `~/.butter-dev` and its own CLI instead.

## Verification

```sh
npm run build
python3 -m unittest discover -s scripts -p test_session_cli.py
cd src-tauri
cargo test --lib session_cli::tests
```

The Python tests exercise IPC with a simulated responder. Live acceptance still
requires launching the updated app, creating a session, and checking its directory
and initial prompt. A built app alone does not update the running application.
