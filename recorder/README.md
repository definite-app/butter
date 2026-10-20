# butter-rec

Local dictation and meeting recording for Butter. Like Handy, it has push-to-talk dictation that pastes text where your cursor is. Like Granola, it records meetings with your mic and system audio on separate tracks and writes a speaker-labelled transcript. Unlike either, there's no app window. You control it with hotkeys, a TOML file and `butter-cli rec`. Audio and transcription stay on your Mac.

## Shortcuts

| | Default shortcut | CLI |
|---|---|---|
| Dictate (push-to-talk) | hold `ctrl+opt+space`, release to paste | |
| Hands-free (starts as a meeting) | tap `ctrl+opt+space`, or `ctrl+opt+shift+space` | `butter-cli rec dictate start` (starts on Dictate) |
| ↳ dictate instead (paste your words) | the pill's Dictate \| Meeting switch | `butter-cli rec dictate dictation` / `dictate meeting` |
| ↳ screenshot | `ctrl+opt+s` or 📷 (also during a meeting) | `butter-cli rec screenshot` |
| ↳ stop (Meeting: save it; Dictate: paste) | the same shortcut again, the push-to-talk shortcut, or ■ | `butter-cli rec dictate stop` |
| ↳ stop, [clean up](#cleanup), paste | ✦ (Dictate) | `butter-cli rec dictate stop --clean` |
| ↳ cancel (nothing pasted or saved) | `esc` or × | `butter-cli rec dictate cancel` |
| Paste the last dictation again | `ctrl+opt+v` | `butter-cli rec last [--copy]` |
| Meeting | `ctrl+opt+m` to start, again to stop | `butter-cli rec meeting start --title "Acme sync"` / `meeting stop --wait` |

A quick tap of the push-to-talk shortcut (let go within 0.4s, `tap_seconds`) keeps recording hands-free; `tap_for_hands_free = false` turns that off. Holding it and then pressing the hands-free shortcut also switches the recording you're in to hands-free. Hands-free starts on the Meeting side of the pill's switch, so both sides are saved and nothing is pasted until you flip it to Dictate; `hands_free_mode = "dictate"` starts it on Dictate instead. `esc` and the screenshot shortcut are only taken from other apps while a session is running. `butter-cli rec status` shows the shortcuts in use and any that failed to register.

Meetings start only when you start them: with the meeting shortcut, the CLI, or a hands-free session left on the Meeting side of its switch. Nothing watches for calls on its own. A hands-free session switched to Dictate that turns out to be a call is also [saved as a meeting](#use). See [After a meeting](#after-a-meeting) for getting to the transcript.

### Change a shortcut

Edit `~/.config/butter/recorder.toml`, then run `butter-cli rec reload`. No restart is needed.

```toml
[dictation]
hotkey = "fn+shift"                 # push-to-talk (default "ctrl+alt+space")
hands_free_hotkey = "fn+shift+tab"  # default "ctrl+alt+shift+space"
cancel_hotkey = "esc"               # cancels hands-free; "" turns it off
screenshot_hotkey = "fn+shift+s"    # default "ctrl+alt+s"
paste_last_hotkey = "ctrl+alt+v"
mode = "push_to_talk"               # or "toggle": press to start, press again to stop

[meeting]
hotkey = "fn+shift+m"              # default "ctrl+alt+m"
```

- A shortcut is any modifiers (`cmd`, `ctrl`, `alt`/`opt`, `shift`, `fn`) plus one key: a letter, a digit, `f1`–`f20`, `space`, `tab`, `return`, `esc`, `delete`, an arrow, `home`/`end`/`pageup`/`pagedown`, or punctuation (`/`, `;`, `` ` `` or `~`, …).
- It can also be modifiers alone: `fn`, or two or more, such as `"fn+shift"`. These fire after the modifiers have been held for 0.15s with no other key pressed, so fn+shift+arrow still selects text. If you press a key after a dictation has started, it's cancelled.
- fn and modifier-only shortcuts need Accessibility access, which paste already uses.
- Caps Lock can't be part of a shortcut.
- If the 🌐 key opens the emoji picker or switches input source, set System Settings › Keyboard › "Press 🌐 key to" to "Do Nothing".
- A shortcut another app already owns fails to register; `butter-cli rec reload` lists it.

## Install

```sh
recorder/build.sh                 # builds ButterRec.app, installs to ~/.butter, links ~/.butter/bin/butter-rec
butter-cli rec install            # LaunchAgent + default config at ~/.config/butter/recorder.toml
butter-cli rec status
```

The first time you use each feature, macOS asks **ButterRec** for access:

- **Microphone:** dictation and your side of meetings.
- **System Audio Recording:** the other side of meetings. This uses a Core Audio process tap, not Screen Recording.
- **Accessibility:** only needed for `output = "paste"`, so ButterRec can press ⌘V.

Speech recognition runs in `asr/worker.py`, a uv script that keeps the model warm between dictations. On first use it downloads the model to a local cache. After that, nothing leaves the machine.

## Use

A small pill appears at the bottom of the screen as soon as you press a hotkey. It shows a live mic meter, and a timer with ■ stop and × cancel for hands-free and meeting sessions. Hands-free sessions also get ✦, which stops and [cleans up](#cleanup) the text before pasting. With `live_preview` on, a caption above the pill shows your words as you speak. The preview re-transcribes the last ~20 seconds every 0.7s, and the text that gets pasted comes from a final pass over the whole clip. The pill never takes focus, so the paste lands in your app. Drag it anywhere by its background and it stays there, on whichever screen you're using; double-click it to put it back.

Long dictations are split into paragraphs. A pause of 2 seconds or more (`paragraph_pause_seconds`) starts a new one. A paragraph that runs past 120 words (`paragraph_max_words`) breaks at the next sentence. `butter-cli rec transcribe` formats files the same way.

Hands-free always records what your Mac plays as well as your mic. On the Meeting side, both are saved as a meeting when you stop. On the Dictate side, only your words are pasted, but if the session ran for at least a minute (`hands_free_call_min_seconds`) and the Mac played something, both sides are also saved as a meeting called "Hands-free call". The pill says "Call saved as a meeting", and `butter-cli rec transcript` shows it labelled Me/Them. `hands_free_call_audio = false` stops recording the Mac on the Dictate side.

Every session's audio is also kept in `~/.butter/dictation/audio/` for 30 days (`keep_audio_days`, 0 = not kept): `<date>_<time>.wav` for your mic and `<date>_<time>-system.wav` for what the Mac played, including cancelled sessions in case `esc` was a mistake. The `audio` field in `butter-cli rec history --json` points at each dictation's file. Meetings keep theirs in the meeting folder.

By default (`input_device = "auto"`), when your system mic is Bluetooth, such as AirPods, the recorder uses the built-in mic instead. Opening a Bluetooth mic switches the headset into call mode, which takes seconds and makes playback sound worse. Run `butter-cli rec devices` to see which mic it's using.

Each meeting gets a folder in `~/.butter/recordings/<date>_<title>/`:

```
meeting.json      status (recording → queued → transcribing → summarizing → done | error), timings
mic.wav           you            (16 kHz mono)
system.wav        everyone else  (16 kHz mono)
system-raw*.wav   everyone else as it arrived (the output's own rate and channels; a new file
                  when the rate changes), kept 14 days (raw_audio_days); raw_system_audio = false skips it
system.orig.wav   only after `butter-cli rec repair`
transcript.md     merged, speaker-labelled transcript
transcript.json   segments with speaker + timestamps
screenshots/      screenshots taken during it, linked from transcript.md
notes.md          only after ✦ Notes
summary.md        only if summarize_command is set
```

```sh
butter-cli rec history -n 20          # recent dictations; --search "pricing", --json
butter-cli rec list
butter-cli rec transcript            # latest; or pass an id / unique substring
butter-cli rec transcript | claude -p "What did we commit to?"
butter-cli rec process <id>          # re-transcribe, e.g. after switching engines
butter-cli rec transcribe memo.m4a   # any audio file AVFoundation can read
```

### After a meeting

When you stop a meeting, the pill says "Transcribing meeting · 32 min" until the transcript is done, then "✓ Meeting ready" with:

- **Open**: opens `notes.md` if there is one, else `transcript.md`, in your default Markdown app.
- **Copy**: copies the same file's text.
- **✦ Notes**: writes `notes.md` (summary, decisions, action items, key points, open questions) with the [cleanup](#cleanup) harness and `[meeting] notes_model` (default `sonnet`), then opens it. The whole transcript goes to the model. `butter-cli rec notes [<id>]` does the same.
- **×**: dismisses it. It stays up until then, so you can come back to it after other work.

If notes can't be written, the pill says why, e.g. "Notes failed: timed out after 90s", and `rec.log` has the whole error. The daemon starts from launchd, without your shell's PATH or aliases. It looks for `claude` on the usual paths and in `~/.claude/local/`, then asks your login shell. If it still isn't found, set `[cleanup] claude_path`.

`transcript.md` starts with a ⚠️ line when something looks off: the system audio track is much shorter than the mic track, or it has sound but no speech was found. `meeting.json` records the format the Mac delivered (`system_audio_format`: sample rate, channels, the output device clocking it, and any rate changes during the meeting).

Meetings are also in the pill's ⟲ history list, mixed in with dictations. Click one to open it, or hover to get Open, Copy and ✦ Notes.

### Screenshots

During hands-free dictation or a meeting, 📷 on the pill (or `screenshot_hotkey`) saves the whole screen under the mouse right away. The pill hides for the shot. A card with a thumbnail confirms it.

- **Dictation:** saved in `~/.butter/dictation/screenshots/` (the newest 100 are kept). The file's path goes into the pasted text where you took it, so an agent like Claude Code reads the image.
- **Meeting:** saved in the meeting's `screenshots/` folder and linked from `transcript.md` at the time you took it.

The first screenshot asks for Screen Recording access for ButterRec (System Settings › Privacy & Security › Screen & System Audio Recording).

### Copied text

What you copy during a hands-free session or a meeting is kept with it (`capture_clipboard`):

- **Dictation:** the text goes into the pasted text where you copied it. Several lines become a code block, and copied files become their paths.
- **Meeting:** it's in `transcript.md` as a **Copied** block at that time, and notes can quote it.
- A copied image (a screenshot copied to the clipboard, say) is saved like a screenshot.

Copies from password managers (marked concealed or transient on the clipboard) are skipped, and ButterRec's own pastes don't count. A card above the pill shows the start of what was kept.

## Configure

Edit `~/.config/butter/recorder.toml`, then run `butter-cli rec reload`. The file documents every key. For shortcuts, see [Change a shortcut](#change-a-shortcut). The other main settings:

```toml
[asr]
engine = "parakeet"        # parakeet | canary | whisper
model = ""                 # empty = engine default

[dictation]
output = "paste"           # paste | clipboard | none

[meeting]
system_audio = true
summarize_command = "ollama run llama3.2 'Summarize this meeting as notes with action items:'"
```

`summarize_command` runs in a login shell with the transcript on stdin, and its stdout is saved as `summary.md`. Point it at a local model to keep everything on your machine.

### Replacements

Map words the transcriber gets wrong to how they should be written. This applies to every dictation and meeting transcript, matching whole words in any case:

```toml
[replacements]
clinko = "Klinko"
"click house" = "ClickHouse"     # quote keys with spaces; also matches "click-house"
```

[Cleanup](#cleanup) gets the list too ("Klinko, often transcribed as "clinko""), so it also catches near misses like "Clinco".

### Cleanup

The hands-free pill has a ✦ button next to ■. It stops the recording, transcribes it, and rewrites the text with a model before pasting. The rewrite removes filler words and stutters, keeps only the correction when you correct yourself, and fixes misheard words, product names and punctuation:

```
uhhh, can you chex, I mean, can you runs lookup in sales force
→ can you run a lookup in Salesforce
```

■ still pastes the raw transcript. By default the cleanup runs headless Claude Code. A cleanup takes about 2–4 seconds, and the dictation leaves your Mac:

```toml
[cleanup]
harness = "claude"         # claude -p with no tools, MCP servers, hooks or saved session
model = "haiku"
vocabulary = ["Salesforce", "ClickHouse", "Postgres"]
instructions = "Use British spelling."
```

With `harness = "command"`, any program can do the cleanup. It gets the prompt on stdin and prints the cleaned text, for example `command = "ollama run qwen3:4b"` to stay local. `prompt` replaces the built-in prompt, using `{{text}}`, `{{vocabulary}}` and `{{instructions}}` as placeholders.

If the model fails, times out (`timeout_seconds`), or returns something that isn't a cleanup, the raw text is pasted and the pill says "Pasted without cleanup". One example is answering a question you dictated instead of cleaning it up. History keeps both versions: `text` is what was pasted and `raw` is what was heard. Use `butter-cli rec history --raw` to see the raw versions, and `butter-cli rec cleanup "some text"` to try your settings.

## How it fits together

- `Sources/`: Swift daemon in a UI-less `.app` bundle (`LSUIElement`), so macOS can grant it permissions under its own identity. Carbon `RegisterEventHotKey` handles plain hotkeys without Accessibility. fn and modifier-only hotkeys use a `CGEventTap`. `AVAudioEngine` records the mic, a Core Audio process tap records system audio, and the CLI talks to the daemon over a unix socket (`~/.butter/rec.sock`).
- `asr/worker.py`: speech recognition engines behind a JSON-lines protocol on stdin/stdout.
- `butter-cli rec …` passes its arguments through to `~/.butter/bin/butter-rec`.

Logs go to `~/.butter/logs/rec.log`. Set `BUTTER_REC_CONFIG=/path/to.toml` to run a second daemon against a test config.

## Known gaps

- Recordings made before 2026-10-20 through AirPods on a call have system audio half as long as it should be, at double speed: AirPods drop to 24 kHz when a call opens their mic, and that audio was labelled 48 kHz. The ⚠️ line in `transcript.md` says so. `butter-cli rec repair <id>` slows it back down (keeping the original as `system.orig.wav`) and re-transcribes it. The repaired audio only goes up to 4 kHz, like a phone call. Recordings since then follow the rate.

- If you're on speakers rather than headphones, your mic also picks up the other side. Overlapping "Me" lines that repeat "Them" lines get dropped, but some echo can still get through.
- If the default output device changes during a meeting (for example, AirPods connect), system audio may stop. The mic keeps recording.
- Nobody is identified by name. "Them" covers everyone on the call.
- Butter's own UI doesn't show anything about recordings yet.
