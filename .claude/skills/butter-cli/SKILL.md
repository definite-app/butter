---
name: butter-cli
description: How an agent running in a Butter terminal talks to Butter with `butter-cli`. Use to schedule a check-in for later (a routine: "check back on this in two weeks", "remind me on Oct 29", a blocker that needs a follow-up), to reply in Butter's 1thread chat, or to send, reply to and read Butter Team Mode messages and manage Team Mode users and channels.
---

# Butter CLI

## Requirements

`butter-cli` only works in a terminal Butter started. It needs these env vars, which Butter sets in every terminal:

```bash
BUTTER_SESSION_ID
BUTTER_TEAM_ENDPOINT
BUTTER_TEAM_TOKEN
```

If a command reports a missing env var, this shell wasn't started by Butter, and `butter-cli` can't be used here.

## Routines

A routine checks back on something later. When it's due, Butter starts a new agent with your prompt, in the same folder and with the same agent profile as this session. If this session is a 1thread conversation, the new agent joins it and sees the conversation so far. Otherwise it starts a new 1thread thread. Either way it's told this session's id and where its transcript is.

Use one when work is blocked on something that will change later (a benefit that isn't live yet, a reply you're waiting for, a deploy window), or when the user asks you to check back or remind them.

```bash
butter-cli routine create --in 2w "<prompt>"
butter-cli routine create --at 2026-10-29 "<prompt>"          # 9:00 local time
butter-cli routine create --at "2026-10-29 14:30" --title "parking benefit" "<prompt>"
```

`--in` takes `30m`, `4h`, `3d` or `2w`. `--at` takes `YYYY-MM-DD` or `"YYYY-MM-DD HH:MM"` in local time. Prefer `--in` when the user gives a relative time, so you don't have to work out today's date.

Write the prompt for the agent that picks this up, who won't remember any of this: the task, what's blocking it and since when, and what to check or do next. For example:

```bash
butter-cli routine create --at 2026-10-29 --title "parking benefit" \
  "Check whether the employer parking benefit is live yet. On Oct 15 enrollment wasn't open, so parking couldn't be paid through it. If it's live, finish setting up parking payment through the benefit. If not, tell the user and snooze this routine a week."
```

Then tell the user when you'll check back.

Manage routines:

```bash
butter-cli routine list               # this conversation's routines; --all for every pending one
butter-cli routine snooze --in 1w     # a routine started you: check again later
butter-cli routine snooze <id> --at 2026-11-05 "<new prompt>"
butter-cli routine cancel <id>
```

Without an id, `snooze` reschedules the routine that started this session (or else this conversation's next one). The next run then points at this session's transcript. An optional prompt after the time replaces the old one; use it to record what changed.

## 1thread

If you were started from Butter's 1thread chat, the user only sees messages you send with `butter-cli thread reply`, never your terminal. The thread id is `$BUTTER_SESSION_ID`.

```bash
butter-cli thread reply "Done. I fixed the login bug and pushed it to the fix-login branch."
butter-cli thread reply --image /tmp/chart.png "Here's the chart."
echo "Need a decision: ship today or wait for review?" | butter-cli thread reply
```

Write like a text message: 1-3 short sentences, no code, logs, or markdown. Always reply before you stop. Follow-up messages from the user arrive wrapped in `<butter_message>` tags, and what other agents in the conversation said that you missed arrives in `<conversation_context>`.

## Team Mode messaging

Send a top-level message to a channel:

```bash
butter-cli team send --channel general "Status update from this agent"
```

Send a DM to a Team Mode user:

```bash
butter-cli team send --to molly "Can you look at this run?"
```

Reply in the thread under a top-level message:

```bash
butter-cli team reply <message-id> "I checked this and here is the result."
```

Prefer `reply` when responding to a request. Team Mode uses Slack-style one-level threads, so agent replies to mentions should stay under the original message.

### Search

```bash
butter-cli team search <query>
butter-cli team search --advanced <query>   # typo-tolerant nearest matches
```

### Inbox

```bash
butter-cli team inbox            # unread DMs, mentions and thread replies
butter-cli team inbox --recent   # including ones already marked read
butter-cli team mark-read <message-id>
butter-cli team mark-unread <message-id>
butter-cli team read --channel general   # mark a whole channel read
```

### Users and channels

```bash
butter-cli team user list
butter-cli team user set --username molly --display-name Molly --pwd /some/path --cmd 'claude -p "{user_msg}"'
butter-cli team channel list
butter-cli team channel set --name planning --display-name planning --description "Planning and coordination"
```

`user set` upserts by username and `channel set` by channel name. `cmd` is a template: Team Mode replaces `{user_msg}` with the triggering message before launching the agent. Mention-triggered agent runs should post replies in the original message thread.

`butter-browser` is a separate tool for driving Butter's browser pane.
