import Accelerate
import AVFoundation
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
    /// Text copied to the clipboard during it, with seconds from the start.
    var clips: [(text: String, at: Double)] {
        (dict["clips"] as? [[String: Any]] ?? []).compactMap { entry in
            guard let text = entry["text"] as? String else { return nil }
            return (text, (entry["at"] as? NSNumber)?.doubleValue ?? 0)
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

    /// Lists copied text in meeting.json with its time from the start of the meeting.
    static func addClips(_ clips: [(text: String, at: Double)], to dir: URL) {
        guard !clips.isEmpty else { return }
        MeetingMeta.update(dir) { meta in
            meta.dict["clips"] = (meta.dict["clips"] as? [[String: Any]] ?? []) + clips.map { ["text": $0.text, "at": $0.at] }
        }
    }

    /// Names for the raw system audio: system-raw.wav, then system-raw-2.wav and
    /// so on (a new file each time the output's sample rate changes).
    static func rawNamer(_ dir: URL, _ config: Config) -> (() -> URL?)? {
        guard config.rawSystemAudio else { return nil }
        var n = 0
        return {
            n += 1
            return dir.appendingPathComponent(n == 1 ? "system-raw.wav" : "system-raw-\(n).wav")
        }
    }

    /// Deletes raw system audio older than raw_audio_days.
    static func pruneRaw(_ config: Config) {
        guard config.rawAudioDays > 0 else { return }
        let fm = FileManager.default
        let cutoff = Date().addingTimeInterval(-config.rawAudioDays * 86400)
        for dir in all(config) {
            for file in (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
            where file.lastPathComponent.hasPrefix("system-raw") {
                let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantFuture
                if modified < cutoff { try? fm.removeItem(at: file) }
            }
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

    init(dir: URL, title: String, config: Config, inputDevice: InputDevices.Device?) throws {
        self.dir = dir
        self.title = title
        micSink = try WavSink(url: dir.appendingPathComponent("mic.wav"))
        try mic.start(into: micSink, device: inputDevice)
        if config.systemAudio {
            do {
                let sink = try WavSink(url: dir.appendingPathComponent("system.wav"))
                let recorder = SystemAudioRecorder()
                try recorder.start(into: sink, raw: Meetings.rawNamer(dir, config))
                system = recorder
                systemSink = sink
            } catch {
                warnings.append("System audio not recorded: \(error)")
                log("meeting: \(warnings.last!)")
                try? FileManager.default.removeItem(at: dir.appendingPathComponent("system.wav"))
            }
        }
        var meta: [String: Any] = [
            "id": dir.lastPathComponent, "title": title, "started_at": isoString(startedAt),
            "status": "recording", "system_audio": system != nil, "warnings": warnings,
        ]
        if let system { meta["system_audio_format"] = system.info }
        MeetingMeta(dict: meta).save(dir)
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
        let report = system?.report
        MeetingMeta.update(dir) { meta in
            meta.dict["ended_at"] = isoString(ended)
            meta.dict["duration"] = ended.timeIntervalSince(startedAt)
            meta.dict["mic_offset"] = micOffset
            meta.dict["system_offset"] = systemOffset
            if let report { meta.dict["system_audio_format"] = report }
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
            try system.start(into: sink, raw: Meetings.rawNamer(dir, config))
        } catch {
            try? FileManager.default.removeItem(at: dir)
            throw error
        }
        MeetingMeta(dict: [
            "id": dir.lastPathComponent, "title": "Hands-free call", "started_at": isoString(origin),
            "status": "recording", "system_audio": true, "source": "hands_free", "warnings": [] as [String],
            "system_audio_format": system.info,
        ]).save(dir)
    }

    /// Stops recording. Keeps the folder as a meeting (returned, ready to process)
    /// when the session ran at least `minSeconds` and the Mac played something,
    /// or always with `title` (the session was switched to Meeting). Otherwise
    /// what the Mac played goes to `keepSystemAs`, if given.
    func finish(mic: WavSink, minSeconds: Double, title: String? = nil, keepSystemAs: URL? = nil) -> URL? {
        system.stop()
        sink.close()
        let report = system.report
        let ended = Date()
        let duration = ended.timeIntervalSince(origin)
        guard title != nil || (duration >= minSeconds && sink.peak >= 0.001) else {
            log("hands-free: not a call (\(formatDuration(duration)), peak \(String(format: "%.4f", sink.peak)))")
            discard(keepSystemAs: keepSystemAs)
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
            meta.dict["system_audio_format"] = report
            if let title { meta.dict["title"] = title }
            meta.status = "recorded"
        }
        log("hands-free: saved the call as meeting \(dir.lastPathComponent) (\(formatDuration(duration)))")
        return dir
    }

    /// Stops and deletes the folder, first moving the system track to
    /// `keepSystemAs` if the Mac played anything.
    func discard(keepSystemAs: URL? = nil) {
        system.stop()
        sink.close()
        if let target = keepSystemAs, sink.peak >= 0.001 {
            do {
                try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                try FileManager.default.moveItem(at: dir.appendingPathComponent("system.wav"), to: target)
            } catch {
                log("hands-free: couldn't keep the system audio: \(error)")
            }
        }
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
            var spoken: [String: Int] = [:]
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
                spoken[track.file] = result.segments.filter { !$0.text.isEmpty }.count
                for var seg in result.segments where !seg.text.isEmpty {
                    seg.text = config.applyReplacements(seg.text)
                    seg.start += offset
                    seg.end += offset
                    segments.append((track.speaker, seg))
                }
            }
            segments = dropBleed(segments, me: config.meLabel)
            segments.sort { $0.segment.start < $1.segment.start }

            let checks = check(dir: dir, meta: meta, spokenSystem: spoken["system.wav"])
            for line in checks { log("meeting \(meta.id): \(line)") }
            MeetingMeta.update(dir) { $0.dict["checks"] = checks }
            let markdown = render(meta: MeetingMeta.load(dir) ?? meta, segments: segments, engine: engine, model: usedModel)
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

    /// Problems worth a look: tracks that don't line up (system audio recorded at
    /// the wrong speed) or system audio with sound but no speech found.
    static func check(dir: URL, meta: MeetingMeta, spokenSystem: Int?) -> [String] {
        guard let system = trackStats(dir.appendingPathComponent("system.wav")) else { return [] }
        var out: [String] = []
        if let mic = trackStats(dir.appendingPathComponent("mic.wav")) {
            // Where each track ends on the meeting's timeline.
            let micEnd = mic.seconds + ((meta.dict["mic_offset"] as? NSNumber)?.doubleValue ?? 0)
            let systemEnd = system.seconds + ((meta.dict["system_offset"] as? NSNumber)?.doubleValue ?? 0)
            if abs(micEnd - systemEnd) > max(2, micEnd * 0.05) {
                let ratio = micEnd / max(systemEnd, 0.1)
                var line = "The system audio track is \(formatDuration(system.seconds)) but the mic track is \(formatDuration(mic.seconds))."
                if abs(ratio - ratio.rounded()) < 0.05 * ratio, ratio.rounded() >= 2 {
                    line += " It looks \(Int(ratio.rounded()))x too fast; `butter-rec repair \(meta.id)` slows it back down."
                }
                out.append(line)
            }
        }
        if spokenSystem == 0, system.rms > 0.003 {
            out.append("No speech was found in the system audio, though it isn't silent.")
        }
        return out
    }

    /// Length and loudness (RMS, 0-1) of a WAV.
    static func trackStats(_ url: URL) -> (seconds: Double, rms: Float)? {
        guard let file = try? AVAudioFile(forReading: url), file.length > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 1 << 16) else { return nil }
        var sum = 0.0, count = 0
        while (try? file.read(into: buffer)) != nil, buffer.frameLength > 0, let data = buffer.floatChannelData?[0] {
            var meanSquare: Float = 0
            vDSP_measqv(data, 1, &meanSquare, vDSP_Length(buffer.frameLength))
            sum += Double(meanSquare) * Double(buffer.frameLength)
            count += Int(buffer.frameLength)
        }
        return (Double(file.length) / file.processingFormat.sampleRate, count > 0 ? Float((sum / Double(count)).squareRoot()) : 0)
    }

    /// For system audio recorded before the sample-rate fix through AirPods in
    /// call mode (24 or 16 kHz, labelled 48 kHz): it's 2x or 3x too fast. Keeps
    /// the original as system.orig.wav and writes system.wav at the right speed.
    /// `factor` defaults to how many times longer the mic track is.
    static func repairSystemSpeed(dir: URL, factor wanted: Int?) throws -> Int {
        let fm = FileManager.default
        let system = dir.appendingPathComponent("system.wav"), original = dir.appendingPathComponent("system.orig.wav")
        let source = fm.fileExists(atPath: original.path) ? original : system
        guard let stats = trackStats(source) else { throw CLIError("\(dir.lastPathComponent) has no system audio") }
        let factor: Int
        if let wanted {
            factor = wanted
        } else {
            guard let mic = trackStats(dir.appendingPathComponent("mic.wav")) else { throw CLIError("no mic track to compare with; pass --factor") }
            let ratio = mic.seconds / stats.seconds
            guard ratio.rounded() >= 2, abs(ratio - ratio.rounded()) < 0.05 * ratio else {
                throw CLIError(String(format: "the mic track is %.2fx as long as the system audio, not a whole multiple; pass --factor if you're sure", ratio))
            }
            factor = Int(ratio.rounded())
        }
        guard factor >= 2 else { throw CLIError("--factor must be 2 or more") }
        if source == system { try fm.moveItem(at: system, to: original) }
        // The samples are right; only their rate was: read them as 16 kHz / factor
        // and resample to 16 kHz.
        let file = try AVAudioFile(forReading: original)
        guard let slow = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: file.processingFormat.sampleRate / Double(factor),
                                       channels: 1, interleaved: false),
              let chunk = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 1 << 15) else {
            throw CLIError("couldn't read \(original.lastPathComponent)")
        }
        let sink = try WavSink(url: system)
        while (try? file.read(into: chunk)) != nil, chunk.frameLength > 0 {
            guard let relabelled = AVAudioPCMBuffer(pcmFormat: slow, frameCapacity: chunk.frameLength),
                  let from = chunk.floatChannelData?[0], let to = relabelled.floatChannelData?[0] else { break }
            relabelled.frameLength = chunk.frameLength
            to.update(from: from, count: Int(chunk.frameLength))
            sink.write(relabelled)
        }
        sink.close()
        MeetingMeta.update(dir) { $0.dict["system_repaired"] = ["factor": factor, "at": isoString(Date())] }
        log("meeting \(dir.lastPathComponent): system audio slowed down \(factor)x (\(formatDuration(stats.seconds)) -> \(formatDuration(sink.seconds)))")
        return factor
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
        let warnings = (meta.dict["warnings"] as? [String] ?? []) + (meta.dict["checks"] as? [String] ?? [])
        if !warnings.isEmpty { lines += [""] + warnings.map { "> ⚠️ \($0)" } }
        lines += ["", "## Transcript", ""]
        if segments.isEmpty { lines.append("_No speech detected._") }
        var currentSpeaker: String?
        var paragraph: [String] = []
        func flush() {
            if !paragraph.isEmpty { lines.append(paragraph.joined(separator: " ")); lines.append("") }
            paragraph.removeAll()
        }
        // Screenshots and copied text go between what was said before and after them.
        let extras = meta.screenshots.map { (at: $0.at, lines: ["![Screenshot \(formatClock($0.at))](\($0.file))"]) }
            + meta.clips.map { (at: $0.at, lines: ["**Copied** [\(formatClock($0.at))]", "", fenced($0.text)]) }
        var pending = extras.sorted { $0.at < $1.at }[...]
        func placeExtras(before time: Double) {
            while let extra = pending.first, extra.at <= time {
                pending.removeFirst()
                flush()
                lines += extra.lines + [""]
                currentSpeaker = nil
            }
        }
        for item in segments {
            placeExtras(before: item.segment.start)
            if item.speaker != currentSpeaker {
                flush()
                currentSpeaker = item.speaker
                lines.append("**\(item.speaker)** [\(formatClock(item.segment.start))]")
            }
            paragraph.append(item.segment.text)
        }
        placeExtras(before: .infinity)
        flush()
        return lines.joined(separator: "\n")
    }

    /// A fenced block whose fence is longer than any run of backticks inside.
    static func fenced(_ text: String) -> String {
        var longest = 0, run = 0
        for ch in text { run = ch == "`" ? run + 1 : 0; longest = max(longest, run) }
        let fence = String(repeating: "`", count: max(3, longest + 1))
        return "\(fence)\n\(text.trimmingCharacters(in: .newlines))\n\(fence)"
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

    Keep a screenshot link (![...](...)) under the point it illustrates when it matters. "Copied" blocks are text Me copied during the meeting; quote them where they matter.
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
