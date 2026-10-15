import Foundation

/// Just enough TOML for a flat config: `[section]` headers and `key = value`
/// with strings, numbers and booleans. Arrays and inline tables aren't needed.
enum MiniTOML {
    static func parse(_ text: String) -> [String: [String: Any]] {
        var result: [String: [String: Any]] = [:]
        var section = ""
        for rawLine in text.components(separatedBy: .newlines) {
            let line = stripComment(rawLine).trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            if line.hasPrefix("[") && line.hasSuffix("]") {
                section = String(line.dropFirst().dropLast()).trimmingCharacters(in: .whitespaces)
                continue
            }
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = line[..<eq].trimmingCharacters(in: .whitespaces)
            let value = line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            result[section, default: [:]][key] = parseValue(value)
        }
        return result
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
        if value == "true" { return true }
        if value == "false" { return false }
        if let i = Int(value) { return i }
        if let d = Double(value) { return d }
        return value
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
    var livePreview: Bool { bool("dictation", "live_preview", true) }
    var previewIntervalMs: Int { int("dictation", "preview_interval_ms", 700) }

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
    var meLabel: String { string("meeting", "me_label", "Me") }
    var themLabel: String { string("meeting", "them_label", "Them") }

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
    # Hotkeys: modifiers (cmd, ctrl, alt/opt, shift) + one key, e.g. "ctrl+alt+space",
    # "cmd+shift+d", "f13". Modifier-only hotkeys aren't supported.

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
    paste_last_hotkey = "ctrl+alt+v"            # paste the last dictation again (e.g. it landed in the wrong window)
    live_preview = true          # show words as you speak (re-transcribes the last ~20s every interval)
    preview_interval_ms = 700
    output = "paste"             # paste | clipboard | none
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

    """
}
