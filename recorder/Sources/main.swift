import AppKit
import AVFoundation
import Foundation

let usage = """
butter-rec: local dictation + meeting recorder. Configure in ~/.config/butter/recorder.toml.

Usage:
  butter-rec install                 register the background daemon (LaunchAgent) and write default config
  butter-rec uninstall               remove the LaunchAgent
  butter-rec status                  daemon state, hotkeys, permissions
  butter-rec reload                  re-read the config and re-register hotkeys
  butter-rec meeting start [--title <name>]
  butter-rec meeting stop [--wait]   stop recording; transcription runs in the background
  butter-rec meeting toggle [--title <name>]
  butter-rec dictate [start|stop|toggle|cancel]
  butter-rec dictate stop --clean    stop, and clean up the text before pasting ([cleanup] in the config)
  butter-rec dictate meeting|dictation  switch a hands-free session to a meeting (saved, not pasted) or back
  butter-rec screenshot              take a screenshot into the running dictation or meeting
  butter-rec cleanup [<text>]        clean up text (or stdin) with the [cleanup] harness and print it
  butter-rec list [-n <n>]           recorded meetings, newest first
  butter-rec history [-n <n>] [--search <text>] [--json] [--raw]
                                     recent dictations, newest first (--raw: before cleanup)
  butter-rec last [--copy]           print (or copy) the last dictation
  butter-rec transcript [<id>]       print a meeting transcript (default: latest)
  butter-rec summary [<id>]          print a meeting summary (needs summarize_command)
  butter-rec notes [<id>]            write notes.md for a meeting with the [cleanup] harness ([meeting] notes_model)
  butter-rec path [<id>]             print a meeting's folder
  butter-rec process [<id>]          re-run transcription (+ summary) for a meeting
  butter-rec repair [<id>] [--factor <n>]
                                     fix system audio recorded too fast (AirPods in call mode, before the
                                     sample-rate fix), keeping the original as system.orig.wav, then re-process
  butter-rec transcribe <audio-file> [--engine <e>] [--model <m>]
  butter-rec calendar [list] [--json] upcoming events from ~/.butter/calendar/upcoming.json
  butter-rec calendar import [<file>|-] [--source <name>]
                                     check events (JSON, from a file or stdin) and write upcoming.json
  butter-rec calendar refresh        fetch the next 24h now with claude and your calendar MCP server
  butter-rec devices                 list microphones (for [audio] input_device)
  butter-rec config                  print the config path (creating it if missing)
  butter-rec logs                    print the daemon log path
  butter-rec daemon                  run the daemon in the foreground (launchd uses this)
"""

struct Args {
    var positional: [String] = []
    var options: [String: String] = [:]
    var flags: Set<String> = []

    init(_ argv: ArraySlice<String>, valued: Set<String>) throws {
        var it = argv.makeIterator()
        while let arg = it.next() {
            if arg == "-n" {
                guard let value = it.next() else { throw CLIError("-n needs a value") }
                options["limit"] = value
            } else if arg.hasPrefix("--") {
                let name = String(arg.dropFirst(2))
                if valued.contains(name) {
                    guard let value = it.next() else { throw CLIError("--\(name) needs a value") }
                    options[name] = value
                } else {
                    flags.insert(name)
                }
            } else {
                positional.append(arg)
            }
        }
    }
}

func print(json object: [String: Any]) {
    print(jsonString(object, pretty: true))
}

func daemonRequest(_ request: [String: Any]) throws -> [String: Any] {
    guard let reply = sendToDaemon(request) else {
        throw CLIError("butter-rec daemon isn't running. Start it with `butter-cli rec install` (or `butter-rec daemon` in a terminal).")
    }
    if reply["ok"] as? Bool == false, let error = reply["error"] as? String { throw CLIError(error) }
    return reply
}

/// Decodes any audio file AVFoundation can read into a 16 kHz mono WAV.
func convertToWav(_ input: URL) throws -> URL {
    let source = try AVAudioFile(forReading: input)
    let out = FileManager.default.temporaryDirectory.appendingPathComponent("butter-rec-\(UUID().uuidString).wav")
    let sink = try WavSink(url: out)
    let format = source.processingFormat
    // Stop at the length rather than reading until an empty buffer: reading
    // at the end throws (nilError) instead of returning zero frames.
    while source.framePosition < source.length {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 65536) else { break }
        try source.read(into: buffer)
        if buffer.frameLength == 0 { break }
        sink.write(buffer)
    }
    sink.close()
    return out
}

func installLaunchAgent() throws {
    guard FileManager.default.isExecutableFile(atPath: Paths.executable.path) else {
        throw CLIError("\(Paths.executable.path) not found; run recorder/build.sh first")
    }
    Config.ensureDefaultFile()
    try FileManager.default.createDirectory(at: Paths.logFile.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: Paths.launchAgent.deletingLastPathComponent(), withIntermediateDirectories: true)
    let plist: [String: Any] = [
        "Label": Paths.label,
        "ProgramArguments": [Paths.executable.path, "daemon"],
        "RunAtLoad": true,
        "KeepAlive": ["SuccessfulExit": false],
        "ProcessType": "Interactive",
        "StandardOutPath": Paths.logFile.path,
        "StandardErrorPath": Paths.logFile.path,
        "EnvironmentVariables": ["PATH": Paths.searchPath],
    ]
    let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
    try data.write(to: Paths.launchAgent)
    let domain = "gui/\(getuid())"
    _ = try? runShell("launchctl bootout \(domain)/\(Paths.label) 2>/dev/null")
    let result = try runShell("launchctl bootstrap \(domain) '\(Paths.launchAgent.path)'")
    guard result.status == 0 else {
        throw CLIError("launchctl bootstrap failed: \(String(data: result.stderr, encoding: .utf8) ?? "")")
    }
}

func runDaemon() -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let daemon = Daemon()
    do {
        try daemon.start()
    } catch {
        log("daemon failed to start: \(error)")
        exit(1)
    }
    var signalSources: [DispatchSourceSignal] = []
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler {
            log("signal \(sig); shutting down")
            daemon.shutdown()
            exit(0)
        }
        source.resume()
        signalSources.append(source)
    }
    withExtendedLifetime(signalSources) { app.run() }
    exit(0)
}

/// `butter-rec calendar`: what's coming up, where it came from, and whether the
/// last refresh worked.
func printCalendar() {
    let status = CalendarRefresh.Status.load()
    guard let snapshot = CalendarStore.load() else {
        print("No calendar yet (\(Paths.calendarFile.path)).")
        print("Import events with `butter-rec calendar import <file>`, or run `butter-rec calendar refresh`.")
        if let error = status.error { print("Last refresh failed: \(error)") }
        return
    }
    let age = snapshot.updatedAt.map { "\(formatDuration(Date().timeIntervalSince($0))) ago" } ?? "at an unknown time"
    print("Updated \(age) from \(snapshot.source)\(snapshot.stale ? " (over 24h old: no nudges or meeting titles from it)" : "")")
    if let error = status.error, let at = status.attemptAt {
        print("Last refresh failed \(formatDuration(Date().timeIntervalSince(at))) ago: \(error)")
    }
    let now = Date()
    let upcoming = snapshot.events.filter { $0.end > now }
    if upcoming.isEmpty { print("Nothing coming up.") }
    for event in upcoming {
        var details: [String] = []
        if !event.attendees.isEmpty { details.append(event.attendees.count == 1 ? event.attendees[0].label : "\(event.attendees.count) people") }
        if let link = event.joinURL.flatMap(URL.init(string:))?.host {
            details.append(link.contains("zoom") ? "Zoom" : link.contains("meet.google") ? "Meet" : link.contains("teams") ? "Teams" : link)
        }
        let when = event.when.padding(toLength: max(17, event.when.count), withPad: " ", startingAt: 0)
        print("\(when)  \(event.title)\(details.isEmpty ? "" : "  · " + details.joined(separator: " · "))")
    }
}

func meetingFile(_ args: Args, _ name: String) throws -> URL {
    let dir = try Meetings.resolve(args.positional.first, Config.load())
    let file = dir.appendingPathComponent(name)
    guard FileManager.default.fileExists(atPath: file.path) else {
        let status = MeetingMeta.load(dir)?.status ?? "unknown"
        throw CLIError("\(dir.lastPathComponent) has no \(name) yet (status: \(status))")
    }
    return file
}

func run() throws {
    let argv = CommandLine.arguments
    guard argv.count > 1 else { print(usage); return }
    let command = argv[1]
    let args = try Args(argv.dropFirst(2), valued: ["title", "engine", "model", "limit", "search", "factor", "source"])

    switch command {
    case "help", "-h", "--help":
        print(usage)

    case "daemon":
        runDaemon()

    case "install":
        try installLaunchAgent()
        print("Installed \(Paths.launchAgent.path)")
        print("Config: \(Paths.configFile.path)")
        print("macOS will ask ButterRec for Microphone, System Audio Recording and Accessibility (for paste) access on first use.")

    case "uninstall":
        _ = try? runShell("launchctl bootout gui/\(getuid())/\(Paths.label)")
        try? FileManager.default.removeItem(at: Paths.launchAgent)
        print("Removed \(Paths.launchAgent.path). Recordings and config were left in place.")

    case "status":
        if let reply = sendToDaemon(["cmd": "status"]) {
            print(json: reply)
        } else {
            print(json: ["ok": false, "daemon": "not running", "config": Paths.configFile.path])
        }

    case "reload":
        print(json: try daemonRequest(["cmd": "reload"]))

    case "meeting":
        let action = args.positional.first ?? "toggle"
        var request: [String: Any] = ["cmd": "meeting.\(action)"]
        if let title = args.options["title"] { request["title"] = title }
        guard ["start", "stop", "toggle"].contains(action) else { throw CLIError("meeting start|stop|toggle") }
        let reply = try daemonRequest(request)
        print(json: reply)
        if args.flags.contains("wait"), let dirPath = reply["dir"] as? String, reply["duration"] != nil {
            let dir = URL(fileURLWithPath: dirPath)
            while true {
                let status = MeetingMeta.load(dir)?.status ?? "unknown"
                if status == "done" { print(dir.appendingPathComponent("transcript.md").path); break }
                if status == "error" { throw CLIError(MeetingMeta.load(dir)?.dict["error"] as? String ?? "processing failed") }
                Thread.sleep(forTimeInterval: 1)
            }
        }

    case "dictate":
        let action = args.positional.first ?? "toggle"
        if action == "meeting" || action == "dictation" {
            print(json: try daemonRequest(["cmd": "dictate.mode", "meeting": action == "meeting"]))
            return
        }
        guard ["start", "stop", "toggle", "cancel"].contains(action) else { throw CLIError("dictate start|stop|toggle|cancel|meeting|dictation") }
        var request: [String: Any] = ["cmd": "dictate.\(action)"]
        if args.flags.contains("clean") {
            guard action == "stop" else { throw CLIError("--clean only goes with `dictate stop`") }
            request["cleanup"] = true
        }
        print(json: try daemonRequest(request))

    case "cleanup":
        var text = args.positional.joined(separator: " ")
        if text.isEmpty {
            text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw CLIError("cleanup <text> (or text on stdin)") }
        let outcome = Cleanup.run(text, config: Config.load())
        print(outcome.text)
        if let reason = outcome.fallbackReason {
            throw CLIError("cleanup failed, printed the raw text: \(reason)")
        }
        FileHandle.standardError.write(String(format: "(cleaned in %.1fs)\n", outcome.elapsed).data(using: .utf8)!)

    case "list":
        let limit = Int(args.options["limit"] ?? "") ?? 20
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd HH:mm"
        for dir in Meetings.all(Config.load()).prefix(limit) {
            guard let meta = MeetingMeta.load(dir) else { continue }
            let when = meta.startedAt.map { df.string(from: $0) } ?? "?"
            let line = [dir.lastPathComponent, when, formatDuration(meta.duration), meta.status, meta.title]
            print(line.joined(separator: "\t"))
        }

    case "history":
        let entries = DictationHistory.recent(limit: Int(args.options["limit"] ?? "") ?? 20, search: args.options["search"])
        if args.flags.contains("json") {
            print(jsonString(entries, pretty: true))
        } else {
            let df = DateFormatter()
            df.dateFormat = "yyyy-MM-dd HH:mm"
            for entry in entries {
                let when = parseISO(entry["at"] as? String).map { df.string(from: $0) } ?? "?"
                let text = args.flags.contains("raw") ? entry["raw"] as? String ?? entry["text"] as? String : entry["text"] as? String
                print("\(when)\t\(text ?? "")")
            }
        }

    case "last":
        guard let text = DictationHistory.last else { throw CLIError("No dictations yet") }
        if args.flags.contains("copy") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
        print(text)

    case "transcript":
        print(try String(contentsOf: try meetingFile(args, "transcript.md"), encoding: .utf8))

    case "screenshot":
        print(json: try daemonRequest(["cmd": "screenshot"]))

    case "notes":
        let config = Config.load()
        let dir = try Meetings.resolve(args.positional.first, config)
        print(try MeetingNotes.write(dir: dir, config: config).path)

    case "summary":
        print(try String(contentsOf: try meetingFile(args, "summary.md"), encoding: .utf8))

    case "path":
        print(try Meetings.resolve(args.positional.first, Config.load()).path)

    case "process":
        let config = Config.load()
        let dir = try Meetings.resolve(args.positional.first, config)
        if sendToDaemon(["cmd": "meeting.process", "dir": dir.path]) != nil {
            print("Queued \(dir.lastPathComponent) in the daemon; check `butter-rec list`.")
        } else {
            try MeetingProcessor.process(dir: dir, config: config, worker: ASRWorker(idleMinutes: 0))
            print(dir.appendingPathComponent("transcript.md").path)
        }

    case "repair":
        let config = Config.load()
        let dir = try Meetings.resolve(args.positional.first, config)
        let wanted = try args.options["factor"].map { value -> Int in
            guard let n = Int(value) else { throw CLIError("--factor needs a whole number") }
            return n
        }
        let factor = try MeetingProcessor.repairSystemSpeed(dir: dir, factor: wanted)
        print("Slowed \(dir.lastPathComponent)'s system audio down \(factor)x (the original is system.orig.wav).")
        if sendToDaemon(["cmd": "meeting.process", "dir": dir.path]) != nil {
            print("Re-transcribing in the daemon; check `butter-rec list`.")
        } else {
            try MeetingProcessor.process(dir: dir, config: config, worker: ASRWorker(idleMinutes: 0))
            print(dir.appendingPathComponent("transcript.md").path)
        }

    case "transcribe":
        guard let file = args.positional.first else { throw CLIError("transcribe <audio-file>") }
        let input = URL(fileURLWithPath: file, relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath))
        let wav = try convertToWav(input)
        defer { try? FileManager.default.removeItem(at: wav) }
        var request: [String: Any] = ["cmd": "transcribe", "audio": wav.path]
        if let engine = args.options["engine"] { request["engine"] = engine }
        if let model = args.options["model"] { request["model"] = model }
        if let reply = sendToDaemon(request) {
            guard reply["ok"] as? Bool == true else { throw CLIError(reply["error"] as? String ?? "transcription failed") }
            print(reply["text"] as? String ?? "")
        } else {
            let config = Config.load()
            let worker = ASRWorker(idleMinutes: 0)
            let t = try worker.transcribeSync(audio: wav, engine: args.options["engine"] ?? config.engine,
                                              model: args.options["model"] ?? config.model, language: config.language,
                                              prompt: config.prompt, segments: true, vad: true)
            worker.stop(reason: "done")
            print(config.applyReplacements(t.paragraphs(pause: config.paragraphPause, maxWords: config.paragraphMaxWords)))
        }

    case "calendar":
        switch args.positional.first ?? "list" {
        case "list":
            if args.flags.contains("json") {
                print(json: sendToDaemon(["cmd": "calendar.list"]) ?? ["ok": true, "events": CalendarStore.load()?.events.map(\.dict) ?? []])
            } else {
                printCalendar()
            }
        case "import":
            let file = args.positional.dropFirst().first ?? "-"
            let data = file == "-" ? FileHandle.standardInput.readDataToEndOfFile()
                : try Data(contentsOf: URL(fileURLWithPath: file, relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)))
            let source = args.options["source"] ?? (file == "-" ? "import" : "import (\(URL(fileURLWithPath: file).lastPathComponent))")
            let result = try CalendarStore.importData(data, source: source)
            let allDay = result.events.filter(\.allDay).count
            print("Kept \(result.events.count) event\(result.events.count == 1 ? "" : "s")\(allDay > 0 ? " (\(allDay) all-day, not nudged)" : "")"
                  + (result.droppedCount > 0 ? ", dropped \(result.droppedCount): \(result.droppedSummary)" : "") + ".")
            print(Paths.calendarFile.path)
            if sendToDaemon(["cmd": "calendar.reload"])?["ok"] as? Bool == true { print("The daemon reloaded it.") }
        case "refresh":
            // In the daemon if it's running (it throws the refresh's error), else here.
            if sendToDaemon(["cmd": "ping"]) != nil {
                _ = try daemonRequest(["cmd": "calendar.refresh"])
            } else if let error = CalendarRefresh.run(config: Config.load()).error {
                throw CLIError(error)
            }
            let status = CalendarRefresh.Status.load()
            print("Fetched \(status.count ?? 0) events from \(status.source ?? "claude") in \(formatDuration(status.elapsed ?? 0)).")
            printCalendar()
        default:
            throw CLIError("calendar [list|import|refresh]")
        }

    case "devices":
        let current = InputDevices.defaultInput()
        let chosen = InputDevices.resolve(Config.load().inputDevice) ?? current
        for device in InputDevices.all() {
            var tags: [String] = []
            if device.id == current?.id { tags.append("system default") }
            if device.id == chosen?.id { tags.append("butter-rec uses this") }
            if device.isBluetooth { tags.append("bluetooth") }
            print(device.name + (tags.isEmpty ? "" : "  (" + tags.joined(separator: ", ") + ")"))
        }

    case "config":
        Config.ensureDefaultFile()
        print(Paths.configFile.path)

    case "logs":
        print(Paths.logFile.path)

    default:
        throw CLIError("Unknown command \"\(command)\"\n\n\(usage)")
    }
}

do {
    try run()
} catch {
    FileHandle.standardError.write("butter-rec: \(error)\n".data(using: .utf8)!)
    exit(1)
}
