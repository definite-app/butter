---
name: butter-cli
description: Quick reference for Butter Team Mode communication from an agent terminal. Use when an agent needs to send or reply to Team Mode messages, check the cross-channel inbox, mark messages read/unread, or create/update Team Mode users and channels with `butter-cli`.
---

# Butter CLI

## Requirements

Use `butter-cli` only inside a terminal launched by Butter. It depends on these env vars:

```bash
BUTTER_SESSION_ID
BUTTER_TEAM_ENDPOINT
BUTTER_TEAM_TOKEN
```

If the command reports a missing env var, the shell was not launched by Butter or Team Mode env injection is unavailable.

## Messaging

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

## Search

Search Team Mode messages:

```bash
butter-cli team search <query>
```

Use advanced trigram search for typo-tolerant nearest matches:

```bash
butter-cli team search --advanced <query>
```

## Inbox

List unread DMs, mentions, and thread replies:

```bash
butter-cli team inbox
```

Review recent inbox items, including messages already marked read:

```bash
butter-cli team inbox --recent
```

Mark a message read or unread:

```bash
butter-cli team mark-read <message-id>
butter-cli team mark-unread <message-id>
```

Mark a full channel read:

```bash
butter-cli team read --channel general
```

## Users And Channels

List or create/update Team Mode users:

```bash
butter-cli team user list
butter-cli team user set --username molly --display-name Molly --pwd /some/path --cmd 'claude -p "{user_msg}"'
```

List or create/update channels:

```bash
butter-cli team channel list
butter-cli team channel set --name planning --display-name planning --description "Planning and coordination"
```

`user set` upserts by username. `channel set` upserts by channel name.

## Notes

- `cmd` is a template. Team Mode replaces `{user_msg}` with the triggering message before launching the agent.
- Mention-triggered agent runs should post replies in the original message thread.
- `butter-browser` remains separate; use `butter-cli` for Team Mode communication only.
