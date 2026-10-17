# butter-rec

Local dictation and meeting recording for Butter. Like Handy, it has push-to-talk dictation that pastes text where your cursor is. Like Granola, it records meetings with your mic and system audio on separate tracks and writes a speaker-labelled transcript. Unlike either, there's no app window. You control it with hotkeys, a TOML file and `butter-cli rec`. Audio and transcription stay on your Mac.

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

| | Hotkey (default) | CLI |
|---|---|---|
| Dictate (push-to-talk) | hold `ctrl+opt+space`, release to paste | |
| Dictate (hands-free) | `ctrl+opt+shift+space` to start; same key, the push-to-talk key, or ■ to stop; ✦ to stop and clean up | `butter-cli rec dictate start` / `stop [--clean]` / `cancel` |
| Paste last dictation again | `ctrl+opt+v` | `butter-cli rec last [--copy]` |
| Meeting | `ctrl+opt+m` to start/stop | `butter-cli rec meeting start --title "Acme sync"` / `meeting stop --wait` |

A small pill appears at the bottom of the screen as soon as you press a hotkey. It shows a live mic meter, and a timer with ■ stop and × cancel for hands-free and meeting sessions. Hands-free sessions also get ✦, which stops and [cleans up](#cleanup) the text before pasting. With `live_preview` on, a caption above the pill shows your words as you speak. The preview re-transcribes the last ~20 seconds every 0.7s, and the text that gets pasted comes from a final pass over the whole clip. The pill never takes focus, so the paste lands in your app.

Long dictations are split into paragraphs. A pause of 2 seconds or more (`paragraph_pause_seconds`) starts a new one. A paragraph that runs past 120 words (`paragraph_max_words`) breaks at the next sentence. `butter-cli rec transcribe` formats files the same way.

Hands-free also records what your Mac plays, in case the session is really a call (the other side in your AirPods, say). Only your words are pasted. If the session ran for at least a minute (`hands_free_call_min_seconds`) and the Mac played something, both sides are also saved as a meeting called "Hands-free call". The pill says "Call saved as a meeting", and `butter-cli rec transcript` shows it labelled Me/Them. Shorter or silent sessions leave nothing behind. Turn this off with `hands_free_call_audio = false`.

By default (`input_device = "auto"`), when your system mic is Bluetooth, such as AirPods, the recorder uses the built-in mic instead. Opening a Bluetooth mic switches the headset into call mode, which takes seconds and makes playback sound worse. Run `butter-cli rec devices` to see which mic it's using.

Each meeting gets a folder in `~/.butter/recordings/<date>_<title>/`:

```
meeting.json      status (recording → queued → transcribing → summarizing → done | error), timings
mic.wav           you            (16 kHz mono)
system.wav        everyone else  (16 kHz mono)
transcript.md     merged, speaker-labelled transcript
transcript.json   segments with speaker + timestamps
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

## Configure

Edit `~/.config/butter/recorder.toml`, then run `butter-cli rec reload`. The file documents every key. The main ones:

```toml
[asr]
engine = "parakeet"        # parakeet | canary | whisper
model = ""                 # empty = engine default

[dictation]
hotkey = "ctrl+alt+space"
mode = "push_to_talk"      # or "toggle"
output = "paste"           # paste | clipboard | none

[meeting]
hotkey = "ctrl+alt+m"
system_audio = true
summarize_command = "ollama run llama3.2 'Summarize this meeting as notes with action items:'"
```

`summarize_command` runs in a login shell with the transcript on stdin, and its stdout is saved as `summary.md`. Point it at a local model to keep everything on your machine.

### Hotkeys

A hotkey is any modifiers plus one key: `"cmd+shift+d"`, `"f13"`, `"fn+shift+tab"`. It can also be modifiers alone, either `fn` or two or more, such as `"fn+shift"`. This setup keeps everything on the left side of the keyboard:

```toml
[dictation]
hotkey = "fn+shift"              # hold to talk
hands_free_hotkey = "fn+shift+tab"
```

A modifier-only hotkey fires after its modifiers have been held for 0.15s with no other key pressed, so fn+shift+arrow still selects text. If you press a key after it has started, the dictation is cancelled. One exception: holding the dictation hotkey and then pressing the hands-free one switches the recording you're in to hands-free. fn and modifier-only hotkeys need Accessibility access, which paste already uses. Caps Lock can't be part of a hotkey. If the 🌐 key opens the emoji picker or switches input source, set System Settings › Keyboard › "Press 🌐 key to" to "Do Nothing".

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

- If you're on speakers rather than headphones, your mic also picks up the other side. Overlapping "Me" lines that repeat "Them" lines get dropped, but some echo can still get through.
- If the default output device changes during a meeting (for example, AirPods connect), system audio may stop. The mic keeps recording.
- Nobody is identified by name. "Them" covers everyone on the call.
- Butter's own UI doesn't show anything about recordings yet.
