import Foundation

/// Just enough TOML for a flat config: `[section]` headers and `key = value`
/// with strings (including `"""` multi-line strings), numbers, booleans and
/// one-line arrays of strings. Inline tables aren't needed.
enum MiniTOML {
    static func parse(_ text: String) -> [String: [String: Any]] {
        var result: [String: [String: Any]] = [:]
        var section = ""
        var lines = text.components(separatedBy: .newlines)[...]
        while let rawLine = lines.popFirst() {
            if let (key, value) = multiLineString(rawLine, rest: &lines) {
                result[section, default: [:]][key] = value
                continue
            }
            let line = stripComment(rawLine).trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            if line.hasPrefix("[") && line.hasSuffix("]") {
                section = String(line.dropFirst().dropLast()).trimmingCharacters(in: .whitespaces)
                continue
            }
            guard let (key, value) = keyValue(line) else { continue }
            result[section, default: [:]][key] = parseValue(value)
        }
        return result
    }

    /// `key = value` or `"quoted key" = value` (for keys with spaces, as in [replacements]).
    private static func keyValue(_ line: String) -> (String, String)? {
        var rest = Substring(line)
        let key: String
        if let quote = rest.first, quote == "\"" || quote == "'" {
            rest = rest.dropFirst()
            guard let close = rest.firstIndex(of: quote) else { return nil }
            key = String(rest[..<close])
            rest = rest[rest.index(after: close)...].drop { $0 == " " || $0 == "\t" }
            guard rest.first == "=" else { return nil }
            rest = rest.dropFirst()
        } else {
            guard let eq = rest.firstIndex(of: "=") else { return nil }
            key = rest[..<eq].trimmingCharacters(in: .whitespaces)
            rest = rest[rest.index(after: eq)...]
        }
        return (key, rest.trimmingCharacters(in: .whitespaces))
    }

    /// `key = """` ... `"""`: the text in between, verbatim, minus the newline
    /// right after the opening quotes.
    private static func multiLineString(_ line: String, rest: inout ArraySlice<String>) -> (String, String)? {
        guard !line.trimmingCharacters(in: .whitespaces).hasPrefix("#"), let eq = line.firstIndex(of: "=") else { return nil }
        let value = line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces)
        guard value.hasPrefix("\"\"\"") else { return nil }
        let key = line[..<eq].trimmingCharacters(in: .whitespaces)
        var body = String(value.dropFirst(3))
        if let end = body.range(of: "\"\"\"") { return (key, String(body[..<end.lowerBound])) }
        var parts: [String] = body.isEmpty ? [] : [body]
        while let next = rest.popFirst() {
            if let end = next.range(of: "\"\"\"") {
                parts.append(String(next[..<end.lowerBound]))
                break
            }
            parts.append(next)
        }
        body = parts.joined(separator: "\n")
        return (key, body)
    }

    private static func stripComment(_ line: String) -> String {
        var quote: Character?
        var escaped = false
        for (i, ch) in line.enumerated() {
            if escaped { escaped = false; continue }
            if ch == "\\" && quote == "\"" { escaped = true; continue }
            if let q = quote {
                if ch == q { quote = nil }
            } else if ch == "\"" || ch == "'" {
                quote = ch
            } else if ch == "#" {
                return String(line.prefix(i))
            }
        }
        return line
    }

    private static func parseValue(_ value: String) -> Any {
        if value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") {
            var out = ""
            var escaped = false
            for ch in value.dropFirst().dropLast() {
                if escaped {
                    switch ch {
                    case "n": out.append("\n")
                    case "t": out.append("\t")
                    default: out.append(ch)
                    }
                    escaped = false
                } else if ch == "\\" {
                    escaped = true
                } else {
                    out.append(ch)
                }
            }
            return out
        }
        if value.count >= 2, value.hasPrefix("'"), value.hasSuffix("'") {
            return String(value.dropFirst().dropLast())
        }
        if value.hasPrefix("[") && value.hasSuffix("]") {
            return splitArray(String(value.dropFirst().dropLast())).compactMap { item -> String? in
                let parsed = parseValue(item.trimmingCharacters(in: .whitespaces))
                return (parsed as? String).flatMap { $0.isEmpty ? nil : $0 }
            }
        }
        if value == "true" { return true }
        if value == "false" { return false }
        if let i = Int(value) { return i }
        if let d = Double(value) { return d }
        return value
    }

    /// Splits array items on commas outside quotes.
    private static func splitArray(_ body: String) -> [String] {
        var items: [String] = [], current = ""
        var quote: Character?
        var escaped = false
        for ch in body {
            if escaped { escaped = false; current.append(ch); continue }
            if ch == "\\" && quote == "\"" { escaped = true; current.append(ch); continue }
            if let q = quote {
                if ch == q { quote = nil }
            } else if ch == "\"" || ch == "'" {
                quote = ch
            } else if ch == "," {
                items.append(current)
                current = ""
                continue
            }
            current.append(ch)
        }
        items.append(current)
        return items.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }
}

struct Config {
    var raw: [String: [String: Any]]

    func string(_ section: String, _ key: String, _ fallback: String) -> String {
        guard let v = raw[section]?[key] else { return fallback }
        return "\(v)"
    }

    func bool(_ section: String, _ key: String, _ fallback: Bool) -> Bool {
        raw[section]?[key] as? Bool ?? fallback
    }

    func double(_ section: String, _ key: String, _ fallback: Double) -> Double {
        (raw[section]?[key] as? NSNumber)?.doubleValue ?? fallback
    }

    /// An array of strings; a single string counts as a comma-separated list.
    func strings(_ section: String, _ key: String) -> [String] {
        if let list = raw[section]?[key] as? [String] { return list }
        guard let text = raw[section]?[key] as? String else { return [] }
        return text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    func int(_ section: String, _ key: String, _ fallback: Int) -> Int {
        if let i = raw[section]?[key] as? Int { return i }
        if let d = raw[section]?[key] as? Double { return Int(d) }
        return fallback
    }

    // [asr]
    var engine: String { string("asr", "engine", "parakeet") }
    var model: String { string("asr", "model", "") }
    var language: String { string("asr", "language", "en") }
    var prompt: String { string("asr", "prompt", "") }
    var idleUnloadMinutes: Int { int("asr", "idle_unload_minutes", 10) }

    // [dictation]
    var dictationHotkey: String { string("dictation", "hotkey", "ctrl+alt+space") }
    var dictationMode: String { string("dictation", "mode", "push_to_talk") }
    var handsFreeHotkey: String { string("dictation", "hands_free_hotkey", "ctrl+alt+shift+space") }
    var pasteLastHotkey: String { string("dictation", "paste_last_hotkey", "ctrl+alt+v") }
    var screenshotHotkey: String { string("dictation", "screenshot_hotkey", "ctrl+alt+s") }
    var tapForHandsFree: Bool { bool("dictation", "tap_for_hands_free", true) }
    var tapSeconds: Double { double("dictation", "tap_seconds", 0.4) }
    var cancelHotkey: String { string("dictation", "cancel_hotkey", "esc") }
    var livePreview: Bool { bool("dictation", "live_preview", true) }
    var previewIntervalMs: Int { int("dictation", "preview_interval_ms", 700) }
    var paragraphPause: Double { double("dictation", "paragraph_pause_seconds", 2.0) }
    var paragraphMaxWords: Int { int("dictation", "paragraph_max_words", 120) }
    var handsFreeCallAudio: Bool { bool("dictation", "hands_free_call_audio", true) }
    var handsFreeCallMinSeconds: Double { double("dictation", "hands_free_call_min_seconds", 60) }

    // [ui]
    var hud: Bool { bool("ui", "hud", true) }
    var hudPosition: String { string("ui", "position", "bottom") }
    var dictationOutput: String { string("dictation", "output", "paste") }
    var restoreClipboard: Bool { bool("dictation", "restore_clipboard", true) }
    var sounds: Bool { bool("dictation", "sounds", true) }
    var startSound: String { string("dictation", "start_sound", "butter-start") }
    var stopSound: String { string("dictation", "stop_sound", "butter-stop") }
    var errorSound: String { string("dictation", "error_sound", "butter-error") }
    var soundVolume: Double { double("dictation", "sound_volume", 0.6) }

    // [audio]
    var inputDevice: String { string("audio", "input_device", "auto") }

    // [meeting]
    var meetingHotkey: String { string("meeting", "hotkey", "ctrl+alt+m") }
    var systemAudio: Bool { bool("meeting", "system_audio", true) }
    var meetingDirectory: URL { Paths.expand(string("meeting", "directory", "~/.butter/recordings")) }
    var meetingEngine: String {
        let e = string("meeting", "engine", "")
        return e.isEmpty ? engine : e
    }
    var meetingModel: String {
        let m = string("meeting", "model", "")
        // A model id only makes sense for the engine it was written for.
        if !m.isEmpty { return m }
        return string("meeting", "engine", "").isEmpty ? model : ""
    }
    var summarizeCommand: String { string("meeting", "summarize_command", "") }
    var notesModel: String { string("meeting", "notes_model", "sonnet") }
    var notesPrompt: String { string("meeting", "notes_prompt", "") }
    var meLabel: String { string("meeting", "me_label", "Me") }
    var themLabel: String { string("meeting", "them_label", "Them") }

    // [cleanup]
    var cleanupButton: Bool { bool("cleanup", "button", true) }
    var cleanupHarness: String { string("cleanup", "harness", "claude") }
    var cleanupModel: String { string("cleanup", "model", "haiku") }
    var cleanupEffort: String { string("cleanup", "effort", "") }
    var cleanupCommand: String { string("cleanup", "command", "") }
    var cleanupPrompt: String { string("cleanup", "prompt", "") }
    var cleanupInstructions: String { string("cleanup", "instructions", "") }
    var cleanupVocabulary: [String] { strings("cleanup", "vocabulary") }

    // [replacements]
    /// What the transcriber writes -> what it should say, longest first so
    /// "click house" wins over "click".
    var replacements: [(heard: String, written: String)] {
        (raw["replacements"] ?? [:])
            .compactMap { key, value in
                let heard = key.trimmingCharacters(in: .whitespaces)
                guard let written = value as? String, !heard.isEmpty else { return nil }
                return (heard, written)
            }
            .sorted { $0.heard.count != $1.heard.count ? $0.heard.count > $1.heard.count : $0.heard < $1.heard }
    }

    /// The text with [replacements] applied: whole words, any case, and a
    /// multi-word phrase matches across spaces or hyphens ("click-house").
    func applyReplacements(_ text: String) -> String {
        var text = text
        for (heard, written) in replacements {
            let words = heard.split { $0 == " " || $0 == "-" }.map { NSRegularExpression.escapedPattern(for: String($0)) }
            guard !words.isEmpty, let regex = try? NSRegularExpression(
                pattern: "(?<![\\p{L}\\p{N}])" + words.joined(separator: "[\\s-]+") + "(?![\\p{L}\\p{N}])",
                options: [.caseInsensitive]) else { continue }
            text = regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text),
                                                  withTemplate: NSRegularExpression.escapedTemplate(for: written))
        }
        return text
    }
    var cleanupTimeout: Double { double("cleanup", "timeout_seconds", 20) }

    static func load() -> Config {
        ensureDefaultFile()
        let text = (try? String(contentsOf: Paths.configFile, encoding: .utf8)) ?? ""
        return Config(raw: MiniTOML.parse(text))
    }

    static func ensureDefaultFile() {
        let fm = FileManager.default
        guard !fm.fileExists(atPath: Paths.configFile.path) else { return }
        try? fm.createDirectory(at: Paths.configFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? defaultText.write(to: Paths.configFile, atomically: true, encoding: .utf8)
    }

    static let defaultText = """
    # butter-rec: local dictation + meeting recorder (no app, just this file).
    # Apply changes with `butter-cli rec reload`.
    #
    # Hotkeys: modifiers (cmd, ctrl, alt/opt, shift, fn) + one key, e.g. "ctrl+alt+space",
    # "cmd+shift+d", "f13", "fn+shift+tab"; or modifiers alone: fn, or two or more,
    # e.g. "fn+shift" (fires once they're held a moment with no other key). fn and
    # modifier-only hotkeys need Accessibility access. Caps Lock can't be used.

    [asr]
    engine = "parakeet"          # parakeet | canary | whisper
    model = ""                   # empty = the engine's default model
    language = "en"
    prompt = ""                  # vocabulary hint (engines that support it)
    idle_unload_minutes = 10     # unload the warm model after this much idle time (0 = never)

    [dictation]
    hotkey = "ctrl+alt+space"
    mode = "push_to_talk"        # push_to_talk (hold) | toggle (press to start, press to stop)
    hands_free_hotkey = "ctrl+alt+shift+space"  # records until you press it (or the dictation hotkey) again, or click stop
    cancel_hotkey = "esc"        # cancels a hands-free session; only taken while one is running ("" = off)
    screenshot_hotkey = "ctrl+alt+s"  # during hands-free or a meeting: screenshot the screen under the mouse
    tap_for_hands_free = true    # a quick tap of the push-to-talk hotkey starts hands-free instead
    tap_seconds = 0.4            # ...when let go within this long
    paste_last_hotkey = "ctrl+alt+v"            # paste the last dictation again (e.g. it landed in the wrong window)
    live_preview = true          # show words as you speak (re-transcribes the last ~20s every interval)
    preview_interval_ms = 700
    paragraph_pause_seconds = 2.0 # start a new paragraph after a pause this long (0 = one block of text)
    paragraph_max_words = 120    # ...or at the next sentence once a paragraph gets this long (0 = no limit)
    # Hands-free also records what your Mac plays (e.g. the other side of a call
    # in your AirPods). Only your words are pasted; if the session ran at least
    # hands_free_call_min_seconds and the Mac played something, both sides are
    # saved as a meeting too (butter-rec list / transcript).
    hands_free_call_audio = true
    hands_free_call_min_seconds = 60
    output = "paste"       # paste | clipboard | none
    restore_clipboard = true     # put the previous clipboard back after pasting
    sounds = true                # start/stop sounds (also used for meetings)
    start_sound = "butter-start" # butter-start | butter-stop | butter-error, a macOS sound
    stop_sound = "butter-stop"   # (Pop, Purr, Bottle, Glass, Tink, ...), or a path to an audio file
    error_sound = "butter-error"
    sound_volume = 0.6           # 0.0 - 1.0

    [ui]
    hud = true                   # floating pill while dictating / recording a meeting
    position = "bottom"          # bottom | top

    [audio]
    # Microphone to record from: "auto" uses the system default unless it's
    # Bluetooth (AirPods take seconds to switch into headset mode and sound worse
    # while the mic is open), in which case it uses the built-in mic.
    # "default" always follows the system; anything else matches a device name,
    # e.g. "MacBook Pro Microphone". `butter-rec devices` lists them.
    input_device = "auto"

    [meeting]
    hotkey = "ctrl+alt+m"        # toggles a meeting recording
    system_audio = true          # record what you hear (other participants) as well as your mic
    directory = "~/.butter/recordings"
    engine = ""                  # empty = use [asr]
    model = ""
    me_label = "Me"
    them_label = "Them"
    # Optional local summarizer. Gets the transcript markdown on stdin; stdout
    # becomes summary.md. Runs in a login shell. For example:
    # summarize_command = "ollama run llama3.2 'Summarize this meeting transcript as notes with decisions and action items:'"
    summarize_command = ""
    # ✦ Notes on the "Meeting ready" pill (or `butter-rec notes`): meeting notes
    # written by the [cleanup] harness. The whole transcript goes to the model.
    notes_model = "sonnet"
    notes_prompt = ""            # replaces the built-in prompt; {{transcript}}, {{vocabulary}}

    [cleanup]
    # Hands-free dictation shows a ✦ button next to stop: it stops, transcribes,
    # then rewrites the text with a model before pasting (filler words, false
    # starts, "X, I mean Y", misheard names, punctuation). Stop (■) stays raw.
    # If the cleanup fails, times out, or looks like an answer instead of a
    # cleanup, the raw text is pasted. History keeps both.
    button = true
    harness = "claude"           # claude: headless `claude -p` (no tools, MCP, hooks or session saved)
                                 # command: run `command` below, prompt on stdin, cleaned text on stdout
    model = "haiku"              # claude --model (haiku | sonnet | opus | a full model id)
    effort = ""                  # claude --effort, e.g. "low"; empty = the model's default
    command = ""                 # e.g. "ollama run qwen3:4b" to stay fully local
    timeout_seconds = 20
    vocabulary = []              # preferred spellings, e.g. ["Salesforce", "ClickHouse", "Postgres"]
    instructions = ""            # extra rules appended to the prompt, e.g. "Use British spelling."
    # The whole prompt, if you want to replace it. {{text}} is the transcript,
    # {{vocabulary}} and {{instructions}} the settings above. Empty = built in.
    prompt = ""

    [replacements]
    # Words the transcriber gets wrong -> how to write them, applied to every
    # dictation and meeting transcript (whole words, any case). Quote keys with
    # spaces. Cleanup (✦) gets this list too, so it also fixes near misses.
    # clinko = "Klinko"
    # "click house" = "ClickHouse"

    """
}
