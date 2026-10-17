import Foundation

/// meeting.json in each recording folder. The folder name is the meeting id.
struct MeetingMeta {
    var dict: [String: Any]

    var id: String { dict["id"] as? String ?? "" }
    var title: String { dict["title"] as? String ?? "Meeting" }
    var status: String {
        get { dict["status"] as? String ?? "unknown" }
        set { dict["status"] = newValue }
    }
    var startedAt: Date? { parseISO(dict["started_at"] as? String) }
    var duration: Double { (dict["duration"] as? NSNumber)?.doubleValue ?? 0 }
    /// Screenshots taken during it: a path relative to the folder and seconds from the start.
    var screenshots: [(file: String, at: Double)] {
        (dict["screenshots"] as? [[String: Any]] ?? []).compactMap { entry in
            guard let file = entry["file"] as? String else { return nil }
            return (file, (entry["at"] as? NSNumber)?.doubleValue ?? 0)
        }
    }

    static func load(_ dir: URL) -> MeetingMeta? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("meeting.json")),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return MeetingMeta(dict: dict)
    }

    func save(_ dir: URL) {
        let data = jsonString(dict, pretty: true).data(using: .utf8)!
        try? data.write(to: dir.appendingPathComponent("meeting.json"), options: .atomic)
    }

    static func update(_ dir: URL, _ change: (inout MeetingMeta) -> Void) {
        var meta = load(dir) ?? MeetingMeta(dict: ["id": dir.lastPathComponent])
        change(&meta)
        meta.save(dir)
    }
}

enum Meetings {
    static func all(_ config: Config) -> [URL] {
        let root = config.meetingDirectory
        let entries = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        return entries
            .filter { FileManager.default.fileExists(atPath: $0.appendingPathComponent("meeting.json").path) }
            .sorted { $0.lastPathComponent > $1.lastPathComponent }
    }

    static func resolve(_ idOrLatest: String?, _ config: Config) throws -> URL {
        let list = all(config)
        guard let key = idOrLatest, key != "latest", key != "last" else {
            guard let latest = list.first else { throw CLIError("No meetings recorded yet") }
            return latest
        }
        if let exact = list.first(where: { $0.lastPathComponent == key }) { return exact }
        let matches = list.filter { $0.lastPathComponent.contains(key) }
        if matches.count == 1 { return matches[0] }
        throw CLIError(matches.isEmpty ? "No meeting matches \"\(key)\"" : "\"\(key)\" matches \(matches.count) meetings")
    }

    static func newDirectory(title: String?, _ config: Config) throws -> URL {
        let stamp = DateFormatter()
        stamp.dateFormat = "yyyy-MM-dd_HHmm"
        var name = stamp.string(from: Date())
        if let title, !title.isEmpty {
            let slug = title.lowercased()
                .map { $0.isLetter || $0.isNumber ? $0 : "-" }
                .reduce(into: "") { acc, ch in if !(ch == "-" && acc.last == "-") { acc.append(ch) } }
                .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
            if !slug.isEmpty { name += "_" + String(slug.prefix(48)) }
        }
        var dir = config.meetingDirectory.appendingPathComponent(name)
        var n = 2
        while FileManager.default.fileExists(atPath: dir.path) {
            dir = config.meetingDirectory.appendingPathComponent("\(name)-\(n)")
            n += 1
        }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Copies screenshots into the meeting's `screenshots/` folder and lists them
    /// in meeting.json with their time from the start of the meeting.
    static func addScreenshots(_ shots: [(url: URL, at: Double)], to dir: URL) {
        guard !shots.isEmpty else { return }
        let folder = dir.appendingPathComponent("screenshots")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var entries: [[String: Any]] = []
        for shot in shots {
            let target = folder.appendingPathComponent(shot.url.lastPathComponent)
            if shot.url.deletingLastPathComponent().standardizedFileURL != folder.standardizedFileURL {
                do {
                    try FileManager.default.copyItem(at: shot.url, to: target)
                } catch {
                    log("meeting: couldn't copy \(shot.url.lastPathComponent): \(error)")
                    continue
                }
            }
            entries.append(["file": "screenshots/\(target.lastPathComponent)", "at": shot.at])
        }
        MeetingMeta.update(dir) { meta in
            meta.dict["screenshots"] = (meta.dict["screenshots"] as? [[String: Any]] ?? []) + entries
        }
    }

    /// A meeting from a hands-free session's mic recording alone (system audio
    /// wasn't recorded), so switching to Meeting always leaves a meeting.
    static func saveMicOnly(mic: WavSink, origin: Date, title: String, _ config: Config) -> URL? {
        do {
            let dir = try newDirectory(title: title, config)
            try FileManager.default.copyItem(at: mic.url, to: dir.appendingPathComponent("mic.wav"))
            let ended = Date()
            MeetingMeta(dict: [
                "id": dir.lastPathComponent, "title": title, "started_at": isoString(origin), "ended_at": isoString(ended),
                "duration": ended.timeIntervalSince(origin), "status": "recorded", "system_audio": false, "source": "hands_free",
                "mic_offset": mic.firstWriteAt.map { $0.timeIntervalSince(origin) } ?? 0, "warnings": [] as [String],
            ]).save(dir)
            return dir
        } catch {
            log("meeting: couldn't save the recording: \(error)")
            return nil
        }
    }
}

/// A meeting being recorded: mic -> mic.wav ("Me"), system audio -> system.wav ("Them").
final class MeetingRecording {
    let dir: URL
    let title: String
    let startedAt = Date()
    private let mic = MicRecorder()
    private let micSink: WavSink
    private var system: SystemAudioRecorder?
    private var systemSink: WavSink?
    private(set) var warnings: [String] = []

    init(dir: URL, title: String, systemAudio: Bool, inputDevice: InputDevices.Device?) throws {
        self.dir = dir
        self.title = title
        micSink = try WavSink(url: dir.appendingPathComponent("mic.wav"))
        try mic.start(into: micSink, device: inputDevice)
        if systemAudio {
            do {
                let sink = try WavSink(url: dir.appendingPathComponent("system.wav"))
                let recorder = SystemAudioRecorder()
                try recorder.start(into: sink)
                system = recorder
                systemSink = sink
            } catch {
                warnings.append("System audio not recorded: \(error)")
                log("meeting: \(warnings.last!)")
                try? FileManager.default.removeItem(at: dir.appendingPathComponent("system.wav"))
            }
        }
        MeetingMeta(dict: [
            "id": dir.lastPathComponent, "title": title, "started_at": isoString(startedAt),
            "status": "recording", "system_audio": system != nil, "warnings": warnings,
        ]).save(dir)
    }

    var elapsed: Double { Date().timeIntervalSince(startedAt) }
    var micLevel: Float { mic.level }

    func stop() {
        mic.stop()
        system?.stop()
        micSink.close()
        systemSink?.close()
        let ended = Date()
        // Offsets line the two tracks up on one timeline when merging.
        let micOffset = micSink.firstWriteAt.map { $0.timeIntervalSince(startedAt) } ?? 0
        let systemOffset = systemSink?.firstWriteAt.map { $0.timeIntervalSince(startedAt) } ?? 0
        if let systemSink, systemSink.peak < 0.0005 {
            warnings.append("System audio was silent; if you expected audio, grant System Audio Recording to ButterRec in System Settings › Privacy & Security")
        }
        MeetingMeta.update(dir) { meta in
            meta.dict["ended_at"] = isoString(ended)
            meta.dict["duration"] = ended.timeIntervalSince(startedAt)
            meta.dict["mic_offset"] = micOffset
            meta.dict["system_offset"] = systemOffset
            meta.dict["warnings"] = warnings
            meta.status = "recorded"
        }
    }
}

/// What the Mac plays during a hands-free session (the other side of a call in
/// your AirPods, say). The session's mic recording is the "Me" track, so when it
/// ends the pair is saved as a meeting; short or silent sessions leave nothing.
final class CallCapture {
    let dir: URL
    /// The timeline both tracks are offset from: when the hotkey was pressed.
    private let origin: Date
    private let system = SystemAudioRecorder()
    private let sink: WavSink

    init(origin: Date, config: Config) throws {
        self.origin = origin
        dir = try Meetings.newDirectory(title: "Hands-free", config)
        do {
            sink = try WavSink(url: dir.appendingPathComponent("system.wav"))
            try system.start(into: sink)
        } catch {
            try? FileManager.default.removeItem(at: dir)
            throw error
        }
        MeetingMeta(dict: [
            "id": dir.lastPathComponent, "title": "Hands-free call", "started_at": isoString(origin),
            "status": "recording", "system_audio": true, "source": "hands_free", "warnings": [] as [String],
        ]).save(dir)
    }

    /// Stops recording. Keeps the folder as a meeting (returned, ready to process)
    /// when the session ran at least `minSeconds` and the Mac played something,
    /// or always with `title` (the session was switched to Meeting).
    func finish(mic: WavSink, minSeconds: Double, title: String? = nil) -> URL? {
        system.stop()
        sink.close()
        let ended = Date()
        let duration = ended.timeIntervalSince(origin)
        guard title != nil || (duration >= minSeconds && sink.peak >= 0.001) else {
            log("hands-free: no call audio kept (\(formatDuration(duration)), peak \(String(format: "%.4f", sink.peak)))")
            discard()
            return nil
        }
        do {
            // A clone on APFS, so even a long session copies instantly.
            try FileManager.default.copyItem(at: mic.url, to: dir.appendingPathComponent("mic.wav"))
        } catch {
            log("hands-free: couldn't save the mic track: \(error)")
            discard()
            return nil
        }
        MeetingMeta.update(dir) { meta in
            meta.dict["ended_at"] = isoString(ended)
            meta.dict["duration"] = duration
            meta.dict["mic_offset"] = mic.firstWriteAt.map { $0.timeIntervalSince(self.origin) } ?? 0
            meta.dict["system_offset"] = sink.firstWriteAt.map { $0.timeIntervalSince(self.origin) } ?? 0
            if let title { meta.dict["title"] = title }
            meta.status = "recorded"
        }
        log("hands-free: saved the call as meeting \(dir.lastPathComponent) (\(formatDuration(duration)))")
        return dir
    }

    func discard() {
        system.stop()
        sink.close()
        try? FileManager.default.removeItem(at: dir)
    }
}

/// Transcribes both tracks, merges them into one speaker-labelled transcript,
/// then runs the optional summarizer.
enum MeetingProcessor {
    static func process(dir: URL, config: Config, worker: ASRWorker) throws {
        guard let meta = MeetingMeta.load(dir) else { throw CLIError("\(dir.path) has no meeting.json") }
        let engine = config.meetingEngine, model = config.meetingModel
        MeetingMeta.update(dir) { $0.status = "transcribing"; $0.dict["error"] = nil }
        do {
            var segments: [(speaker: String, segment: Segment)] = []
            var usedModel = model
            let tracks: [(file: String, speaker: String, offsetKey: String)] = [
                ("mic.wav", config.meLabel, "mic_offset"),
                ("system.wav", config.themLabel, "system_offset"),
            ]
            for track in tracks {
                let url = dir.appendingPathComponent(track.file)
                guard FileManager.default.fileExists(atPath: url.path) else { continue }
                log("meeting \(meta.id): transcribing \(track.file) with \(engine)")
                let result = try worker.transcribeSync(audio: url, engine: engine, model: model, language: config.language,
                                                       prompt: config.prompt, segments: true, vad: true)
                usedModel = result.model
                let offset = (meta.dict[track.offsetKey] as? NSNumber)?.doubleValue ?? 0
                for var seg in result.segments where !seg.text.isEmpty {
                    seg.text = config.applyReplacements(seg.text)
                    seg.start += offset
                    seg.end += offset
                    segments.append((track.speaker, seg))
                }
            }
            segments = dropBleed(segments, me: config.meLabel)
            segments.sort { $0.segment.start < $1.segment.start }

            let markdown = render(meta: meta, segments: segments, engine: engine, model: usedModel)
            try markdown.write(to: dir.appendingPathComponent("transcript.md"), atomically: true, encoding: .utf8)
            let json: [[String: Any]] = segments.map {
                ["speaker": $0.speaker, "start": $0.segment.start, "end": $0.segment.end, "text": $0.segment.text]
            }
            try jsonString(json, pretty: true).write(to: dir.appendingPathComponent("transcript.json"), atomically: true, encoding: .utf8)
            MeetingMeta.update(dir) { $0.dict["engine"] = engine; $0.dict["model"] = usedModel }

            let command = config.summarizeCommand
            if !command.isEmpty {
                MeetingMeta.update(dir) { $0.status = "summarizing" }
                log("meeting \(meta.id): summarizing")
                let result = try runShell(command, stdin: markdown.data(using: .utf8))
                guard result.status == 0 else {
                    throw CLIError("summarize_command failed (\(result.status)): \(String(data: result.stderr, encoding: .utf8) ?? "")")
                }
                try result.stdout.write(to: dir.appendingPathComponent("summary.md"))
            }
            MeetingMeta.update(dir) { $0.status = "done" }
            log("meeting \(meta.id): done")
        } catch {
            MeetingMeta.update(dir) { $0.status = "error"; $0.dict["error"] = "\(error)" }
            throw error
        }
    }

    /// Without headphones the mic also hears the other side. Drop "Me" segments
    /// that overlap a system-audio segment saying mostly the same words.
    static func dropBleed(_ segments: [(speaker: String, segment: Segment)], me: String) -> [(speaker: String, segment: Segment)] {
        func words(_ s: String) -> Set<String> {
            Set(s.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init))
        }
        let others = segments.filter { $0.speaker != me }
        return segments.filter { item in
            guard item.speaker == me else { return true }
            let mine = words(item.segment.text)
            guard !mine.isEmpty else { return false }
            for other in others where other.segment.start < item.segment.end + 1 && other.segment.end > item.segment.start - 1 {
                let theirs = words(other.segment.text)
                let overlap = Double(mine.intersection(theirs).count) / Double(mine.count)
                if overlap >= 0.6 { return false }
            }
            return true
        }
    }

    static func render(meta: MeetingMeta, segments: [(speaker: String, segment: Segment)], engine: String, model: String) -> String {
        let df = DateFormatter()
        df.dateStyle = .medium
        df.timeStyle = .short
        var lines = ["# \(meta.title)", ""]
        if let started = meta.startedAt { lines.append("- **Date:** \(df.string(from: started))") }
        lines.append("- **Duration:** \(formatDuration(meta.duration))")
        lines.append("- **Transcribed with:** \(engine)\(model.isEmpty ? "" : " (\(model))")")
        lines += ["", "## Transcript", ""]
        if segments.isEmpty { lines.append("_No speech detected._") }
        var currentSpeaker: String?
        var paragraph: [String] = []
        func flush() {
            if !paragraph.isEmpty { lines.append(paragraph.joined(separator: " ")); lines.append("") }
            paragraph.removeAll()
        }
        // Screenshots go between what was said before and after them.
        var shots = meta.screenshots.sorted { $0.at < $1.at }[...]
        func placeShots(before time: Double) {
            while let shot = shots.first, shot.at <= time {
                shots.removeFirst()
                flush()
                lines.append("![Screenshot \(formatClock(shot.at))](\(shot.file))")
                lines.append("")
                currentSpeaker = nil
            }
        }
        for item in segments {
            placeShots(before: item.segment.start)
            if item.speaker != currentSpeaker {
                flush()
                currentSpeaker = item.speaker
                lines.append("**\(item.speaker)** [\(formatClock(item.segment.start))]")
            }
            paragraph.append(item.segment.text)
        }
        placeShots(before: .infinity)
        flush()
        return lines.joined(separator: "\n")
    }
}

/// ✦ Notes: meeting notes from the transcript, written by the [cleanup] harness
/// with [meeting] notes_model, saved as notes.md beside the transcript.
enum MeetingNotes {
    static let defaultPrompt = """
    Write notes for this meeting from its transcript below. "Me" is the person who recorded it; "Them" is everyone else on the call (the transcript can't tell those people apart).

    Use Markdown with these sections, leaving out any that would be empty:
    # A short title for the meeting
    ## Summary (2-4 sentences)
    ## Decisions
    ## Action items, as "- [ ] Who: what" (Me, Them, or a name if one was said)
    ## Key points
    ## Open questions

    Keep a screenshot link (![...](...)) under the point it illustrates when it matters.
    Use only what's in the transcript: don't invent names, numbers or dates. Fix words the transcriber clearly misheard.{{vocabulary}}
    Output only the notes.

    <transcript>
    {{transcript}}
    </transcript>
    """

    static func write(dir: URL, config: Config) throws -> URL {
        let transcriptURL = dir.appendingPathComponent("transcript.md")
        guard let transcript = try? String(contentsOf: transcriptURL, encoding: .utf8) else {
            throw CLIError("\(dir.lastPathComponent) has no transcript yet")
        }
        let template = config.notesPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? defaultPrompt : config.notesPrompt
        let spellings = Cleanup.spellings(config)
        let prompt = template
            .replacingOccurrences(of: "{{vocabulary}}", with: spellings.isEmpty ? "" : " Preferred spellings: \(spellings.joined(separator: ", ")).")
            .replacingOccurrences(of: "{{transcript}}", with: transcript)
        let started = Date()
        log("meeting \(dir.lastPathComponent): writing notes with \(config.cleanupHarness) (\(config.notesModel))")
        var notes = try Cleanup.invoke(prompt, config: config, model: config.notesModel,
                                       systemPrompt: "You write meeting notes in Markdown. Output only the notes.", baseTimeout: 60)
        notes = notes.components(separatedBy: "\n").filter { !$0.hasPrefix("```") }.joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !notes.isEmpty else { throw CLIError("the notes came back empty") }
        let url = dir.appendingPathComponent("notes.md")
        try (notes + "\n").write(to: url, atomically: true, encoding: .utf8)
        log("meeting \(dir.lastPathComponent): notes written in \(String(format: "%.1f", Date().timeIntervalSince(started)))s")
        return url
    }
}
