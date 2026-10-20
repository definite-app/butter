import Foundation

enum Paths {
    static let label = "app.butter.rec"
    static let home = FileManager.default.homeDirectoryForCurrentUser

    static var butterHome: URL { home.appendingPathComponent(".butter") }
    static var configFile: URL {
        if let override = ProcessInfo.processInfo.environment["BUTTER_REC_CONFIG"], !override.isEmpty {
            return expand(override)
        }
        return home.appendingPathComponent(".config/butter/recorder.toml")
    }
    static var socket: URL { butterHome.appendingPathComponent("rec.sock") }
    static var logFile: URL { butterHome.appendingPathComponent("logs/rec.log") }
    static var dictationDir: URL { butterHome.appendingPathComponent("dictation") }
    static var dictationAudioDir: URL { dictationDir.appendingPathComponent("audio") }
    static var appBundle: URL { butterHome.appendingPathComponent("ButterRec.app") }
    static var executable: URL { appBundle.appendingPathComponent("Contents/MacOS/butter-rec") }
    static var launchAgent: URL { home.appendingPathComponent("Library/LaunchAgents/\(label).plist") }

    /// The ASR worker ships inside the app bundle; fall back to the installed copy
    /// when running a bare build product.
    static var worker: URL {
        if let bundled = Bundle.main.url(forResource: "asr_worker", withExtension: "py") {
            return bundled
        }
        return appBundle.appendingPathComponent("Contents/Resources/asr_worker.py")
    }

    static func expand(_ path: String) -> URL {
        if path == "~" { return home }
        if path.hasPrefix("~/") { return home.appendingPathComponent(String(path.dropFirst(2))) }
        return URL(fileURLWithPath: path)
    }

    /// launchd hands agents a bare PATH; add the usual tool locations so uv,
    /// ollama, etc. resolve the same way they do in a login shell.
    static var searchPath: String {
        let extra = ["/opt/homebrew/bin", "/usr/local/bin", home.appendingPathComponent(".local/bin").path,
                     home.appendingPathComponent(".cargo/bin").path, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        let current = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        var seen = Set<String>()
        return (current + extra).filter { seen.insert($0).inserted }.joined(separator: ":")
    }
}

func which(_ name: String) -> String? {
    if name.contains("/") {
        let path = Paths.expand(name).path
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }
    for dir in Paths.searchPath.split(separator: ":") {
        let candidate = "\(dir)/\(name)"
        if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
    }
    return nil
}

private let logFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func log(_ message: String) {
    let line = "[\(logFormatter.string(from: Date()))] \(message)\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
}

struct CLIError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

func jsonString(_ object: Any, pretty: Bool = false) -> String {
    let options: JSONSerialization.WritingOptions = pretty ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes] : [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: options) else { return "{}" }
    return String(data: data, encoding: .utf8) ?? "{}"
}

func isoString(_ date: Date) -> String { logFormatter.string(from: date) }
func parseISO(_ s: String?) -> Date? { s.flatMap { logFormatter.date(from: $0) } }

func formatClock(_ seconds: Double) -> String {
    let s = max(0, Int(seconds.rounded(.down)))
    return String(format: "%02d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60)
}

func formatDuration(_ seconds: Double) -> String {
    let s = max(0, Int(seconds.rounded()))
    if s < 60 { return "\(s)s" }
    if s < 3600 { return "\(s / 60)m \(s % 60)s" }
    return "\(s / 3600)h \((s % 3600) / 60)m"
}

/// Runs a shell command through a login shell so the user's PATH applies.
@discardableResult
func runShell(_ command: String, stdin: Data? = nil, timeout: TimeInterval? = nil) throws -> (status: Int32, stdout: Data, stderr: Data) {
    let result = try runProcess("/bin/zsh", ["-lc", command], stdin: stdin, timeout: timeout)
    if result.timedOut { throw CLIError("timed out after \(Int(timeout ?? 0))s: \(command)") }
    return (result.status, result.stdout, result.stderr)
}

/// Runs a program with the extended PATH. With a timeout, the child is
/// terminated (then killed) once it runs over, and `timedOut` is set.
func runProcess(_ executable: String, _ arguments: [String], stdin: Data? = nil, timeout: TimeInterval? = nil,
                environment: [String: String?] = [:], directory: URL? = nil)
    throws -> (status: Int32, stdout: Data, stderr: Data, timedOut: Bool) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = Paths.searchPath
    for (key, value) in environment { env[key] = value }
    process.environment = env
    if let directory { process.currentDirectoryURL = directory }
    let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
    process.standardInput = inPipe
    process.standardOutput = outPipe
    process.standardError = errPipe
    try process.run()
    // Drain both pipes concurrently so a chatty child can't deadlock on a full pipe.
    var out = Data(), err = Data()
    let group = DispatchGroup()
    group.enter()
    DispatchQueue.global().async { out = outPipe.fileHandleForReading.readDataToEndOfFile(); group.leave() }
    group.enter()
    DispatchQueue.global().async { err = errPipe.fileHandleForReading.readDataToEndOfFile(); group.leave() }
    var timedOut = false
    if let timeout {
        let pid = process.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
            guard process.isRunning else { return }
            timedOut = true
            process.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { if process.isRunning { kill(pid, SIGKILL) } }
        }
    }
    if let stdin { inPipe.fileHandleForWriting.write(stdin) }
    try? inPipe.fileHandleForWriting.close()
    process.waitUntilExit()
    group.wait()
    return (process.terminationStatus, out, err, timedOut)
}
