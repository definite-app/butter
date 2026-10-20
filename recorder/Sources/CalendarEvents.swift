import Foundation

/// One event from ~/.butter/calendar/upcoming.json.
struct CalendarEvent {
    struct Attendee {
        let name: String?
        let email: String?
        var label: String { name ?? email ?? "" }
        var dict: [String: Any] { ["name": name ?? NSNull(), "email": email ?? NSNull()] }
    }

    let id: String
    let title: String
    let start: Date
    let end: Date
    let allDay: Bool
    let attendees: [Attendee]
    let joinURL: String?
    let calendar: String?

    /// Nudge once per event and start time (a moved event nudges again).
    var key: String { "\(id)|\(isoString(start))" }
    /// A call or a meeting with people: worth a nudge, and its title names a recording.
    var isMeeting: Bool { !allDay && (joinURL != nil || !attendees.isEmpty) }

    var dict: [String: Any] {
        ["id": id, "title": title, "start": CalendarStore.localISO(start), "end": CalendarStore.localISO(end), "all_day": allDay,
         "attendees": attendees.map(\.dict), "join_url": joinURL ?? NSNull(), "calendar": calendar ?? NSNull()]
    }

    /// What goes in meeting.json as `calendar_event`.
    var meetingDict: [String: Any] {
        ["id": id, "title": title, "start": CalendarStore.localISO(start), "end": CalendarStore.localISO(end),
         "attendees": attendees.map(\.dict), "join_url": joinURL ?? NSNull()]
    }

    /// "Tue 14:00–14:30", or "Tue (all day)".
    var when: String {
        let day = DateFormatter()
        day.dateFormat = "EEE"
        let time = DateFormatter()
        time.dateFormat = "HH:mm"
        if allDay { return "\(day.string(from: start)) (all day)" }
        return "\(day.string(from: start)) \(time.string(from: start))–\(time.string(from: end))"
    }
}

/// ~/.butter/calendar/upcoming.json is the contract: anything can fill it
/// (`butter-rec calendar import`, an agent, the daemon asking claude) and the
/// daemon nudges from it. Butter never talks to a calendar service itself.
enum CalendarStore {
    struct Snapshot {
        var events: [CalendarEvent]
        var updatedAt: Date?
        var source: String
        /// Older than a day: not trusted for nudges or meeting titles.
        var stale: Bool { updatedAt.map { Date().timeIntervalSince($0) > 86400 } ?? true }
    }

    struct Normalized {
        var events: [CalendarEvent]
        /// Why events were left out, with how many.
        var dropped: [String: Int]
        var total: Int
        var droppedCount: Int { dropped.values.reduce(0, +) }
        var droppedSummary: String { dropped.sorted { $0.key < $1.key }.map { "\($0.value) \($0.key)" }.joined(separator: ", ") }
    }

    static func load() -> Snapshot? {
        guard let data = try? Data(contentsOf: Paths.calendarFile),
              let object = try? JSONSerialization.jsonObject(with: data),
              let normalized = try? normalize(object) else { return nil }
        let dict = object as? [String: Any] ?? [:]
        return Snapshot(events: normalized.events, updatedAt: parseDate(dict["updated_at"])?.date,
                        source: dict["source"] as? String ?? "unknown")
    }

    static var modified: Date? {
        (try? Paths.calendarFile.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
    }

    /// The meeting-like event a recording starting at `date` belongs to: one
    /// under way, or one starting within 10 minutes. The nearest start wins.
    static func event(at date: Date, in snapshot: Snapshot? = load()) -> CalendarEvent? {
        guard let snapshot, !snapshot.stale else { return nil }
        return snapshot.events
            .filter { $0.isMeeting && $0.start.addingTimeInterval(-600) <= date && date < $0.end }
            .min { abs($0.start.timeIntervalSince(date)) < abs($1.start.timeIntervalSince(date)) }
    }

    /// Validates and writes JSON from anywhere (a file, stdin, claude's answer).
    /// When there were events but none were usable, the old file stays.
    static func importData(_ data: Data, source: String) throws -> Normalized {
        let object = try parseJSON(data)
        let normalized = try normalize(object)
        if normalized.total > 0 && normalized.events.isEmpty {
            throw CLIError("none of the \(normalized.total) events were usable (\(normalized.droppedSummary)); left upcoming.json as it was")
        }
        try write(normalized.events, source: source)
        return normalized
    }

    /// JSON, or the JSON inside a reply: code fences or a line of prose around it.
    static func parseJSON(_ data: Data) throws -> Any {
        if let object = try? JSONSerialization.jsonObject(with: data) { return object }
        let text = String(data: data, encoding: .utf8) ?? ""
        let starts = [text.firstIndex(of: "{"), text.firstIndex(of: "[")].compactMap { $0 }
        if let start = starts.min(), let end = [text.lastIndex(of: "}"), text.lastIndex(of: "]")].compactMap({ $0 }).max(), start < end,
           let object = try? JSONSerialization.jsonObject(with: Data(text[start...end].utf8)) {
            return object
        }
        let preview = text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120)
        throw CLIError(preview.isEmpty ? "no JSON given" : "not JSON: \(preview)")
    }

    static func write(_ events: [CalendarEvent], source: String) throws {
        try FileManager.default.createDirectory(at: Paths.calendarDir, withIntermediateDirectories: true)
        let file: [String: Any] = ["updated_at": localISO(Date()), "source": source,
                                   "events": events.sorted { $0.start < $1.start }.map(\.dict)]
        try jsonString(file, pretty: true).data(using: .utf8)!.write(to: Paths.calendarFile, options: .atomic)
    }

    /// Our own format, a bare array, `{"events": [...]}`, or a Google Calendar
    /// API list (`items`, `summary`, `start.dateTime`/`start.date`, `hangoutLink`,
    /// `conferenceData`). `{"error": ...}` throws it.
    static func normalize(_ object: Any) throws -> Normalized {
        let list: [Any]
        if let array = object as? [Any] {
            list = array
        } else if let dict = object as? [String: Any] {
            if let events = (dict["events"] ?? dict["items"] ?? dict["upcoming"]) as? [Any] {
                list = events
            } else if let error = dict["error"] {
                throw CLIError("it holds an error, not events: \(error)")
            } else if dict["start"] != nil {
                list = [dict]
            } else {
                throw CLIError("expected a list of events, or {\"events\": [...]}")
            }
        } else {
            throw CLIError("expected a list of events, or {\"events\": [...]}")
        }
        var out = Normalized(events: [], dropped: [:], total: list.count)
        var seen = Set<String>()
        for item in list {
            switch event(from: item) {
            case let .success(event):
                if seen.insert(event.key).inserted { out.events.append(event) } else { out.dropped["duplicate", default: 0] += 1 }
            case let .failure(reason):
                out.dropped[reason.description, default: 0] += 1
            }
        }
        out.events.sort { $0.start < $1.start }
        return out
    }

    private static func event(from item: Any) -> Result<CalendarEvent, CLIError> {
        guard let e = item as? [String: Any] else { return .failure(CLIError("not an object")) }
        if (e["status"] as? String)?.lowercased() == "cancelled" { return .failure(CLIError("cancelled")) }
        let rawAttendees = e["attendees"] as? [Any] ?? []
        let selfDeclined = rawAttendees.contains {
            guard let a = $0 as? [String: Any] else { return false }
            return a["self"] as? Bool == true && (a["responseStatus"] as? String) == "declined"
        }
        let response = (e["response_status"] ?? e["responseStatus"]) as? String
        if selfDeclined || e["declined"] as? Bool == true || response == "declined" { return .failure(CLIError("declined")) }
        guard let start = parseDate(e["start"] ?? e["start_time"] ?? e["startTime"]),
              let end = parseDate(e["end"] ?? e["end_time"] ?? e["endTime"]) else {
            return .failure(CLIError("without a start and end"))
        }
        guard end.date > start.date else { return .failure(CLIError("ending before they start")) }
        let allDay = e["all_day"] as? Bool ?? e["allDay"] as? Bool ?? (start.dateOnly && end.dateOnly)
        // A multi-day all-day event (a trip) is fine; a timed one that long is a mistake.
        if !allDay && end.date.timeIntervalSince(start.date) > 86400 { return .failure(CLIError("over 24h long")) }
        let title = [e["title"], e["summary"], e["name"], e["subject"]].compactMap { ($0 as? String)?.trimmed }.first { !$0.isEmpty }
            ?? "Untitled event"
        let id = [e["id"], e["event_id"], e["eventId"], e["iCalUID"], e["uid"]].compactMap { ($0 as? String)?.trimmed ?? ($0 as? NSNumber)?.stringValue }
            .first { !$0.isEmpty } ?? "gen-" + fnv(title + isoString(start.date))
        var attendees: [CalendarEvent.Attendee] = []
        if let text = e["attendees"] as? String {
            attendees = text.split(separator: ",").map { attendee(String($0)) }
        }
        for raw in rawAttendees {
            if let text = raw as? String {
                attendees.append(attendee(text))
            } else if let a = raw as? [String: Any] {
                // Google lists you (self), rooms (resource) and people who said no.
                if a["self"] as? Bool == true || a["resource"] as? Bool == true || (a["responseStatus"] as? String) == "declined" { continue }
                let name = ((a["name"] ?? a["displayName"] ?? a["display_name"]) as? String)?.trimmed
                let email = (a["email"] as? String)?.trimmed
                attendees.append(.init(name: name?.isEmpty == false ? name : nil, email: email?.isEmpty == false ? email : nil))
            }
        }
        attendees = attendees.filter { !$0.label.isEmpty }
        let calendar = [e["calendar"], e["calendar_name"], e["calendarName"]].compactMap { ($0 as? String)?.trimmed }.first { !$0.isEmpty }
        return .success(CalendarEvent(id: id, title: title, start: start.date, end: end.date, allDay: allDay, attendees: attendees,
                                      joinURL: joinURL(e), calendar: calendar))
    }

    private static func attendee(_ text: String) -> CalendarEvent.Attendee {
        let t = text.trimmed
        return t.contains("@") && !t.contains(" ") ? .init(name: nil, email: t) : .init(name: t, email: nil)
    }

    /// The call link: given outright, Google's hangoutLink or conference entry
    /// points, else a Meet/Zoom/Teams/Webex link in the location or description.
    private static func joinURL(_ e: [String: Any]) -> String? {
        var candidates: [Any?] = [e["join_url"], e["joinUrl"], e["join_link"], e["meeting_url"], e["meetingUrl"], e["hangoutLink"],
                                  e["hangout_link"], e["conference_url"]]
        if let conference = (e["conferenceData"] ?? e["conference_data"]) as? [String: Any],
           let points = (conference["entryPoints"] ?? conference["entry_points"]) as? [[String: Any]] {
            let video = points.filter { ($0["entryPointType"] ?? $0["entry_point_type"]) as? String == "video" }
            candidates += (video + points).map { $0["uri"] }
        }
        for case let value as String in candidates {
            if let url = URL(string: value.trimmed), ["http", "https"].contains(url.scheme?.lowercased() ?? "") { return url.absoluteString }
        }
        let text = [e["location"], e["description"]].compactMap { $0 as? String }.joined(separator: "\n")
        let pattern = #"https://[^\s"'<>]*(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|webex\.com)[^\s"'<>]*"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let range = Range(match.range, in: text) else { return nil }
        return String(text[range]).trimmingCharacters(in: CharacterSet(charactersIn: ".,;)>]"))
    }

    /// ISO 8601 with an offset or Z, a date ("2026-10-20": local midnight), a
    /// local wall time without an offset, or Google's `{dateTime|date, timeZone}`.
    static func parseDate(_ value: Any?) -> (date: Date, dateOnly: Bool)? {
        if let dict = value as? [String: Any] {
            let zone = (dict["timeZone"] ?? dict["time_zone"]) as? String
            if let s = (dict["dateTime"] ?? dict["date_time"]) as? String { return parseDate(s, zone: zone) }
            if let s = dict["date"] as? String { return parseDate(s, zone: zone) }
            return nil
        }
        return (value as? String).flatMap { parseDate($0, zone: nil) }
    }

    private static func parseDate(_ raw: String, zone: String?) -> (date: Date, dateOnly: Bool)? {
        let s = raw.trimmed.replacingOccurrences(of: " ", with: "T")
        let iso = ISO8601DateFormatter()
        for options: ISO8601DateFormatter.Options in [[.withInternetDateTime], [.withInternetDateTime, .withFractionalSeconds]] {
            iso.formatOptions = options
            if let date = iso.date(from: s) { return (date, false) }
        }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = zone.flatMap(TimeZone.init(identifier:)) ?? .current
        f.dateFormat = "yyyy-MM-dd"
        if s.count == 10, let date = f.date(from: s) { return (date, true) }
        for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss.SSS", "yyyy-MM-dd'T'HH:mm"] {
            f.dateFormat = format
            if let date = f.date(from: s) { return (date, false) }
        }
        return nil
    }

    /// "2026-10-20T14:00:00-04:00": the offset kept, so the file reads in local time.
    static func localISO(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.timeZone = .current
        f.formatOptions = [.withInternetDateTime]
        return f.string(from: date)
    }

    private static func fnv(_ s: String) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in s.utf8 { hash = (hash ^ UInt64(byte)) &* 0x100000001b3 }
        return String(hash, radix: 16)
    }
}

/// Fills upcoming.json by asking headless Claude Code for the next 24 hours,
/// through whichever calendar MCP server the user has (the claude.ai Google
/// Calendar connector, or a local one). Only that server's tools are allowed;
/// other servers aren't even connected, and built-in tools, hooks and skills
/// are off. A reply that isn't backed by a calendar tool call is rejected.
enum CalendarRefresh {
    struct Status {
        var attemptAt: Date?
        var successAt: Date?
        var error: String?
        var source: String?
        var count: Int?
        var elapsed: Double?

        var finishedAt: Date? { attemptAt.map { $0.addingTimeInterval(elapsed ?? 0) } }

        var dict: [String: Any] {
            ["last_refresh_at": attemptAt.map(isoString) ?? NSNull(), "last_success_at": successAt.map(isoString) ?? NSNull(),
             "last_error": error ?? NSNull(), "last_refresh_source": source ?? NSNull(), "last_refresh_events": count ?? NSNull(),
             "last_refresh_seconds": elapsed ?? NSNull()]
        }

        static func load() -> Status {
            guard let data = try? Data(contentsOf: Paths.calendarStatus),
                  let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return Status() }
            return Status(attemptAt: parseISO(d["last_refresh_at"] as? String), successAt: parseISO(d["last_success_at"] as? String),
                          error: d["last_error"] as? String, source: d["last_refresh_source"] as? String,
                          count: d["last_refresh_events"] as? Int, elapsed: (d["last_refresh_seconds"] as? NSNumber)?.doubleValue)
        }

        func save() {
            try? FileManager.default.createDirectory(at: Paths.calendarDir, withIntermediateDirectories: true)
            try? jsonString(dict, pretty: true).data(using: .utf8)!.write(to: Paths.calendarStatus, options: .atomic)
        }
    }

    static let prompt = """
    Read my calendar with the calendar tools and list my events from {{from}} to {{to}} (my time zone is {{zone}}). Include each of my calendars that holds meetings, not only the primary one.

    Output only one JSON object, with no prose and no code fences:
    {"events": [{"id": "the event's id", "title": "…", "start": "2026-01-02T15:00:00-05:00", "end": "2026-01-02T15:30:00-05:00", "all_day": false, "attendees": [{"name": "Ada Lovelace", "email": "ada@example.com"}], "join_url": "https://meet.google.com/abc-defg-hij", "calendar": "Work"}]}

    - start and end: ISO 8601 with the UTC offset. For all-day events, "all_day": true and dates like "2026-01-02".
    - attendees: everyone invited except me; [] if nobody else.
    - join_url: the Google Meet, Zoom or Teams link from the event's conference details, location or description, or null.
    - Leave out cancelled events and events I declined.
    - List only events the tools returned. Never guess or make one up.
    - If there are no events in that window, output {"events": []}.
    - If you can't read the calendar (no calendar tool, it needs signing in, or it fails), output only {"error": "what went wrong"}.
    """

    private static let systemPrompt = "You read the user's calendar with the calendar tools and reply with JSON only."

    /// Runs one refresh and records its outcome in status.json. On failure the
    /// old upcoming.json stays.
    @discardableResult
    static func run(config: Config) -> Status {
        let started = Date()
        var status = Status.load()
        status.attemptAt = started
        do {
            let (normalized, source) = try fetch(config: config)
            status.successAt = Date()
            status.error = nil
            status.source = source
            status.count = normalized.events.count
            let dropped = normalized.droppedCount > 0 ? ", dropped \(normalized.droppedSummary)" : ""
            log("calendar: \(normalized.events.count) events from \(source) in \(String(format: "%.1f", Date().timeIntervalSince(started)))s\(dropped)")
        } catch {
            status.error = "\(error)"
            log("calendar: refresh failed, kept the old upcoming.json: \(error)")
        }
        status.elapsed = Date().timeIntervalSince(started)
        status.save()
        return status
    }

    private static func fetch(config: Config) throws -> (CalendarStore.Normalized, String) {
        guard let claude = Cleanup.claudeExecutable(config) else {
            throw CLIError("claude isn't installed or not found; set [cleanup] claude_path")
        }
        try FileManager.default.createDirectory(at: Paths.calendarDir, withIntermediateDirectories: true)
        var environment: [String: String?] = Cleanup.claudeAuth().environment
        environment["CLAUDECODE"] = .some(nil)
        environment["CLAUDE_CODE_ENTRYPOINT"] = .some(nil)
        // Every allowed tool loaded up front, none behind a tool search.
        environment["ENABLE_TOOL_SEARCH"] = "false"
        // With -p, claude.ai connectors otherwise connect in the background and
        // often miss the first (only) turn. Wait for them instead.
        environment["MCP_CONNECTION_NONBLOCKING"] = "false"
        environment["MCP_CONNECT_TIMEOUT_MS"] = "30000"

        let servers = try mcpServers(claude, environment: environment)
        let wanted = config.calendarMCPServers
        let calendars = servers.filter { name in
            wanted.isEmpty ? name.lowercased().contains("calendar") : wanted.contains { $0.caseInsensitiveCompare(name) == .orderedSame }
        }
        guard !calendars.isEmpty else {
            throw CLIError(wanted.isEmpty
                ? "no calendar MCP server in `claude mcp list` (connect Google Calendar at claude.ai › Settings › Connectors, or set [meeting] calendar_mcp_servers)"
                : "none of calendar_mcp_servers (\(wanted.joined(separator: ", "))) is in `claude mcp list`")
        }
        let others = servers.filter { !calendars.contains($0) }
        let allowed = calendars.map(toolPrefix)

        let tz = TimeZone.current
        let now = Date()
        let prompt = Self.prompt
            .replacingOccurrences(of: "{{from}}", with: CalendarStore.localISO(now))
            .replacingOccurrences(of: "{{to}}", with: CalendarStore.localISO(now.addingTimeInterval(86400)))
            .replacingOccurrences(of: "{{zone}}", with: tz.identifier)
        // User settings are where MCP servers and claude.ai connectors come from;
        // the flag settings switch their hooks off and keep other servers away.
        let settings: [String: Any] = ["disableAllHooks": true, "deniedMcpServers": others.map { ["serverName": $0] }]
        var args = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
                    "--setting-sources", "user", "--settings", jsonString(settings), "--tools", "", "--disable-slash-commands",
                    "--permission-mode", "dontAsk", "--system-prompt", systemPrompt]
        if !config.calendarModel.isEmpty { args += ["--model", config.calendarModel] }
        args += ["--allowedTools"] + allowed
        if !others.isEmpty { args += ["--disallowedTools"] + others.map(toolPrefix) }
        log("calendar: asking claude through \(calendars.joined(separator: ", "))")
        let result = try runProcess(claude, args, stdin: prompt.data(using: .utf8), timeout: config.calendarTimeout,
                                    environment: environment, directory: Paths.calendarDir)
        // What claude said, for working out why a refresh failed.
        try? (result.stdout + result.stderr).write(to: Paths.calendarDir.appendingPathComponent("last-refresh.jsonl"), options: .atomic)
        if result.timedOut { throw CLIError("claude timed out after \(Int(config.calendarTimeout))s") }
        let transcript = parseStream(result.stdout, allowed: allowed)
        guard result.status == 0, let reply = transcript.reply else {
            let stderr = String(data: result.stderr, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            throw CLIError("claude exited \(result.status): \(String((transcript.reply ?? stderr).prefix(300)))")
        }
        guard transcript.calendarTools > 0 else {
            let states = transcript.servers.filter { calendars.contains($0.key) }.map { "\($0.key): \($0.value)" }.sorted()
            let detail = states.isEmpty ? "it didn't load" : states.joined(separator: ", ")
            let hint = states.contains { $0.hasSuffix("needs-auth") } ? "; sign in with /mcp in Claude Code" : ""
            throw CLIError("claude has no calendar tools (\(detail))\(hint)")
        }
        let object: Any
        do {
            object = try CalendarStore.parseJSON(Data(reply.utf8))
        } catch {
            throw CLIError("claude didn't reply with JSON: \(reply.trimmed.prefix(160))")
        }
        if let error = (object as? [String: Any])?["error"] { throw CLIError("claude couldn't read the calendar: \(error)") }
        // An answer is only trusted when a calendar tool actually answered.
        guard transcript.calendarCalls > 0 else {
            throw CLIError("claude answered without a successful calendar tool call; not trusting it")
        }
        let normalized = try CalendarStore.normalize(object)
        let source = "claude (\(calendars.joined(separator: ", ")))"
        if normalized.total > 0 && normalized.events.isEmpty {
            throw CLIError("none of the \(normalized.total) events claude returned were usable (\(normalized.droppedSummary))")
        }
        try CalendarStore.write(normalized.events, source: source)
        return (normalized, source)
    }

    /// Server names from `claude mcp list` ("claude.ai Google Calendar: https://… - ✔ Connected").
    static func mcpServers(_ claude: String, environment: [String: String?]) throws -> [String] {
        let result = try runProcess(claude, ["mcp", "list"], timeout: 60, environment: environment, directory: Paths.calendarDir)
        guard result.status == 0, !result.timedOut else {
            throw CLIError("`claude mcp list` failed: \(String(data: result.stderr, encoding: .utf8)?.prefix(200) ?? "")")
        }
        let text = String(data: result.stdout, encoding: .utf8) ?? ""
        return text.components(separatedBy: "\n").compactMap { line in
            guard line.contains(" - "), let colon = line.range(of: ": ") else { return nil }
            let name = String(line[..<colon.lowerBound]).trimmed
            return name.isEmpty ? nil : name
        }
    }

    /// Claude Code's tool prefix for a server: "claude.ai Google Calendar" ->
    /// "mcp__claude_ai_Google_Calendar". As a permission rule it covers all its tools.
    static func toolPrefix(_ server: String) -> String {
        "mcp__" + String(server.map { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") ? $0 : "_" })
    }

    /// From claude's stream-json: the final reply, how many calendar tools were
    /// loaded and successfully called, and each MCP server's state.
    private static func parseStream(_ data: Data, allowed: [String]) -> (reply: String?, calendarTools: Int, calendarCalls: Int, servers: [String: String]) {
        var reply: String?
        var tools = 0
        var servers: [String: String] = [:]
        var calls: [String: Bool] = [:]  // tool_use id -> succeeded
        func isCalendar(_ name: String) -> Bool { allowed.contains { name.hasPrefix($0 + "__") } }
        for line in data.split(separator: 10) {
            guard let message = (try? JSONSerialization.jsonObject(with: Data(line))) as? [String: Any] else { continue }
            let content = (message["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
            switch message["type"] as? String {
            case "system" where message["subtype"] as? String == "init":
                tools = (message["tools"] as? [String] ?? []).filter(isCalendar).count
                for server in message["mcp_servers"] as? [[String: Any]] ?? [] {
                    if let name = server["name"] as? String { servers[name] = server["status"] as? String ?? "?" }
                }
            case "assistant":
                for block in content where block["type"] as? String == "tool_use" {
                    if let id = block["id"] as? String, let name = block["name"] as? String, isCalendar(name) { calls[id] = false }
                }
            case "user":
                for block in content where block["type"] as? String == "tool_result" {
                    if let id = block["tool_use_id"] as? String, calls[id] != nil { calls[id] = block["is_error"] as? Bool != true }
                }
            case "result":
                reply = message["result"] as? String
            default:
                break
            }
        }
        return (reply, tools, calls.values.filter { $0 }.count, servers)
    }
}

/// `calendar_hours = "7-19"`: refresh from 7:00 until 19:00 local time.
func withinHours(_ spec: String, at date: Date = Date()) -> Bool {
    let parts = spec.split(separator: "-").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
    guard parts.count == 2 else { return true }
    let hour = Calendar.current.component(.hour, from: date)
    return parts[0] <= parts[1] ? (hour >= parts[0] && hour < parts[1]) : (hour >= parts[0] || hour < parts[1])
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
