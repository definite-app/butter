import AppKit
import AVFoundation
import ApplicationServices
import Carbon.HIToolbox
import Foundation

/// Unix-socket control channel: one JSON request line in, one JSON reply line out.
final class ControlServer {
    private var fd: Int32 = -1
    private var source: DispatchSourceRead?
    private let handler: ([String: Any]) -> [String: Any]

    init(handler: @escaping ([String: Any]) -> [String: Any]) {
        self.handler = handler
    }

    func start() throws {
        let path = Paths.socket.path
        unlink(path)
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw CLIError("socket() failed") }
        var addr = sockaddr_un.make(path)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0 else { throw CLIError("bind(\(path)) failed: \(String(cString: strerror(errno)))") }
        chmod(path, 0o600)
        listen(fd, 16)
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .global())
        source.setEventHandler { [weak self] in
            guard let self else { return }
            let client = accept(self.fd, nil, nil)
            if client >= 0 { DispatchQueue.global().async { self.serve(client) } }
        }
        source.resume()
        self.source = source
    }

    private func serve(_ client: Int32) {
        defer { close(client) }
        var data = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while !data.contains(10) {
            let n = read(client, &chunk, chunk.count)
            if n <= 0 { break }
            data.append(chunk, count: n)
        }
        let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let reply = handler(request)
        var out = jsonString(reply).data(using: .utf8)!
        out.append(10)
        out.withUnsafeBytes { _ = write(client, $0.baseAddress, out.count) }
    }
}

extension sockaddr_un {
    static func make(_ path: String) -> sockaddr_un {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8.prefix(MemoryLayout.size(ofValue: addr.sun_path) - 1))
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        return addr
    }
}

/// Client side, used by the CLI. Returns nil when no daemon is listening.
func sendToDaemon(_ request: [String: Any]) -> [String: Any]? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var addr = sockaddr_un.make(Paths.socket.path)
    let connected = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard connected == 0 else { return nil }
    var out = jsonString(request).data(using: .utf8)!
    out.append(10)
    _ = out.withUnsafeBytes { write(fd, $0.baseAddress, out.count) }
    var data = Data()
    var chunk = [UInt8](repeating: 0, count: 65536)
    while true {
        let n = read(fd, &chunk, chunk.count)
        if n <= 0 { break }
        data.append(chunk, count: n)
    }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

final class Daemon {
    private var config = Config.load()
    private let hotkeys = HotkeyManager()
    private lazy var server = ControlServer { [unowned self] in self.handle($0) }
    private let worker: ASRWorker
    private let processing = DispatchQueue(label: "app.butter.rec.processing")
    private var processingIDs: [String] = []
    private var hotkeyErrors: [String] = []

    // Dictation
    private var dictationMic: MicRecorder?
    private var dictationSink: WavSink?
    private var dictationStartedAt: Date?
    private var dictationPressedAt: Date?
    private var dictationHandsFree = false
    /// System audio alongside a hands-free session, kept as a meeting if it was a call.
    private var callCapture: CallCapture?
    private var dictationSession = 0
    private var previewTimer: Timer?
    private var previewInFlight = false
    private let hud = HUD()
    private var lastDictation: String?

    // Meeting
    private var meeting: MeetingRecording?

    init() {
        worker = ASRWorker(idleMinutes: config.idleUnloadMinutes)
    }

    func start() throws {
        if sendToDaemon(["cmd": "ping"]) != nil { throw CLIError("butter-rec daemon is already running") }
        try FileManager.default.createDirectory(at: Paths.dictationDir, withIntermediateDirectories: true)
        try server.start()
        hud.onStop = { [unowned self] in
            if self.dictationMic != nil { _ = self.stopDictation() } else if self.meeting != nil { _ = self.stopMeeting() }
        }
        hud.onCancel = { [unowned self] in _ = self.cancelDictation() }
        hud.onCleanup = { [unowned self] in _ = self.stopDictation(cleanup: true) }
        hud.showCleanup = config.cleanupButton
        hud.historyProvider = {
            DictationHistory.recent(limit: 6).compactMap { entry in
                (entry["text"] as? String).map { HUDHistoryItem(text: $0, at: parseISO(entry["at"] as? String)) }
            }
        }
        hud.onPickHistory = { [unowned self] text in self.setClipboard(text) }
        hotkeys.install()
        registerHotkeys()
        requestPermissions()
        resumeUnprocessedMeetings()
        log("daemon started (pid \(getpid())); config \(Paths.configFile.path)")
    }

    func shutdown() {
        if let meeting {
            log("shutting down mid-meeting; finalizing \(meeting.dir.lastPathComponent)")
            meeting.stop()
        }
        dictationMic?.stop()
        dictationSink?.close()
        if let callCapture, let sink = dictationSink {
            // Saved as "recorded"; the next daemon start transcribes it.
            _ = callCapture.finish(mic: sink, minSeconds: config.handsFreeCallMinSeconds)
        }
        worker.stop(reason: "shutdown")
        unlink(Paths.socket.path)
    }

    // MARK: - Config / hotkeys / permissions

    private func registerHotkeys() {
        hotkeys.unregisterAll()
        hotkeyErrors.removeAll()
        let bindings: [(String, String, (Bool) -> Void)] = [
            ("dictation", config.dictationHotkey, { [unowned self] pressed in self.dictationHotkey(pressed) }),
            ("hands-free", config.handsFreeHotkey, { [unowned self] pressed in self.handsFreeHotkey(pressed) }),
            ("paste-last", config.pasteLastHotkey, { [unowned self] pressed in if pressed { _ = self.pasteLast() } }),
            ("meeting", config.meetingHotkey, { [unowned self] pressed in if pressed { _ = self.toggleMeeting(title: nil) } }),
        ]
        for (name, text, handler) in bindings where !text.isEmpty {
            do {
                try hotkeys.register(try HotkeySpec.parse(text), handler: handler)
            } catch {
                hotkeyErrors.append("\(name): \(error)")
                log("hotkey \(name): \(error)")
            }
        }
    }

    private func reload() {
        config = Config.load()
        worker.idleMinutes = config.idleUnloadMinutes
        hud.showCleanup = config.cleanupButton
        registerHotkeys()
        log("config reloaded")
    }

    private func requestPermissions() {
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { granted in log("microphone access \(granted ? "granted" : "denied")") }
        }
        if config.dictationOutput == "paste" && !AXIsProcessTrusted() {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        }
    }

    private var permissions: [String: String] {
        let mic: String
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: mic = "granted"
        case .denied, .restricted: mic = "denied"
        default: mic = "not requested"
        }
        return ["microphone": mic, "accessibility": AXIsProcessTrusted() ? "granted" : "not granted"]
    }

    // MARK: - Dictation

    private func dictationHotkey(_ pressed: Bool) {
        if dictationHandsFree {
            // The push-to-talk key also ends a hands-free session.
            if pressed { _ = stopDictation() }
        } else if config.dictationMode == "toggle" {
            if pressed { _ = toggleDictation() }
        } else if pressed {
            _ = startDictation(handsFree: false)
        } else {
            _ = stopDictation()
        }
    }

    private func handsFreeHotkey(_ pressed: Bool) {
        guard pressed else { return }
        _ = dictationMic == nil ? startDictation(handsFree: true) : stopDictation()
    }

    private func toggleDictation() -> [String: Any] {
        dictationMic == nil ? startDictation(handsFree: true) : stopDictation()
    }

    private func startDictation(handsFree: Bool) -> [String: Any] {
        guard dictationMic == nil else { return ["ok": false, "error": "dictation already running"] }
        let pressedAt = Date()
        let mic = MicRecorder()
        // The pill goes up before anything else so the keystroke feels instant.
        if config.hud {
            hud.position = config.hudPosition
            hud.setCaption(nil)
            hud.show(handsFree ? .handsFree(level: { mic.level }, since: pressedAt) : .recording(level: { mic.level }))
        }
        do {
            let sink = try WavSink(url: Paths.dictationDir.appendingPathComponent("last.wav"), keepSamples: config.livePreview)
            let device = InputDevices.resolve(config.inputDevice)
            try mic.start(into: sink, device: device)
            log("dictation: \(device?.name ?? "default input") started in \(Int(Date().timeIntervalSince(pressedAt) * 1000))ms\(handsFree ? " (hands-free)" : "")")
            dictationSession += 1
            dictationPressedAt = pressedAt
            dictationHandsFree = handsFree
            dictationMic = mic
            dictationSink = sink
            dictationStartedAt = Date()
            // Load the model while the user is still talking.
            worker.preload(engine: config.engine, model: config.model)
            if config.livePreview && config.hud { schedulePreview(session: dictationSession) }
            sound(config.startSound)
            // A meeting already records system audio; otherwise catch the other
            // side in case this hands-free session is really a call.
            // Setting up the tap takes ~0.3-0.5s, so it happens off the main thread.
            if handsFree && config.handsFreeCallAudio && meeting == nil {
                let session = dictationSession, config = self.config
                DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                    let t0 = Date()
                    let capture: CallCapture?
                    do {
                        capture = try CallCapture(origin: pressedAt, config: config)
                        log("hands-free: system audio started in \(Int(Date().timeIntervalSince(t0) * 1000))ms")
                    } catch {
                        capture = nil
                        log("hands-free: not recording system audio: \(error)")
                    }
                    DispatchQueue.main.async {
                        // Stopped or cancelled while the tap was starting.
                        guard let self, session == self.dictationSession else { capture?.discard(); return }
                        self.callCapture = capture
                    }
                }
            }
            return ["ok": true, "dictation": "recording", "hands_free": handsFree]
        } catch {
            sound(config.errorSound)
            showError()
            log("dictation start failed: \(error)")
            return ["ok": false, "error": "\(error)"]
        }
    }

    /// Ends the recording and discards it.
    private func cancelDictation() -> [String: Any] {
        guard let mic = dictationMic, let sink = dictationSink else { return ["ok": false, "error": "dictation not running"] }
        mic.stop()
        sink.close()
        callCapture?.discard()
        callCapture = nil
        endDictationState()
        restoreHUD()
        return ["ok": true, "dictation": "cancelled"]
    }

    /// Stops, transcribes and pastes. With `cleanup`, the transcript goes through
    /// the [cleanup] harness first.
    private func stopDictation(cleanup: Bool = false) -> [String: Any] {
        guard let mic = dictationMic, let sink = dictationSink else { return ["ok": false, "error": "dictation not running"] }
        if let first = mic.firstBufferAt, let pressed = dictationPressedAt {
            log("dictation: first audio \(Int(first.timeIntervalSince(pressed) * 1000))ms after the hotkey")
        }
        mic.stop()
        sink.close()
        let held = Date().timeIntervalSince(dictationStartedAt ?? Date())
        var callMeeting: String?
        if let capture = callCapture, let dir = capture.finish(mic: sink, minSeconds: config.handsFreeCallMinSeconds) {
            callMeeting = dir.lastPathComponent
            enqueueProcessing(dir)
        }
        callCapture = nil
        endDictationState()
        guard held >= 0.3, sink.seconds > 0.2 else {
            restoreHUD()
            return ["ok": true, "dictation": "discarded (too short)"]
        }
        sound(config.stopSound)
        if config.hud { hud.show(.transcribing) }
        let config = self.config
        // Segments carry the timestamps that turn pauses into paragraph breaks.
        worker.transcribe(audio: sink.url, engine: config.engine, model: config.model, language: config.language,
                          prompt: config.prompt, segments: true, vad: false) { [weak self] result in
            DispatchQueue.main.async { self?.finishDictation(result, audioSeconds: sink.seconds, cleanup: cleanup, meeting: callMeeting) }
        }
        return ["ok": true, "dictation": "transcribing", "seconds": sink.seconds, "cleanup": cleanup, "meeting": callMeeting ?? NSNull()]
    }

    private func endDictationState() {
        dictationMic = nil
        dictationSink = nil
        dictationStartedAt = nil
        dictationHandsFree = false
        dictationSession += 1  // invalidates in-flight previews
        previewTimer?.invalidate()
        previewTimer = nil
    }

    /// Live text: every interval, re-transcribe the last ~20s and show it in the HUD.
    /// One request in flight at a time; stale results are dropped by session id.
    private func schedulePreview(session: Int) {
        previewTimer?.invalidate()
        let interval = Double(max(300, config.previewIntervalMs)) / 1000
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in self?.runPreview(session: session) }
        RunLoop.main.add(timer, forMode: .common)
        previewTimer = timer
    }

    private func runPreview(session: Int) {
        guard session == dictationSession, !previewInFlight, let sink = dictationSink, sink.seconds > 0.6 else { return }
        let url = Paths.dictationDir.appendingPathComponent("preview.wav")
        guard sink.writeTail(seconds: 20, to: url) else { return }
        previewInFlight = true
        let config = self.config
        worker.transcribe(audio: url, engine: config.engine, model: config.model, language: config.language,
                          prompt: config.prompt, segments: false, vad: false) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.previewInFlight = false
                guard session == self.dictationSession, case let .success(t) = result else { return }
                self.hud.setCaption(t.text)
            }
        }
    }

    private func finishDictation(_ result: Result<Transcription, CLIError>, audioSeconds: Double, cleanup: Bool, meeting: String?) {
        switch result {
        case let .failure(error):
            sound(config.errorSound)
            if dictationMic == nil { showError() }
            log("dictation failed: \(error)")
        case let .success(transcription):
            let text = transcription.paragraphs(pause: config.paragraphPause, maxWords: config.paragraphMaxWords)
            log("dictation: \(String(format: "%.1f", audioSeconds))s audio -> \(text.count) chars in \(String(format: "%.2f", transcription.elapsed))s")
            guard cleanup, !text.isEmpty else {
                deliver(text, transcription: transcription, audioSeconds: audioSeconds, cleanup: nil, meeting: meeting)
                return
            }
            if config.hud && dictationMic == nil {
                hud.show(.cleaning)
                hud.setCaption(text)
            }
            let config = self.config
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let outcome = Cleanup.run(text, config: config)
                DispatchQueue.main.async {
                    self?.deliver(outcome.text, transcription: transcription, audioSeconds: audioSeconds, cleanup: outcome, meeting: meeting)
                }
            }
        }
    }

    /// Saves to history and pastes/copies, per [dictation] output.
    private func deliver(_ text: String, transcription: Transcription, audioSeconds: Double, cleanup: Cleanup.Outcome?, meeting callMeeting: String?) {
        // A new dictation may have started while this one was transcribing or
        // cleaning up; leave its pill alone.
        if dictationMic == nil {
            if let cleanup, !cleanup.cleaned, config.hud, meeting == nil {
                hud.setCaption(nil)
                hud.show(.message("Pasted without cleanup"))
            } else if callMeeting != nil, config.hud, meeting == nil {
                hud.setCaption(nil)
                hud.show(.message("Call saved as a meeting"))
            } else {
                restoreHUD()
            }
        }
        guard !text.isEmpty else { return }
        lastDictation = text
        appendHistory(text, transcription: transcription, audioSeconds: audioSeconds, cleanup: cleanup, meeting: callMeeting)
        switch config.dictationOutput {
        case "paste": paste(text)
        case "clipboard": setClipboard(text)
        default: break
        }
    }

    private func pasteLast() -> [String: Any] {
        guard let text = lastDictation ?? DictationHistory.last else {
            sound(config.errorSound)
            return ["ok": false, "error": "no dictation yet"]
        }
        paste(text)
        return ["ok": true, "text": text]
    }

    /// After dictation: back to the meeting pill if one is recording, else hide.
    private func restoreHUD() {
        guard config.hud else { return }
        hud.setCaption(nil)
        if let meeting {
            hud.show(.meeting(level: { [weak meeting] in meeting?.micLevel ?? 0 }, since: meeting.startedAt))
        } else {
            hud.hide()
        }
    }

    private func showError() {
        guard config.hud else { return }
        hud.setCaption(nil)
        hud.show(.error)
    }

    private func appendHistory(_ text: String, transcription: Transcription, audioSeconds: Double, cleanup: Cleanup.Outcome?, meeting: String?) {
        var entry: [String: Any] = ["at": isoString(Date()), "text": text, "engine": transcription.engine,
                                    "model": transcription.model, "seconds": audioSeconds, "elapsed": transcription.elapsed]
        if let meeting { entry["meeting"] = meeting }
        if let cleanup {
            // "text" is what was pasted; "raw" is what the transcriber heard.
            entry["raw"] = cleanup.raw
            entry["cleanup"] = cleanup.cleaned
                ? ["harness": config.cleanupHarness, "model": config.cleanupModel, "elapsed": cleanup.elapsed] as [String: Any]
                : ["failed": cleanup.fallbackReason ?? "", "elapsed": cleanup.elapsed] as [String: Any]
        }
        let url = Paths.dictationDir.appendingPathComponent("history.jsonl")
        let line = (jsonString(entry) + "\n").data(using: .utf8)!
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(line)
            try? handle.close()
        } else {
            try? line.write(to: url)
        }
    }

    private func setClipboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    private func paste(_ text: String) {
        let pasteboard = NSPasteboard.general
        let previous = pasteboard.string(forType: .string)
        setClipboard(text)
        guard AXIsProcessTrusted() else {
            log("paste: Accessibility not granted to ButterRec; left text on the clipboard")
            return
        }
        let source = CGEventSource(stateID: .combinedSessionState)
        let v = CGKeyCode(kVK_ANSI_V)
        let down = CGEvent(keyboardEventSource: source, virtualKey: v, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: v, keyDown: false)
        down?.flags = .maskCommand
        up?.flags = .maskCommand
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
        if config.restoreClipboard, let previous {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                // Only restore if nothing else has touched the clipboard since.
                if pasteboard.string(forType: .string) == text { self.setClipboard(previous) }
            }
        }
    }

    // MARK: - Meetings

    private func toggleMeeting(title: String?) -> [String: Any] {
        meeting == nil ? startMeeting(title: title) : stopMeeting()
    }

    private func startMeeting(title: String?) -> [String: Any] {
        if let meeting { return ["ok": false, "error": "already recording \(meeting.dir.lastPathComponent)"] }
        do {
            let dir = try Meetings.newDirectory(title: title, config)
            let recording = try MeetingRecording(dir: dir, title: title ?? "Meeting", systemAudio: config.systemAudio,
                                                 inputDevice: InputDevices.resolve(config.inputDevice))
            meeting = recording
            sound(config.startSound)
            if dictationMic == nil { restoreHUD() }
            log("meeting started: \(dir.path)")
            return ["ok": true, "meeting": dir.lastPathComponent, "dir": dir.path, "warnings": recording.warnings]
        } catch {
            sound(config.errorSound)
            if dictationMic == nil { showError() }
            log("meeting start failed: \(error)")
            return ["ok": false, "error": "\(error)"]
        }
    }

    private func stopMeeting() -> [String: Any] {
        guard let recording = meeting else { return ["ok": false, "error": "no meeting is recording"] }
        recording.stop()
        meeting = nil
        sound(config.stopSound)
        if config.hud && dictationMic == nil { hud.show(.message("Meeting saved · transcribing")) }
        log("meeting stopped: \(recording.dir.path) (\(formatDuration(recording.elapsed)))")
        enqueueProcessing(recording.dir)
        return ["ok": true, "meeting": recording.dir.lastPathComponent, "dir": recording.dir.path,
                "duration": recording.elapsed, "warnings": recording.warnings]
    }

    private func enqueueProcessing(_ dir: URL) {
        let id = dir.lastPathComponent
        guard !processingIDs.contains(id) else { return }
        processingIDs.append(id)
        MeetingMeta.update(dir) { $0.status = "queued" }
        let config = self.config
        processing.async { [weak self] in
            guard let self else { return }
            do {
                try MeetingProcessor.process(dir: dir, config: config, worker: self.worker)
            } catch {
                log("meeting \(id) processing failed: \(error)")
            }
            DispatchQueue.main.async { self.processingIDs.removeAll { $0 == id } }
        }
    }

    /// Recordings that were stopped (or cut off by a restart) but never transcribed.
    private func resumeUnprocessedMeetings() {
        for dir in Meetings.all(config) {
            guard var meta = MeetingMeta.load(dir) else { continue }
            switch meta.status {
            case "recording":
                meta.status = "recorded"
                meta.save(dir)
                enqueueProcessing(dir)
            case "recorded", "queued", "transcribing", "summarizing":
                enqueueProcessing(dir)
            default:
                break
            }
        }
    }

    // MARK: - Control requests

    /// Called on a socket thread. Long-running transcription stays here so the
    /// main thread (hotkeys, recording state) never blocks; everything else hops to main.
    private func handle(_ request: [String: Any]) -> [String: Any] {
        if request["cmd"] as? String == "transcribe" {
            guard let audio = request["audio"] as? String else { return ["ok": false, "error": "missing audio"] }
            let config = DispatchQueue.main.sync { self.config }
            do {
                let t = try worker.transcribeSync(audio: URL(fileURLWithPath: audio), engine: request["engine"] as? String ?? config.engine,
                                                  model: request["model"] as? String ?? config.model, language: config.language,
                                                  prompt: config.prompt, segments: true, vad: request["vad"] as? Bool ?? true)
                return ["ok": true, "text": t.paragraphs(pause: config.paragraphPause, maxWords: config.paragraphMaxWords),
                        "engine": t.engine, "model": t.model, "elapsed": t.elapsed]
            } catch {
                return ["ok": false, "error": "\(error)"]
            }
        }
        return DispatchQueue.main.sync { handleOnMain(request) }
    }

    private func handleOnMain(_ request: [String: Any]) -> [String: Any] {
        switch request["cmd"] as? String ?? "" {
        case "ping":
            return ["ok": true]
        case "status":
            return status()
        case "reload":
            reload()
            return ["ok": hotkeyErrors.isEmpty, "hotkey_errors": hotkeyErrors]
        case "meeting.start":
            return startMeeting(title: request["title"] as? String)
        case "meeting.stop":
            return stopMeeting()
        case "meeting.toggle":
            return toggleMeeting(title: request["title"] as? String)
        case "meeting.process":
            guard let dir = request["dir"] as? String else { return ["ok": false, "error": "missing dir"] }
            enqueueProcessing(URL(fileURLWithPath: dir))
            return ["ok": true, "queued": URL(fileURLWithPath: dir).lastPathComponent]
        case "dictate.start":
            return startDictation(handsFree: true)
        case "dictate.cancel":
            return cancelDictation()
        case "dictate.paste_last":
            return pasteLast()
        case "dictate.stop":
            return stopDictation(cleanup: request["cleanup"] as? Bool ?? false)
        case "dictate.toggle":
            return toggleDictation()
        default:
            return ["ok": false, "error": "unknown command \(request["cmd"] ?? "")"]
        }
    }

    private func status() -> [String: Any] {
        var out: [String: Any] = [
            "ok": true, "pid": Int(getpid()), "config": Paths.configFile.path,
            "engine": config.engine, "model": config.model.isEmpty ? "(default)" : config.model,
            "worker": worker.isRunning ? "warm" : "stopped",
            "hotkeys": ["dictation": "\(config.dictationHotkey) (\(config.dictationMode))", "hands_free": config.handsFreeHotkey,
                        "paste_last": config.pasteLastHotkey, "meeting": config.meetingHotkey],
            "permissions": permissions, "processing": processingIDs,
            "cleanup": ["button": config.cleanupButton, "harness": config.cleanupHarness,
                        "model": config.cleanupHarness == "claude" ? config.cleanupModel : config.cleanupCommand],
        ]
        if !hotkeyErrors.isEmpty { out["hotkey_errors"] = hotkeyErrors }
        if let meeting {
            out["meeting"] = ["id": meeting.dir.lastPathComponent, "title": meeting.title, "elapsed": meeting.elapsed]
        }
        if let dictationStartedAt {
            out["dictation"] = ["elapsed": Date().timeIntervalSince(dictationStartedAt),
                                "call_audio": callCapture?.dir.lastPathComponent ?? NSNull()] as [String: Any]
        }
        if let lastDictation { out["last_dictation"] = lastDictation }
        return out
    }

    /// A path, a sound shipped in the bundle (butter-start/stop/error), or a macOS sound name.
    private func sound(_ name: String) {
        guard config.sounds, !name.isEmpty else { return }
        let sound = name.contains("/") ? NSSound(contentsOfFile: Paths.expand(name).path, byReference: true)
                                       : NSSound(named: NSSound.Name(name))
        guard let sound else {
            log("sound \"\(name)\" not found")
            return
        }
        sound.volume = Float(max(0, min(1, config.soundVolume)))
        sound.play()
    }
}
