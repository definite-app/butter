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
    /// The dictation this press of the dictation hotkey started, while it's held.
    private var heldSession: Int?
    /// The dictation hotkey went down during hands-free: stop when it's let go
    /// (unless it turns out to be part of the hands-free hotkey).
    private var stopOnRelease = false
    /// cancel_hotkey (Esc), registered only while a hands-free session runs.
    private var cancelHotkeyID: UInt32?
    /// screenshot_hotkey, registered only while a hands-free session or a meeting runs.
    private var screenshotHotkeyID: UInt32?
    /// The hands-free session was switched to Meeting: it's saved as a meeting and nothing is pasted.
    private var dictationAsMeeting = false
    /// Screenshots taken this session, with seconds since the hotkey.
    private var sessionShots: [(url: URL, at: Double)] = []
    /// Text copied this session, with seconds since the hotkey.
    private var sessionClips: [(text: String, at: Double)] = []
    /// capture_clipboard: polls the clipboard while a hands-free session or meeting runs.
    private var clipboardTimer: Timer?
    private var clipboardSeen = 0
    /// A change not read yet, and when it was first seen. It's read once it has
    /// held for a moment: apps can clear the clipboard well before they write to
    /// it, and AppKit caches what it reads for each change.
    private var clipboardPending: (count: Int, since: Date)?
    /// The clipboard change made by ButterRec itself (pasting, Copy), not to be captured.
    private var ownClipboardChange = -1
    private var callCaptureStarting = false
    private var previewTimer: Timer?
    private var previewInFlight = false
    private let hud = HUD()
    private let menuBar = MenuBar()
    private var lastDictation: String?

    // Meeting
    private var meeting: MeetingRecording?
    private var meetingShots = 0
    /// Meetings that say on the pill when their transcript is ready.
    private var announced: Set<String> = []
    /// The meeting being transcribed for the pill ("Transcribing meeting · 32 min").
    private var processingPill: (id: String, label: String)?
    /// A finished meeting on the ready pill, until dismissed.
    private var readyMeeting: URL?
    private var notesInFlight: Set<String> = []

    // Calendar
    private var calendarTimer: Timer?
    private var calendarModified: Date?
    private var calendarSnapshot: CalendarStore.Snapshot?
    private var calendarStatus = CalendarRefresh.Status.load()
    private var calendarRefreshing = false
    /// Refreshes run one at a time, from the timer or `butter-rec calendar refresh`.
    private let calendarQueue = DispatchQueue(label: "app.butter.rec.calendar")
    /// Events already nudged about (id|start), so each gets one nudge.
    private var nudged: Set<String> = []
    /// The event on the nudge pill, until it's recorded, dismissed, or 5 min after it starts.
    private var nudge: CalendarEvent?
    private var nudgeDetail = ""

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
        hud.onMode = { [unowned self] meeting in self.setSessionMeeting(meeting) }
        hud.onScreenshot = { [unowned self] in self.takeScreenshot() }
        hud.onOpen = { [unowned self] in
            guard let dir = self.readyMeeting else { return }
            self.openMeeting(dir)
            self.dismissReady()
        }
        hud.onCopy = { [unowned self] in if let dir = self.readyMeeting { self.copyMeeting(dir) } }
        hud.onNotes = { [unowned self] in if let dir = self.readyMeeting { self.writeNotes(dir) } }
        hud.onDismiss = { [unowned self] in self.dismissReady() }
        hud.onRecord = { [unowned self] in
            guard let event = self.nudge else { return }
            self.clearNudge()
            _ = self.startMeeting(title: event.title, event: event)
        }
        hud.onNudgeDismiss = { [unowned self] in
            log("calendar: nudge for \"\(self.nudge?.title ?? "")\" dismissed")
            self.clearNudge()
        }
        hud.historyProvider = { [unowned self] in self.historyItems() }
        hud.onPickHistory = { [unowned self] text in self.setClipboard(text) }
        hud.onMeetingAction = { [unowned self] dir, action in
            switch action {
            case .open: self.openMeeting(dir)
            case .copy: self.copyMeeting(dir)
            case .notes: self.writeNotes(dir)
            }
        }
        menuBar.stateProvider = { [unowned self] full in self.menuBarState(full: full) }
        menuBar.onAction = { [unowned self] action in self.menuBarAction(action) }
        hotkeys.install()
        registerHotkeys()
        requestPermissions()
        resumeUnprocessedMeetings()
        startCalendar()
        menuBar.setEnabled(config.menuBar)
        let config = self.config
        DispatchQueue.global(qos: .utility).async {
            Meetings.pruneRaw(config)
            _ = Cleanup.loginEnvironment()  // so the first cleanup doesn't wait for the shell
        }
        log("daemon started (pid \(getpid())); config \(Paths.configFile.path)")
    }

    func shutdown() {
        if let meeting {
            log("shutting down mid-meeting; finalizing \(meeting.dir.lastPathComponent)")
            meeting.stop()
        }
        dictationMic?.stop()
        dictationSink?.close()
        if let callCapture, let sink = dictationSink,
           // Saved as "recorded"; the next daemon start transcribes it.
           let dir = callCapture.finish(mic: sink, minSeconds: config.handsFreeCallMinSeconds, title: dictationAsMeeting ? "Meeting" : nil) {
            Meetings.attachCalendarEvent(dir, userTitle: false)
        }
        worker.stop(reason: "shutdown")
        unlink(Paths.socket.path)
    }

    // MARK: - Config / hotkeys / permissions

    private func registerHotkeys() {
        hotkeys.unregisterAll()
        cancelHotkeyID = nil
        screenshotHotkeyID = nil
        hotkeyErrors.removeAll()
        let bindings: [(String, String, HotkeyManager.Handler)] = [
            ("dictation", config.dictationHotkey, { [unowned self] event in self.dictationHotkey(event) }),
            ("hands-free", config.handsFreeHotkey, { [unowned self] event in if event == .pressed { self.handsFreeHotkey() } }),
            ("paste-last", config.pasteLastHotkey, { [unowned self] event in if event == .pressed { _ = self.pasteLast() } }),
            ("meeting", config.meetingHotkey, { [unowned self] event in if event == .pressed { _ = self.toggleMeeting(title: nil) } }),
        ]
        for (name, text, handler) in bindings where !text.isEmpty {
            do {
                try hotkeys.register(try HotkeySpec.parse(text), handler: handler)
            } catch {
                hotkeyErrors.append("\(name): \(error)")
                log("hotkey \(name): \(error)")
            }
        }
        updateSessionHotkeys()
    }

    /// Esc (cancel) and the screenshot hotkey only matter during a session, so
    /// they're only taken from other apps while one runs.
    private func updateSessionHotkeys() {
        let handsFree = dictationMic != nil && dictationHandsFree
        sessionHotkey(&cancelHotkeyID, "cancel", config.cancelHotkey, wanted: handsFree) { [unowned self] in
            if self.dictationHandsFree { _ = self.cancelDictation() }
        }
        sessionHotkey(&screenshotHotkeyID, "screenshot", config.screenshotHotkey, wanted: handsFree || meeting != nil) { [unowned self] in
            self.takeScreenshot()
        }
        watchClipboard(config.captureClipboard && (handsFree || meeting != nil))
    }

    private func sessionHotkey(_ id: inout UInt32?, _ name: String, _ text: String, wanted: Bool, action: @escaping () -> Void) {
        if wanted, !text.isEmpty, id == nil {
            do {
                id = try hotkeys.register(try HotkeySpec.parse(text)) { event in if event == .pressed { action() } }
            } catch {
                log("hotkey \(name): \(error)")
            }
        } else if !wanted, let registered = id {
            hotkeys.unregister(registered)
            id = nil
        }
    }

    private func reload() {
        config = Config.load()
        Cleanup.forgetEnvironment()
        worker.idleMinutes = config.idleUnloadMinutes
        hud.showCleanup = config.cleanupButton
        registerHotkeys()
        menuBar.setEnabled(config.menuBar)
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

    private func dictationHotkey(_ event: HotkeyEvent) {
        switch event {
        case .pressed:
            if dictationHandsFree {
                // The push-to-talk key also ends a hands-free session, once it's
                // let go: with fn+shift and fn+shift+tab, fn+shift comes first.
                stopOnRelease = true
                return
            }
            let idle = dictationMic == nil
            _ = config.dictationMode == "toggle" ? toggleDictation() : startDictation(handsFree: false)
            heldSession = idle && dictationMic != nil ? dictationSession : nil
        case .released:
            // A quick tap (let go within tap_seconds) keeps recording hands-free.
            let tapped = heldSession != nil && heldSession == dictationSession && dictationMic != nil && !dictationHandsFree
                && config.dictationMode != "toggle" && config.tapForHandsFree
                && Date().timeIntervalSince(dictationPressedAt ?? .distantPast) < config.tapSeconds
            heldSession = nil
            if stopOnRelease {
                stopOnRelease = false
                _ = stopDictation()
            } else if tapped {
                switchToHandsFree(meeting: config.handsFreeMode == "meeting")
            } else if !dictationHandsFree && config.dictationMode != "toggle" {
                _ = stopDictation()
            }
        case .interrupted:
            // The modifiers were the start of another shortcut (fn+shift+arrow):
            // drop the dictation they started.
            stopOnRelease = false
            if let session = heldSession, session == dictationSession, dictationMic != nil { _ = cancelDictation() }
            heldSession = nil
        }
    }

    private func handsFreeHotkey() {
        stopOnRelease = false
        if let session = heldSession, session == dictationSession, dictationMic != nil {
            // Pressed while holding the dictation hotkey: keep going hands-free.
            heldSession = nil
            switchToHandsFree(meeting: config.handsFreeMode == "meeting")
            return
        }
        _ = dictationMic == nil ? startDictation(handsFree: true, meeting: config.handsFreeMode == "meeting") : stopDictation()
    }

    /// `meeting`: start on the Meeting side of the switch (hands_free_mode).
    private func switchToHandsFree(meeting: Bool) {
        guard let mic = dictationMic, !dictationHandsFree else { return }
        let since = dictationPressedAt ?? Date()
        dictationHandsFree = true
        if meeting {
            dictationAsMeeting = true
            hud.sessionMeeting = true
            previewTimer?.invalidate()
            previewTimer = nil
            hud.setCaption(nil)
        }
        updateSessionHotkeys()
        menuBar.update()
        if config.hud { hud.show(.handsFree(level: { mic.level }, since: since)) }
        startCallCapture(origin: since, force: meeting)
        log("dictation: switched to hands-free\(meeting ? " (meeting)" : "")")
    }

    /// The pill's Dictate | Meeting switch. Meeting keeps recording (both sides)
    /// and saves it as a meeting on stop instead of pasting; Dictate goes back.
    private func setSessionMeeting(_ on: Bool) {
        guard dictationMic != nil, dictationHandsFree, on != dictationAsMeeting else { return }
        dictationAsMeeting = on
        hud.sessionMeeting = on
        if on {
            previewTimer?.invalidate()
            previewTimer = nil
            hud.setCaption(nil)
            startCallCapture(origin: dictationPressedAt ?? Date(), force: true)
        } else if config.livePreview && config.hud {
            schedulePreview(session: dictationSession)
        }
        log("dictation: switched to \(on ? "meeting" : "dictation")")
    }

    private func toggleDictation() -> [String: Any] {
        dictationMic == nil ? startDictation(handsFree: true) : stopDictation()
    }

    /// `meeting`: a hands-free session that starts on the Meeting side of the switch.
    private func startDictation(handsFree: Bool, meeting asMeeting: Bool = false) -> [String: Any] {
        guard dictationMic == nil else { return ["ok": false, "error": "dictation already running"] }
        let pressedAt = Date()
        let asMeeting = handsFree && asMeeting
        dictationAsMeeting = asMeeting
        sessionShots = []
        sessionClips = []
        hud.sessionMeeting = asMeeting
        hud.screenshotCount = 0
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
            log("dictation: \(device?.name ?? "default input") started in \(Int(Date().timeIntervalSince(pressedAt) * 1000))ms\(handsFree ? asMeeting ? " (hands-free, meeting)" : " (hands-free)" : "")")
            dictationSession += 1
            dictationPressedAt = pressedAt
            dictationHandsFree = handsFree
            dictationMic = mic
            dictationSink = sink
            dictationStartedAt = Date()
            updateSessionHotkeys()
            // Load the model while the user is still talking.
            worker.preload(engine: config.engine, model: config.model)
            if config.livePreview && config.hud && !asMeeting { schedulePreview(session: dictationSession) }
            sound(config.startSound)
            if handsFree { startCallCapture(origin: pressedAt, force: asMeeting) }
            menuBar.update()
            return ["ok": true, "dictation": "recording", "hands_free": handsFree, "mode": asMeeting ? "meeting" : "dictate"]
        } catch {
            sound(config.errorSound)
            showError()
            log("dictation start failed: \(error)")
            return ["ok": false, "error": "\(error)"]
        }
    }

    /// A meeting already records system audio; otherwise catch the other side
    /// in case this hands-free session is really a call. Setting up the tap
    /// takes ~0.3-0.5s, so it happens off the main thread.
    /// `force`: the session was switched to Meeting, so record the other side even
    /// with hands_free_call_audio off.
    private func startCallCapture(origin: Date, force: Bool = false) {
        guard config.handsFreeCallAudio || force, meeting == nil, callCapture == nil, !callCaptureStarting else { return }
        callCaptureStarting = true
        let session = dictationSession, config = self.config
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let t0 = Date()
            let capture: CallCapture?
            do {
                capture = try CallCapture(origin: origin, config: config)
                log("hands-free: system audio started in \(Int(Date().timeIntervalSince(t0) * 1000))ms")
            } catch {
                capture = nil
                log("hands-free: not recording system audio: \(error)")
            }
            DispatchQueue.main.async {
                self?.callCaptureStarting = false
                // Stopped or cancelled while the tap was starting.
                guard let self, session == self.dictationSession, self.dictationMic != nil else { capture?.discard(); return }
                self.callCapture = capture
            }
        }
    }

    /// Ends the recording and discards it.
    private func cancelDictation() -> [String: Any] {
        guard let mic = dictationMic, let sink = dictationSink else { return ["ok": false, "error": "dictation not running"] }
        mic.stop()
        sink.close()
        // Cancelled, but the audio is kept for keep_audio_days in case Esc was a mistake.
        let audio = keepAudio(sink)
        callCapture?.discard(keepSystemAs: audio.system)
        callCapture = nil
        endDictationState()
        restoreHUD()
        return ["ok": true, "dictation": "cancelled", "audio": audio.mic?.path ?? NSNull()]
    }

    /// Stops, transcribes and pastes. With `cleanup`, the transcript goes through
    /// the [cleanup] harness first.
    private func stopDictation(cleanup: Bool = false) -> [String: Any] {
        guard let mic = dictationMic, let sink = dictationSink else { return ["ok": false, "error": "dictation not running"] }
        // A copy made just before stopping, between two looks at the clipboard.
        if clipboardTimer != nil { checkClipboard(settled: true) }
        if let first = mic.firstBufferAt, let pressed = dictationPressedAt {
            log("dictation: first audio \(Int(first.timeIntervalSince(pressed) * 1000))ms after the hotkey")
        }
        mic.stop()
        sink.close()
        let held = Date().timeIntervalSince(dictationStartedAt ?? Date())
        let pressedAt = dictationPressedAt ?? Date()
        let shots = sessionShots
        let clips = sessionClips
        if dictationAsMeeting {
            // Switched to Meeting: keep both sides as a meeting, whatever its length, and paste nothing.
            let dir = callCapture?.finish(mic: sink, minSeconds: 0, title: "Meeting")
                ?? Meetings.saveMicOnly(mic: sink, origin: pressedAt, title: "Meeting", config)
            callCapture = nil
            endDictationState()
            guard let dir else {
                sound(config.errorSound)
                showError()
                return ["ok": false, "error": "couldn't save the meeting"]
            }
            sound(config.stopSound)
            Meetings.attachCalendarEvent(dir, userTitle: false)
            Meetings.addScreenshots(shots, to: dir)
            Meetings.addClips(clips, to: dir)
            announce(dir)
            return ["ok": true, "meeting": dir.lastPathComponent, "dir": dir.path]
        }
        let tooShort = held < 0.3 || sink.seconds <= 0.2
        let audio: (mic: URL?, system: URL?) = tooShort ? (nil, nil) : keepAudio(sink)
        var callMeeting: String?
        if let capture = callCapture,
           let dir = capture.finish(mic: sink, minSeconds: config.handsFreeCallMinSeconds, keepSystemAs: audio.system) {
            callMeeting = dir.lastPathComponent
            Meetings.attachCalendarEvent(dir, userTitle: false)
            Meetings.addScreenshots(shots, to: dir)
            Meetings.addClips(clips, to: dir)
            enqueueProcessing(dir)
        }
        callCapture = nil
        endDictationState()
        // Screenshot paths and copied text go into the text where they were
        // taken (segment times count from the first audio, not the hotkey).
        let audioStart = sink.firstWriteAt.map { $0.timeIntervalSince(pressedAt) } ?? 0
        let inserts = (shots.map { (at: $0.at, text: $0.url.path) } + clips.map { (at: $0.at, text: Self.clipText($0.text)) })
            .map { (at: max(0, $0.at - audioStart), text: $0.text) }
        guard !tooShort else {
            restoreHUD()
            return ["ok": true, "dictation": "discarded (too short)"]
        }
        sound(config.stopSound)
        if config.hud { hud.show(.transcribing) }
        let config = self.config
        // Segments carry the timestamps that turn pauses into paragraph breaks.
        worker.transcribe(audio: sink.url, engine: config.engine, model: config.model, language: config.language,
                          prompt: config.prompt, segments: true, vad: false) { [weak self] result in
            DispatchQueue.main.async {
                self?.finishDictation(result, audioSeconds: sink.seconds, cleanup: cleanup, meeting: callMeeting, inserts: inserts,
                                      audio: audio.mic)
            }
        }
        return ["ok": true, "dictation": "transcribing", "seconds": sink.seconds, "cleanup": cleanup, "meeting": callMeeting ?? NSNull(),
                "audio": audio.mic?.path ?? NSNull()]
    }

    /// Copies the session's mic recording into ~/.butter/dictation/audio
    /// (keep_audio_days), and says where its system audio should go.
    private func keepAudio(_ sink: WavSink) -> (mic: URL?, system: URL?) {
        guard config.keepAudioDays > 0 else { return (nil, nil) }
        let fm = FileManager.default
        let folder = Paths.dictationAudioDir
        let stamp = DateFormatter()
        stamp.dateFormat = "yyyy-MM-dd_HHmmss"
        var name = stamp.string(from: dictationPressedAt ?? Date())
        var n = 2
        while fm.fileExists(atPath: folder.appendingPathComponent(name + ".wav").path) {
            name = stamp.string(from: dictationPressedAt ?? Date()) + "-\(n)"
            n += 1
        }
        let mic = folder.appendingPathComponent(name + ".wav")
        do {
            try fm.createDirectory(at: folder, withIntermediateDirectories: true)
            // A clone on APFS, so it's instant whatever the length.
            try fm.copyItem(at: sink.url, to: mic)
        } catch {
            log("dictation: couldn't keep the audio: \(error)")
            return (nil, nil)
        }
        let cutoff = Date().addingTimeInterval(-config.keepAudioDays * 86400)
        for file in (try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
            let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantFuture
            if modified < cutoff { try? fm.removeItem(at: file) }
        }
        return (mic, folder.appendingPathComponent(name + "-system.wav"))
    }

    private func endDictationState() {
        dictationMic = nil
        dictationSink = nil
        dictationStartedAt = nil
        dictationHandsFree = false
        stopOnRelease = false
        dictationAsMeeting = false
        updateSessionHotkeys()
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
        guard session == dictationSession, !dictationAsMeeting, !previewInFlight, let sink = dictationSink, sink.seconds > 0.6 else { return }
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
                self.hud.setCaption(self.config.applyReplacements(t.text))
            }
        }
    }

    private func finishDictation(_ result: Result<Transcription, CLIError>, audioSeconds: Double, cleanup: Bool, meeting: String?,
                                 inserts: [(at: Double, text: String)] = [], audio: URL? = nil) {
        switch result {
        case let .failure(error):
            sound(config.errorSound)
            if dictationMic == nil { showError() }
            log("dictation failed: \(error)")
        case let .success(transcription):
            // Replacements go on the words before screenshot paths join them.
            var replaced = transcription
            replaced.text = config.applyReplacements(transcription.text)
            replaced.segments = transcription.segments.map { var s = $0; s.text = config.applyReplacements(s.text); return s }
            let text = replaced.paragraphs(pause: config.paragraphPause, maxWords: config.paragraphMaxWords, inserts: inserts)
            log("dictation: \(String(format: "%.1f", audioSeconds))s audio -> \(text.count) chars in \(String(format: "%.2f", transcription.elapsed))s")
            guard cleanup, !text.isEmpty else {
                deliver(text, transcription: transcription, audioSeconds: audioSeconds, cleanup: nil, meeting: meeting, audio: audio)
                return
            }
            if config.hud && dictationMic == nil {
                hud.show(.working("Cleaning up"))
                hud.setCaption(text)
            }
            let config = self.config
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let outcome = Cleanup.run(text, config: config)
                DispatchQueue.main.async {
                    self?.deliver(outcome.text, transcription: transcription, audioSeconds: audioSeconds, cleanup: outcome, meeting: meeting,
                                  audio: audio)
                }
            }
        }
    }

    /// Saves to history and pastes/copies, per [dictation] output.
    private func deliver(_ text: String, transcription: Transcription, audioSeconds: Double, cleanup: Cleanup.Outcome?, meeting callMeeting: String?,
                         audio: URL?) {
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
        appendHistory(text, transcription: transcription, audioSeconds: audioSeconds, cleanup: cleanup, meeting: callMeeting, audio: audio)
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
        menuBar.update()
        guard config.hud else { return }
        hud.setCaption(nil)
        if let meeting {
            hud.screenshotCount = meetingShots
            hud.show(.meeting(level: { [weak meeting] in meeting?.micLevel ?? 0 }, since: meeting.startedAt))
        } else if let nudge {
            let title = nudge.title.count > 36 ? String(nudge.title.prefix(35)) + "…" : nudge.title
            hud.show(.nudge(title: title, detail: nudgeDetail))
        } else if let processingPill {
            hud.show(.processing(processingPill.label))
        } else if let readyMeeting {
            hud.show(.ready(title: "Meeting ready", detail: Self.minutes(MeetingMeta.load(readyMeeting)?.duration ?? 0)))
        } else {
            hud.hide()
        }
    }

    private func showError() {
        guard config.hud else { return }
        hud.setCaption(nil)
        hud.show(.error)
    }

    private func appendHistory(_ text: String, transcription: Transcription, audioSeconds: Double, cleanup: Cleanup.Outcome?, meeting: String?,
                               audio: URL?) {
        var entry: [String: Any] = ["at": isoString(Date()), "text": text, "engine": transcription.engine,
                                    "model": transcription.model, "seconds": audioSeconds, "elapsed": transcription.elapsed]
        if let meeting { entry["meeting"] = meeting }
        if let audio { entry["audio"] = audio.path }
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
        ownClipboardChange = NSPasteboard.general.changeCount
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

    /// Without a title, a meeting started during a calendar event (or up to 10
    /// min before it) is named after it; either way it keeps the event's details.
    private func startMeeting(title: String?, event: CalendarEvent? = nil) -> [String: Any] {
        if let meeting { return ["ok": false, "error": "already recording \(meeting.dir.lastPathComponent)"] }
        let event = event ?? CalendarStore.event(at: Date(), in: calendarSnapshot)
        let title = title.flatMap { $0.trimmed.isEmpty ? nil : $0 } ?? event?.title
        do {
            let dir = try Meetings.newDirectory(title: title, config)
            let recording = try MeetingRecording(dir: dir, title: title ?? "Meeting", config: config,
                                                 inputDevice: InputDevices.resolve(config.inputDevice), event: event)
            meeting = recording
            clearNudge(restore: false)
            meetingShots = 0
            updateSessionHotkeys()
            sound(config.startSound)
            if dictationMic == nil { restoreHUD() }
            log("meeting started: \(dir.path)\(event.map { " (calendar: \($0.title))" } ?? "")")
            return ["ok": true, "meeting": dir.lastPathComponent, "dir": dir.path, "title": recording.title,
                    "calendar_event": event?.id ?? NSNull(), "warnings": recording.warnings]
        } catch {
            sound(config.errorSound)
            if dictationMic == nil { showError() }
            log("meeting start failed: \(error)")
            return ["ok": false, "error": "\(error)"]
        }
    }

    private func stopMeeting() -> [String: Any] {
        guard let recording = meeting else { return ["ok": false, "error": "no meeting is recording"] }
        if clipboardTimer != nil { checkClipboard(settled: true) }
        recording.stop()
        meeting = nil
        updateSessionHotkeys()
        sound(config.stopSound)
        log("meeting stopped: \(recording.dir.path) (\(formatDuration(recording.elapsed)))")
        announce(recording.dir)
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
            Meetings.pruneRaw(config)
            DispatchQueue.main.async {
                self.processingIDs.removeAll { $0 == id }
                self.processingFinished(dir)
            }
        }
    }

    // MARK: - After a meeting

    /// Transcribes a meeting you stopped and says on the pill when it's ready.
    private func announce(_ dir: URL) {
        let id = dir.lastPathComponent
        announced.insert(id)
        processingPill = (id, "Transcribing meeting · \(Self.minutes(MeetingMeta.load(dir)?.duration ?? 0))")
        enqueueProcessing(dir)
        if dictationMic == nil && meeting == nil { restoreHUD() }
    }

    private func processingFinished(_ dir: URL) {
        let id = dir.lastPathComponent
        guard announced.remove(id) != nil else { return }
        if processingPill?.id == id { processingPill = nil }
        let done = MeetingMeta.load(dir)?.status == "done"
        if done { readyMeeting = dir }
        guard dictationMic == nil && meeting == nil else { return }
        if done {
            restoreHUD()
        } else if config.hud {
            hud.show(.message("Couldn't transcribe the meeting"))
        }
    }

    private func dismissReady() {
        readyMeeting = nil
        if dictationMic == nil && meeting == nil { restoreHUD() }
    }

    /// notes.md once written, else the transcript (else the folder, mid-transcription).
    private func meetingDocument(_ dir: URL) -> URL? {
        ["notes.md", "transcript.md"].map { dir.appendingPathComponent($0) }
            .first { FileManager.default.fileExists(atPath: $0.path) }
    }

    private func openMeeting(_ dir: URL) {
        NSWorkspace.shared.open(meetingDocument(dir) ?? dir)
    }

    private func copyMeeting(_ dir: URL) {
        guard let url = meetingDocument(dir), let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        setClipboard(text)
    }

    /// ✦ Notes: writes notes.md with the [cleanup] harness, then opens it.
    private func writeNotes(_ dir: URL) {
        let id = dir.lastPathComponent
        guard !notesInFlight.contains(id) else { return }
        notesInFlight.insert(id)
        if config.hud && dictationMic == nil && meeting == nil { hud.show(.working("Writing notes")) }
        let config = self.config
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Result { try MeetingNotes.write(dir: dir, config: config) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.notesInFlight.remove(id)
                let idle = self.dictationMic == nil && self.meeting == nil
                switch result {
                case let .success(url):
                    NSWorkspace.shared.open(url)
                    if idle { self.restoreHUD() }
                case let .failure(error):
                    log("meeting \(id): notes failed: \(error)")
                    self.sound(config.errorSound)
                    guard idle, config.hud else { return }
                    // Say why: "claude isn't installed", "timed out after 90s", ...
                    var reason = "\(error)".components(separatedBy: "\n").first ?? ""
                    if reason.count > 60 { reason = String(reason.prefix(57)) + "…" }
                    self.hud.show(.message(reason.isEmpty ? "Couldn't write notes" : "Notes failed: \(reason)"), for: 4)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 4.2) {
                        if self.dictationMic == nil && self.meeting == nil && self.readyMeeting != nil { self.restoreHUD() }
                    }
                }
            }
        }
    }

    static func minutes(_ seconds: Double) -> String {
        seconds < 60 ? "\(Int(seconds))s" : "\(Int((seconds / 60).rounded())) min"
    }

    /// Dictations and meetings for the pill's history list, newest first.
    private func historyItems() -> [HUDHistoryItem] {
        let dictations = DictationHistory.recent(limit: 6).compactMap { entry in
            (entry["text"] as? String).map { HUDHistoryItem(text: $0, at: parseISO(entry["at"] as? String)) }
        }
        let meetings = Meetings.all(config).prefix(6).compactMap { dir -> HUDHistoryItem? in
            guard let meta = MeetingMeta.load(dir), meta.status != "recording" else { return nil }
            let detail = meta.status == "done" ? Self.minutes(meta.duration) : meta.status == "error" ? "failed" : "transcribing"
            return HUDHistoryItem(text: meta.title, at: meta.startedAt, meeting: dir, detail: detail)
        }
        return (dictations + meetings).sorted { ($0.at ?? .distantPast) > ($1.at ?? .distantPast) }
    }

    // MARK: - Screenshots

    /// The whole screen under the mouse, right away. During dictation the path
    /// goes into the text where it was taken; in a meeting it's linked from the
    /// transcript at that time.
    private func takeScreenshot() {
        let inDictation = dictationMic != nil
        guard inDictation || meeting != nil else { return }
        guard CGPreflightScreenCaptureAccess() else {
            CGRequestScreenCaptureAccess()
            sound(config.errorSound)
            log("screenshot: Screen Recording isn't allowed for ButterRec")
            if config.hud { hud.flashCard(nil, title: "Screenshots need permission", detail: "Allow ButterRec in Screen Recording") }
            return
        }
        let target = nextShotURL(inDictation: inDictation)
        let session = dictationSession
        let at = sessionTime(inDictation: inDictation)
        let display = Self.displayUnderMouse()
        // Keep the pill out of the shot.
        hud.suspend()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let result = try? runProcess("/usr/sbin/screencapture", ["-x", "-t", "png", "-D", "\(display)", target.path], timeout: 10)
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.hud.resume()
                    guard result?.status == 0, FileManager.default.fileExists(atPath: target.path) else {
                        self.sound(self.config.errorSound)
                        log("screenshot failed: \(result.map { String(data: $0.stderr, encoding: .utf8) ?? "" } ?? "couldn't run screencapture")")
                        return
                    }
                    self.recordScreenshot(target, at: at, session: inDictation ? session : nil)
                }
            }
        }
    }

    /// A new file in the session's screenshots folder (the meeting's, during one).
    private func nextShotURL(inDictation: Bool) -> URL {
        let stamp = DateFormatter()
        stamp.dateFormat = "yyyyMMdd-HHmmss"
        let name = "shot-\(stamp.string(from: Date())).png"
        let folder = inDictation ? Paths.dictationDir.appendingPathComponent("screenshots")
                                 : meeting!.dir.appendingPathComponent("screenshots")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var url = folder.appendingPathComponent(name)
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = folder.appendingPathComponent(name.replacingOccurrences(of: ".png", with: "-\(n).png"))
            n += 1
        }
        return url
    }

    /// Seconds into the hands-free session (from the hotkey) or the meeting.
    private func sessionTime(inDictation: Bool, at time: Date = Date()) -> Double {
        max(0, time.timeIntervalSince(inDictation ? (dictationPressedAt ?? time) : meeting?.startedAt ?? time))
    }

    private func recordScreenshot(_ url: URL, at: Double, session: Int?, copied: Bool = false) {
        let count: Int
        let detail: String
        if let session {
            // The session may have ended while the shot was taken; the file stays.
            guard session == dictationSession, dictationMic != nil else { return }
            sessionShots.append((url, at))
            count = sessionShots.count
            detail = dictationAsMeeting ? "In the meeting at \(formatClock(at))" : "Goes into the text at \(formatClock(at))"
            Self.prune(url.deletingLastPathComponent(), keep: 100)
        } else if let meeting {
            Meetings.addScreenshots([(url, at)], to: meeting.dir)
            meetingShots += 1
            count = meetingShots
            detail = "In the meeting at \(formatClock(at))"
        } else {
            return
        }
        log("screenshot \(count): \(url.path)")
        hud.screenshotCount = count
        if config.hud {
            hud.flashCard(NSImage(contentsOf: url), title: copied ? "Copied image saved" : "Screenshot \(count) saved", detail: detail)
        }
    }

    // MARK: - Clipboard

    private func watchClipboard(_ wanted: Bool) {
        if wanted, clipboardTimer == nil {
            clipboardSeen = NSPasteboard.general.changeCount
            clipboardPending = nil
            let timer = Timer(timeInterval: 0.3, repeats: true) { [weak self] _ in self?.checkClipboard() }
            RunLoop.main.add(timer, forMode: .common)
            clipboardTimer = timer
        } else if !wanted, let timer = clipboardTimer {
            timer.invalidate()
            clipboardTimer = nil
        }
    }

    /// Something new on the clipboard: files go in as their paths, text as it
    /// is, an image (a screenshot copied to the clipboard, say) like a screenshot.
    /// `settled`: read a change now instead of on the next look (when stopping).
    private func checkClipboard(settled: Bool = false) {
        let board = NSPasteboard.general
        let count = board.changeCount
        guard count != clipboardSeen else { return }
        guard count != ownClipboardChange else { clipboardSeen = count; return }
        if clipboardPending?.count != count { clipboardPending = (count, Date()) }
        let firstSeen = clipboardPending?.since ?? Date()
        guard settled || Date().timeIntervalSince(firstSeen) >= 0.5 else { return }
        clipboardPending = nil
        let inDictation = dictationMic != nil && dictationHandsFree
        guard inDictation || meeting != nil else { clipboardSeen = count; return }
        // Password managers mark what they copy; never keep it.
        let concealed = ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType", "org.nspasteboard.AutoGeneratedType"]
        guard !(board.types ?? []).contains(where: { concealed.contains($0.rawValue) }) else { clipboardSeen = count; return }
        let files = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        let text = board.string(forType: .string).flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        let png = files.isEmpty && text == nil ? NSImage(pasteboard: board)?.tiffRepresentation
            .flatMap { NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:]) } : nil
        clipboardSeen = count
        let at = sessionTime(inDictation: inDictation, at: firstSeen)
        if !files.isEmpty {
            recordClip(files.map(\.path).joined(separator: "\n"), at: at, inDictation: inDictation)
        } else if let text {
            recordClip(text, at: at, inDictation: inDictation)
        } else if let png {
            let url = nextShotURL(inDictation: inDictation)
            do {
                try png.write(to: url)
                recordScreenshot(url, at: at, session: inDictation ? dictationSession : nil, copied: true)
            } catch {
                log("clipboard: couldn't save the copied image: \(error)")
            }
        }
    }

    private func recordClip(_ text: String, at: Double, inDictation: Bool) {
        let detail: String
        if inDictation {
            sessionClips.append((text, at))
            detail = dictationAsMeeting ? "In the meeting at \(formatClock(at))" : "Goes into the text at \(formatClock(at))"
        } else if let meeting {
            Meetings.addClips([(text, at)], to: meeting.dir)
            detail = "In the meeting at \(formatClock(at))"
        } else {
            return
        }
        log("clipboard: \(text.count) chars at \(formatClock(at))")
        if config.hud { hud.flashCard(nil, snippet: text, title: "Copied text added", detail: detail) }
    }

    /// Copied text as it goes into a dictation: a line as it is, several lines as a code block.
    static func clipText(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.contains("\n") ? MeetingProcessor.fenced(trimmed) : trimmed
    }

    /// screencapture's -D number for the display under the mouse (1 = main).
    private static func displayUnderMouse() -> Int {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)
        let mouse = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }),
              let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID,
              let index = ids.firstIndex(of: id) else { return 1 }
        return index + 1
    }

    /// Keeps the newest `keep` files, like Butter's pasted images.
    private static func prune(_ folder: URL, keep: Int) {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey]),
              files.count > keep else { return }
        let dated = files.map { ($0, (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
        for (file, _) in dated.sorted(by: { $0.1 > $1.1 }).dropFirst(keep) { try? fm.removeItem(at: file) }
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

    // MARK: - Calendar

    /// Every 15s: re-read upcoming.json when it changes, nudge before calls, and
    /// refresh it through claude when that's due (calendar_refresh).
    private func startCalendar() {
        reloadCalendar()
        let timer = Timer(timeInterval: 15, repeats: true) { [weak self] _ in self?.calendarTick() }
        RunLoop.main.add(timer, forMode: .common)
        calendarTimer = timer
        // Once when the daemon starts, whatever the hour, unless one just ran (a restart).
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, self.config.calendarRefresh == "claude", !self.calendarRefreshing,
                  Date().timeIntervalSince(self.calendarStatus.attemptAt ?? .distantPast) > 300 else { return }
            self.refreshCalendarInBackground()
        }
        updateNudge()
    }

    private func reloadCalendar() {
        calendarModified = CalendarStore.modified
        calendarSnapshot = CalendarStore.load()
        menuBar.update()
    }

    private func calendarTick() {
        if CalendarStore.modified != calendarModified { reloadCalendar() }
        updateNudge()
        let due = Date().timeIntervalSince(calendarStatus.attemptAt ?? .distantPast) >= max(5, config.calendarRefreshMinutes) * 60
        if config.calendarRefresh == "claude", !calendarRefreshing, due, withinHours(config.calendarHours) {
            refreshCalendarInBackground()
        }
    }

    private func refreshCalendarInBackground() {
        calendarRefreshing = true
        menuBar.update()
        let config = self.config
        calendarQueue.async { [weak self] in
            let status = CalendarRefresh.run(config: config)
            DispatchQueue.main.async { self?.calendarRefreshed(status) }
        }
    }

    /// `butter-rec calendar refresh`, on the socket thread: waits for a refresh
    /// already running, and uses it if it finished after this was asked.
    private func refreshCalendarNow() -> [String: Any] {
        let asked = Date()
        let config = DispatchQueue.main.sync { self.config }
        let status: CalendarRefresh.Status = calendarQueue.sync {
            let last = CalendarRefresh.Status.load()
            if let finished = last.finishedAt, finished >= asked { return last }
            DispatchQueue.main.async { self.calendarRefreshing = true }
            return CalendarRefresh.run(config: config)
        }
        DispatchQueue.main.async { self.calendarRefreshed(status) }
        var reply: [String: Any] = ["ok": status.error == nil, "refresh": status.dict]
        if let error = status.error { reply["error"] = error }
        return reply
    }

    private func calendarRefreshed(_ status: CalendarRefresh.Status) {
        calendarStatus = status
        calendarRefreshing = false
        reloadCalendar()
        updateNudge()
    }

    /// "<Title> in 2 min" on the pill before a call (an event with a link or
    /// attendees), once per event, while nothing is recording. It goes away
    /// when recorded, dismissed, or 5 minutes after the event starts.
    private func updateNudge() {
        let now = Date()
        if let current = nudge, now >= current.start.addingTimeInterval(300) || meeting != nil || dictationAsMeeting {
            clearNudge()
        }
        let lead = config.calendarNudgeMinutes * 60
        if nudge == nil, lead > 0, config.hud, dictationMic == nil, meeting == nil, let snapshot = calendarSnapshot, !snapshot.stale,
           let next = snapshot.events.first(where: {
               $0.isMeeting && !nudged.contains($0.key) && now >= $0.start.addingTimeInterval(-lead) && now < $0.start.addingTimeInterval(300)
           }) {
            nudged.insert(next.key)
            nudge = next
            log("calendar: nudging for \"\(next.title)\" (\(next.when))")
        }
        guard let nudge else { return }
        let seconds = nudge.start.timeIntervalSince(now)
        let detail = seconds > 30 ? "in \(max(1, Int((seconds / 60).rounded()))) min"
            : seconds > -60 ? "now" : "started \(Int(-seconds / 60)) min ago"
        guard detail != nudgeDetail else { return }
        nudgeDetail = detail
        if dictationMic == nil && meeting == nil { restoreHUD() }
    }

    private func clearNudge(restore: Bool = true) {
        guard nudge != nil else { return }
        nudge = nil
        nudgeDetail = ""
        if restore && dictationMic == nil && meeting == nil { restoreHUD() }
    }

    /// The calendar part of `status` (and `calendar.list`).
    private func calendarInfo() -> [String: Any] {
        var info = calendarStatus.dict
        info["refresh"] = config.calendarRefresh
        info["refreshing"] = calendarRefreshing
        info["file"] = Paths.calendarFile.path
        let snapshot = calendarSnapshot
        info["updated_at"] = snapshot?.updatedAt.map(isoString) ?? NSNull()
        info["source"] = snapshot?.source ?? NSNull()
        info["events"] = snapshot?.events.count ?? 0
        info["stale"] = snapshot.map { $0.stale } ?? NSNull()
        let now = Date()
        if let next = snapshot?.events.first(where: { $0.isMeeting && $0.start > now }) { info["next"] = "\(next.title), \(next.when)" }
        if let nudge { info["nudge"] = nudge.title }
        return info
    }

    /// Upcoming events today and tomorrow, for a menu bar item.
    private func calendarList() -> [String: Any] {
        let now = Date()
        let end = Calendar.current.date(byAdding: .day, value: 2, to: Calendar.current.startOfDay(for: now)) ?? now
        let events = (calendarSnapshot?.events ?? []).filter { $0.end > now && $0.start < end }.map { event -> [String: Any] in
            var dict = event.dict
            dict["nudge"] = event.isMeeting
            return dict
        }
        return ["ok": true, "events": events, "calendar": calendarInfo()]
    }

    /// Recent meetings, newest first, for a menu bar item.
    private func meetingsList(limit: Int) -> [String: Any] {
        let fm = FileManager.default
        let items = Meetings.all(config).prefix(max(1, limit)).compactMap { dir -> [String: Any]? in
            guard let meta = MeetingMeta.load(dir) else { return nil }
            let live = meeting?.dir.standardizedFileURL == dir.standardizedFileURL
            var item: [String: Any] = [
                "id": dir.lastPathComponent, "title": live ? meeting?.title ?? meta.title : meta.title,
                "started_at": meta.dict["started_at"] ?? NSNull(), "duration": live ? meeting?.elapsed ?? 0 : meta.duration,
                "status": meta.status, "dir": dir.path,
                "transcript": fm.fileExists(atPath: dir.appendingPathComponent("transcript.md").path),
                "notes": fm.fileExists(atPath: dir.appendingPathComponent("notes.md").path),
            ]
            if let event = meta.calendarEvent { item["calendar_event"] = event }
            if let error = meta.dict["error"] { item["error"] = error }
            return item
        }
        return ["ok": true, "meetings": items]
    }

    // MARK: - Menu bar

    /// What the menu bar shows; `full` adds recent meetings and dictations for the panel.
    private func menuBarState(full: Bool) -> MenuBarState {
        var s = MenuBarState()
        if let snapshot = calendarSnapshot {
            s.events = snapshot.events
            s.stale = snapshot.stale
            s.updatedAt = snapshot.updatedAt
        }
        s.refreshMode = config.calendarRefresh
        s.refreshing = calendarRefreshing
        s.refreshError = calendarStatus.error
        s.nudgeMinutes = config.calendarNudgeMinutes
        if let meeting {
            s.recording = .init(title: meeting.title, since: meeting.startedAt, bothSides: meeting.bothSides, ends: meeting.event?.end)
        } else if dictationMic != nil, dictationHandsFree {
            let since = dictationPressedAt ?? Date()
            s.recording = .init(title: dictationAsMeeting ? "Meeting" : "Hands-free dictation", since: since,
                                bothSides: callCapture != nil, ends: CalendarStore.event(at: since, in: calendarSnapshot)?.end)
        }
        s.processing = !processingIDs.isEmpty
        if full {
            s.meetings = Meetings.all(config).prefix(40).compactMap { dir in MeetingMeta.load(dir).map { (dir, $0) } }
            s.dictations = DictationHistory.recent(limit: 5)
        }
        return s
    }

    private func menuBarAction(_ action: MenuBarAction) {
        switch action {
        case let .record(event):
            clearNudge(restore: false)
            _ = startMeeting(title: event.title, event: event)
        case let .join(url):
            NSWorkspace.shared.open(url)
        case .stop:
            if dictationMic != nil { _ = stopDictation() } else if meeting != nil { _ = stopMeeting() }
        case .screenshot:
            // After the panel is gone, so it's not in the shot.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.takeScreenshot() }
        case .showPill:
            showPill()
        case .startMeeting:
            _ = startMeeting(title: nil)
        case .dictate:
            _ = startDictation(handsFree: true)
        case .refresh:
            if !calendarRefreshing { refreshCalendarInBackground() }
        case .settings:
            Config.ensureDefaultFile()
            _ = try? runProcess("/usr/bin/open", ["-t", Paths.configFile.path], timeout: 10)
        case .howToConnect:
            if let url = URL(string: "https://github.com/definite-app/butter/blob/main/recorder/README.md#refresh-with-claude-code") {
                NSWorkspace.shared.open(url)
            }
        case .turnOffCalendar:
            do {
                try Config.set("meeting", "calendar_refresh", "\"off\"")
                reload()
                log("calendar: refresh turned off from the menu bar")
            } catch {
                log("calendar: couldn't turn the refresh off: \(error)")
            }
        case .allRecordings:
            try? FileManager.default.createDirectory(at: config.meetingDirectory, withIntermediateDirectories: true)
            NSWorkspace.shared.open(config.meetingDirectory)
        case let .openTranscript(dir):
            let transcript = dir.appendingPathComponent("transcript.md")
            NSWorkspace.shared.open(FileManager.default.fileExists(atPath: transcript.path) ? transcript : dir)
        case let .openNotes(dir):
            let notes = dir.appendingPathComponent("notes.md")
            if FileManager.default.fileExists(atPath: notes.path) { NSWorkspace.shared.open(notes) } else { writeNotes(dir) }
        case let .copyTranscript(dir):
            if let text = try? String(contentsOf: dir.appendingPathComponent("transcript.md"), encoding: .utf8) { setClipboard(text) }
        case let .reveal(dir):
            NSWorkspace.shared.activateFileViewerSelecting([dir])
        case let .openMeeting(dir):
            openMeeting(dir)
        case let .copyText(text):
            setClipboard(text)
        case let .pasteAgain(text):
            // Once the panel has let go of the keyboard.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.paste(text) }
        }
    }

    /// Brings the session pill back (even with [ui] hud off), where it usually sits.
    private func showPill() {
        if let meeting {
            hud.screenshotCount = meetingShots
            hud.show(.meeting(level: { [weak meeting] in meeting?.micLevel ?? 0 }, since: meeting.startedAt))
        } else if let mic = dictationMic, dictationHandsFree {
            hud.show(.handsFree(level: { mic.level }, since: dictationPressedAt ?? Date()))
        }
    }

    // MARK: - Control requests

    /// Called on a socket thread. Long-running transcription stays here so the
    /// main thread (hotkeys, recording state) never blocks; everything else hops to main.
    private func handle(_ request: [String: Any]) -> [String: Any] {
        // A claude refresh takes a while; it waits here, off the main thread.
        if request["cmd"] as? String == "calendar.refresh" { return refreshCalendarNow() }
        if request["cmd"] as? String == "transcribe" {
            guard let audio = request["audio"] as? String else { return ["ok": false, "error": "missing audio"] }
            let config = DispatchQueue.main.sync { self.config }
            do {
                let t = try worker.transcribeSync(audio: URL(fileURLWithPath: audio), engine: request["engine"] as? String ?? config.engine,
                                                  model: request["model"] as? String ?? config.model, language: config.language,
                                                  prompt: config.prompt, segments: true, vad: request["vad"] as? Bool ?? true)
                return ["ok": true, "text": config.applyReplacements(t.paragraphs(pause: config.paragraphPause, maxWords: config.paragraphMaxWords)),
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
        case "dictate.mode":
            guard dictationMic != nil, dictationHandsFree else { return ["ok": false, "error": "no hands-free session is running"] }
            setSessionMeeting(request["meeting"] as? Bool ?? false)
            return ["ok": true, "mode": dictationAsMeeting ? "meeting" : "dictate"]
        case "screenshot":
            guard dictationMic != nil || meeting != nil else { return ["ok": false, "error": "no session is running"] }
            takeScreenshot()
            return ["ok": true]
        case "calendar.list":
            return calendarList()
        case "calendar.reload":
            reloadCalendar()
            updateNudge()
            return ["ok": true, "events": calendarSnapshot?.events.count ?? 0]
        case "menu.open":
            // For testing and scripts: open (or close) the menu bar panel.
            guard config.menuBar else { return ["ok": false, "error": "menu_bar is off"] }
            request["close"] as? Bool == true ? menuBar.close() : menuBar.open()
            return ["ok": true, "open": menuBar.isOpen]
        case "calendar.dismiss":
            // The nudge pill's ×.
            guard let event = nudge else { return ["ok": false, "error": "no nudge is showing"] }
            log("calendar: nudge for \"\(event.title)\" dismissed")
            clearNudge()
            return ["ok": true, "dismissed": event.id]
        case "meetings.list":
            return meetingsList(limit: request["limit"] as? Int ?? 20)
        case "dictations.list":
            let entries = DictationHistory.recent(limit: request["limit"] as? Int ?? 20, search: request["search"] as? String)
            return ["ok": true, "dictations": entries]
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
            out["dictation"] = ["elapsed": Date().timeIntervalSince(dictationStartedAt), "hands_free": dictationHandsFree,
                                "mode": dictationAsMeeting ? "meeting" : "dictate", "clips": sessionClips.count,
                                "call_audio": callCapture?.dir.lastPathComponent ?? NSNull()] as [String: Any]
        }
        if let lastDictation { out["last_dictation"] = lastDictation }
        out["calendar"] = calendarInfo()
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
