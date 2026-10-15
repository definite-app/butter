import Foundation

struct Segment {
    var start: Double
    var end: Double
    var text: String
}

struct Transcription {
    var text: String
    var segments: [Segment]
    var engine: String
    var model: String
    var elapsed: Double
}

/// Long-lived `uv run --script asr_worker.py serve` process speaking JSON lines,
/// so the model stays warm between dictations. Unloaded after an idle timeout.
final class ASRWorker {
    typealias Completion = (Result<[String: Any], CLIError>) -> Void

    var idleMinutes: Int
    private var process: Process?
    private var stdinHandle: FileHandle?
    private var pending: [String: Completion] = [:]
    private var buffer = Data()
    private let lock = NSLock()
    private var idleTimer: DispatchSourceTimer?

    init(idleMinutes: Int) {
        self.idleMinutes = idleMinutes
    }

    var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return process?.isRunning ?? false
    }

    private func ensureRunning() throws {
        if let process, process.isRunning { return }
        guard let uv = which("uv") else { throw CLIError("uv not found; install it from https://docs.astral.sh/uv/") }
        let worker = Paths.worker
        guard FileManager.default.fileExists(atPath: worker.path) else {
            throw CLIError("ASR worker missing at \(worker.path); re-run recorder/build.sh")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: uv)
        process.arguments = ["run", "--quiet", "--script", worker.path, "serve"]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = Paths.searchPath
        env["PYTHONUNBUFFERED"] = "1"
        process.environment = env
        let inPipe = Pipe(), outPipe = Pipe()
        process.standardInput = inPipe
        process.standardOutput = outPipe
        process.standardError = FileHandle.standardError
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty { self?.consume(data) }
        }
        process.terminationHandler = { [weak self] proc in
            guard let self else { return }
            self.lock.lock()
            let waiting = self.pending
            self.pending.removeAll()
            if self.process === proc {
                self.process = nil
                self.stdinHandle = nil
            }
            self.lock.unlock()
            if proc.terminationReason != .exit || proc.terminationStatus != 0 {
                log("asr worker exited (status \(proc.terminationStatus))")
            }
            for completion in waiting.values { completion(.failure(CLIError("ASR worker exited; see \(Paths.logFile.path)"))) }
        }
        try process.run()
        log("asr worker started (pid \(process.processIdentifier))")
        self.process = process
        stdinHandle = inPipe.fileHandleForWriting
    }

    private func consume(_ data: Data) {
        var replies: [(Completion, [String: Any])] = []
        lock.lock()
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 10) {
            let line = buffer.prefix(upTo: newline)
            buffer = Data(buffer.suffix(from: newline + 1))
            guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            if let id = object["id"] as? String, let completion = pending.removeValue(forKey: id) {
                replies.append((completion, object))
            }
        }
        lock.unlock()
        for (completion, object) in replies {
            if object["ok"] as? Bool == true {
                completion(.success(object))
            } else {
                completion(.failure(CLIError(object["error"] as? String ?? "transcription failed")))
            }
        }
    }

    func send(_ request: [String: Any], completion: @escaping Completion) {
        lock.lock()
        do {
            try ensureRunning()
        } catch {
            lock.unlock()
            completion(.failure(error as? CLIError ?? CLIError("\(error)")))
            return
        }
        let id = UUID().uuidString
        var request = request
        request["id"] = id
        pending[id] = completion
        var line = (try? JSONSerialization.data(withJSONObject: request)) ?? Data()
        line.append(10)
        stdinHandle?.write(line)
        lock.unlock()
        resetIdleTimer()
    }

    func preload(engine: String, model: String) {
        send(["cmd": "preload", "engine": engine, "model": model]) { result in
            if case let .failure(error) = result { log("preload failed: \(error)") }
        }
    }

    func transcribe(audio: URL, engine: String, model: String, language: String, prompt: String,
                    segments: Bool, vad: Bool, completion: @escaping (Result<Transcription, CLIError>) -> Void) {
        let request: [String: Any] = [
            "cmd": "transcribe", "audio": audio.path, "engine": engine, "model": model,
            "language": language, "prompt": prompt, "segments": segments, "vad": vad,
        ]
        send(request) { result in
            completion(result.map { object in
                let segs = (object["segments"] as? [[String: Any]] ?? []).map {
                    Segment(start: ($0["start"] as? NSNumber)?.doubleValue ?? 0,
                            end: ($0["end"] as? NSNumber)?.doubleValue ?? 0,
                            text: ($0["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
                }
                return Transcription(text: (object["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
                                     segments: segs,
                                     engine: object["engine"] as? String ?? engine,
                                     model: object["model"] as? String ?? model,
                                     elapsed: (object["elapsed"] as? NSNumber)?.doubleValue ?? 0)
            })
        }
    }

    /// Blocking variant for the CLI's in-process fallback.
    func transcribeSync(audio: URL, engine: String, model: String, language: String, prompt: String,
                        segments: Bool, vad: Bool) throws -> Transcription {
        let done = DispatchSemaphore(value: 0)
        var outcome: Result<Transcription, CLIError> = .failure(CLIError("no result"))
        transcribe(audio: audio, engine: engine, model: model, language: language, prompt: prompt,
                   segments: segments, vad: vad) { outcome = $0; done.signal() }
        done.wait()
        return try outcome.get()
    }

    private func resetIdleTimer() {
        idleTimer?.cancel()
        guard idleMinutes > 0 else { return }
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + .seconds(idleMinutes * 60))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let busy = !self.pending.isEmpty
            self.lock.unlock()
            if busy { self.resetIdleTimer() } else { self.stop(reason: "idle") }
        }
        timer.resume()
        idleTimer = timer
    }

    func stop(reason: String) {
        lock.lock()
        let process = self.process
        lock.unlock()
        guard let process, process.isRunning else { return }
        log("stopping asr worker (\(reason))")
        try? stdinHandle?.close()
        process.terminate()
    }
}
