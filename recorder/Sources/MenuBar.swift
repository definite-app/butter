import AppKit
import SwiftUI

/// What the menu bar shows, read straight from the daemon (no socket).
struct MenuBarState {
    struct Recording {
        let title: String
        let since: Date
        /// The Mac's audio too, not just the mic.
        let bothSides: Bool
        /// When its calendar event ends, if it has one.
        let ends: Date?
    }

    var now = Date()
    var recording: Recording?
    /// A meeting is being transcribed.
    var processing = false
    var events: [CalendarEvent] = []
    var stale = true
    var updatedAt: Date?
    var refreshMode = "claude"
    var refreshing = false
    /// The last refresh's error, when it failed.
    var refreshError: String?
    var nudgeMinutes = 2.0
    /// Only filled for the panel: recent meetings (newest first) and dictations.
    var meetings: [(dir: URL, meta: MeetingMeta)] = []
    var dictations: [[String: Any]] = []

    /// The next call (a timed event with a link or attendees) that hasn't
    /// started, or started in the last `grace` seconds.
    func nextCall(grace: TimeInterval) -> CalendarEvent? {
        guard !stale else { return nil }
        return events.first { $0.isMeeting && $0.start > now.addingTimeInterval(-grace) && $0.end > now }
    }
}

enum MenuBarAction {
    case record(CalendarEvent), join(URL), stop, screenshot, showPill, startMeeting, dictate
    case refresh, settings, howToConnect, turnOffCalendar, allRecordings
    case openTranscript(URL), openNotes(URL), copyTranscript(URL), reveal(URL), openMeeting(URL)
    case copyText(String), pasteAgain(String)
}

/// The menu bar item: a small pill glyph with the next call ("Acme sync · in
/// 2h 5m", yellow when it's about to start) or the recording timer. Clicking it
/// opens a panel with the next call, today and tomorrow, recent recordings and
/// a few actions. `[ui] menu_bar = false` turns it off.
final class MenuBar: NSObject {
    var stateProvider: ((_ full: Bool) -> MenuBarState)?
    var onAction: ((MenuBarAction) -> Void)?

    private var item: NSStatusItem?
    private var panel: MenuPanel?
    private var hosting: NSHostingView<MenuPanelView>?
    private let model = MenuPanelModel()
    private var timer: Timer?
    private var lastLook = ""
    private var lastTick = Date.distantPast
    private var clickMonitor: Any?
    /// The title made the item disappear (a full menu bar): icon only until then.
    private var crowdedUntil: Date?

    var isOpen: Bool { panel?.isVisible == true }

    func setEnabled(_ on: Bool) {
        if on, item == nil {
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            item.button?.target = self
            item.button?.action = #selector(clicked)
            item.button?.imagePosition = .imageLeading
            self.item = item
            let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
            update()
        } else if !on, let item {
            close()
            timer?.invalidate()
            timer = nil
            NSStatusBar.system.removeStatusItem(item)
            self.item = nil
            lastLook = ""
        }
    }

    /// Every second while recording (the timer) or while the panel is open,
    /// else every 30s.
    private func tick() {
        let state = stateProvider?(false) ?? MenuBarState()
        guard state.recording != nil || isOpen || Date().timeIntervalSince(lastTick) >= 30 else { return }
        update()
    }

    /// Redraws now, e.g. after a meeting starts or the calendar changes.
    func update() {
        lastTick = Date()
        render(stateProvider?(false) ?? MenuBarState())
        if isOpen { refreshPanel() }
    }

    // MARK: - The item

    private func render(_ s: MenuBarState) {
        guard let button = item?.button else { return }
        var text = ""
        var tint: NSColor?
        var filled = false
        if let recording = s.recording {
            text = clock(s.now.timeIntervalSince(recording.since))
            tint = Self.butter
            filled = true
        } else if s.processing {
            text = "Transcribing…"
        } else if let next = s.nextCall(grace: 300), next.start.timeIntervalSince(s.now) < 12 * 3600 {
            let soon = next.start.timeIntervalSince(s.now) <= max(s.nudgeMinutes, 5) * 60
            text = "\(Self.short(next.title, 16)) · \(Self.countdown(to: next.start, from: s.now, soon: soon))"
            if soon { tint = Self.butter }
        }
        // A full menu bar hides items that don't fit: drop the title and look again later.
        if let window = button.window, !text.isEmpty, filled == false, crowdedUntil == nil, !lastLook.isEmpty,
           !window.occlusionState.contains(.visible), NSScreen.screens.contains(where: { $0.frame.intersects(window.frame) }) == false {
            crowdedUntil = Date().addingTimeInterval(600)
            log("menu bar: no room for the title; showing the icon only for a while")
        }
        if let until = crowdedUntil, Date() > until { crowdedUntil = nil }
        if crowdedUntil != nil && !filled { text = "" }
        // Yellow text vanishes on a light menu bar: there it's dark text on a stronger wash.
        let dark = button.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let look = "\(text)|\(tint != nil)|\(filled)|\(dark)"
        guard look != lastLook else { return }
        lastLook = look
        var wash: NSColor?
        if tint != nil {
            wash = dark ? (filled ? nil : Self.butter.withAlphaComponent(0.16)) : Self.butter.withAlphaComponent(0.85)
            if !dark { tint = Self.ink }
        }
        button.image = Self.glyph(filled: filled, tint: tint, bars: filled && !dark ? Self.butter : nil)
        let font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: filled ? .medium : .regular)
        var attributes: [NSAttributedString.Key: Any] = [.font: font]
        if let tint { attributes[.foregroundColor] = tint }
        button.attributedTitle = NSAttributedString(string: text.isEmpty ? "" : " \(text)", attributes: attributes)
        button.wantsLayer = true
        button.layer?.cornerRadius = 5
        button.layer?.backgroundColor = wash?.cgColor
    }

    static let butter = NSColor(srgbRed: 0.961, green: 0.843, blue: 0.431, alpha: 1)  // #F5D76E
    /// Text on the butter wash in a light menu bar.
    static let ink = NSColor(srgbRed: 0.23, green: 0.19, blue: 0.06, alpha: 1)

    /// A 16px pill outline (13×9, radius 4.5) with three bars inside: short, tall,
    /// short. A template image unless tinted; filled while recording, with the
    /// bars in `bars` (default the pill surface color).
    static func glyph(filled: Bool, tint: NSColor?, bars barColor: NSColor? = nil) -> NSImage {
        let image = NSImage(size: NSSize(width: 16, height: 16), flipped: false) { _ in
            let pill = NSBezierPath(roundedRect: NSRect(x: 1.5, y: 3.5, width: 13, height: 9), xRadius: 4.5, yRadius: 4.5)
            let color = tint ?? .black
            pill.lineWidth = 1.4
            if filled {
                color.setFill()
                pill.fill()
            } else {
                color.setStroke()
                pill.stroke()
            }
            let bars = NSBezierPath()
            for (x, h) in [(5.6, 2.6), (8.0, 5.0), (10.4, 2.6)] {
                bars.move(to: NSPoint(x: x, y: 8 - h / 2))
                bars.line(to: NSPoint(x: x, y: 8 + h / 2))
            }
            bars.lineWidth = 1.4
            bars.lineCapStyle = .round
            (filled ? barColor ?? NSColor(srgbRed: 0.11, green: 0.106, blue: 0.098, alpha: 1) : color).setStroke()
            bars.stroke()
            return true
        }
        image.isTemplate = tint == nil
        return image
    }

    // MARK: - The panel

    @objc private func clicked() {
        isOpen ? close() : open()
    }

    func open() {
        guard let button = item?.button, let buttonWindow = button.window else { return }
        let panel = self.panel ?? makePanel()
        refreshPanel()
        let size = hosting?.fittingSize ?? NSSize(width: 360, height: 200)
        let anchor = buttonWindow.frame
        let screen = buttonWindow.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? anchor
        let x = min(max(anchor.midX - size.width / 2, screen.minX + 6), screen.maxX - size.width - 6)
        panel.setFrame(NSRect(x: x.rounded(), y: (anchor.minY - size.height - 4).rounded(), width: size.width, height: size.height), display: true)
        panel.makeKeyAndOrderFront(nil)
        button.highlight(true)
        // A click anywhere else closes it.
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
            self?.close()
        }
    }

    func close() {
        guard let panel, panel.isVisible else { return }
        panel.orderOut(nil)
        item?.button?.highlight(false)
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        clickMonitor = nil
    }

    private func makePanel() -> MenuPanel {
        let panel = MenuPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 200),
                              styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .popUpMenu
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        panel.onClose = { [weak self] in self?.close() }
        NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: panel, queue: .main) { [weak self] _ in
            self?.close()
        }
        let view = NSHostingView(rootView: MenuPanelView(model: model) { [weak self] action in self?.perform(action) })
        panel.contentView = view
        hosting = view
        self.panel = panel
        return panel
    }

    private func refreshPanel() {
        guard let provider = stateProvider else { return }
        model.content = MenuPanelContent(provider(true))
        guard let panel, panel.isVisible, let size = hosting?.fittingSize, size.height != panel.frame.height else { return }
        // Grow or shrink downwards from the menu bar.
        var frame = panel.frame
        frame.origin.y += frame.height - size.height
        frame.size.height = size.height
        panel.setFrame(frame, display: true)
    }

    private func perform(_ action: MenuBarAction) {
        switch action {
        case .copyText, .copyTranscript, .refresh:
            break  // stays open: "Copied", or the refresh going round
        default:
            close()
        }
        onAction?(action)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.update() }
    }

    // MARK: - Words

    static func short(_ title: String, _ limit: Int) -> String {
        title.count > limit ? String(title.prefix(limit)).trimmingCharacters(in: CharacterSet(charactersIn: " /-–·,:;|")) + "…" : title
    }

    /// "in 45m", "in 2h 5m"; when `soon`, "in 2 min" or "now".
    static func countdown(to date: Date, from now: Date, soon: Bool = false) -> String {
        let seconds = date.timeIntervalSince(now)
        if seconds <= 30 { return seconds > -60 ? "now" : "started \(Int(-seconds / 60)) min ago" }
        if soon { return "in \(max(1, Int((seconds / 60).rounded()))) min" }
        let minutes = Int((seconds / 60).rounded(.up))
        if minutes < 60 { return "in \(minutes)m" }
        return minutes % 60 == 0 ? "in \(minutes / 60)h" : "in \(minutes / 60)h \(minutes % 60)m"
    }

    private func clock(_ seconds: Double) -> String {
        let s = max(0, Int(seconds))
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// Borderless panels can't take keys by default; this one does, for Esc.
private final class MenuPanel: NSPanel {
    var onClose: (() -> Void)?
    override var canBecomeKey: Bool { true }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown, event.keyCode == 53 { onClose?(); return }
        super.sendEvent(event)
    }
}

// MARK: - Panel content

/// The panel's rows, worked out from the daemon's state.
struct MenuPanelContent {
    struct EventRow: Identifiable {
        enum Kind { case upcoming, next, recorded(URL, String), missed, past }
        let id: String
        let time: String
        let title: String
        let kind: Kind
    }

    struct RecentRow: Identifiable {
        let id: String
        let at: Date
        let title: String
        let detail: String
        /// A meeting's folder; nil for a dictation.
        let dir: URL?
        let text: String
        let hasNotes: Bool
        let hasTranscript: Bool
    }

    var recording: MenuBarState.Recording?
    var now = Date()
    var next: CalendarEvent?
    var nextLabel = ""
    var nextLine = ""
    var problem: String?
    var todayLabel = "Today"
    var today: [EventRow] = []
    var tomorrow: [EventRow] = []
    var recent: [RecentRow] = []
    var calendarAge = ""
    var refreshing = false

    init() {}

    init(_ s: MenuBarState) {
        now = s.now
        recording = s.recording
        refreshing = s.refreshing
        let calendar = Calendar.current
        let startOfToday = calendar.startOfDay(for: s.now)
        let startOfTomorrow = calendar.date(byAdding: .day, value: 1, to: startOfToday) ?? s.now
        let endOfTomorrow = calendar.date(byAdding: .day, value: 2, to: startOfToday) ?? s.now

        if s.refreshMode == "claude", let error = s.refreshError { problem = Self.plainWords(error) }
        if recording == nil, let next = s.nextCall(grace: 600), next.start < endOfTomorrow {
            self.next = next
            let soon = next.start.timeIntervalSince(s.now) <= max(s.nudgeMinutes, 5) * 60
            nextLabel = next.start <= s.now ? "Now · \(MenuBar.countdown(to: next.start, from: s.now))"
                : "Next · \(MenuBar.countdown(to: next.start, from: s.now, soon: soon))"
            var parts = [Self.span(next.start, next.end, day: next.start >= startOfTomorrow)]
            if let link = next.joinURL { parts.append(Self.app(link)) }
            if !next.attendees.isEmpty { parts.append(next.attendees.prefix(3).map { $0.name ?? $0.email ?? "" }.joined(separator: ", ")
                                                      + (next.attendees.count > 3 ? " +\(next.attendees.count - 3)" : "")) }
            nextLine = parts.joined(separator: " · ")
        }

        // Recordings of today's events: linked by calendar_event, else by time.
        func recordingFor(_ event: CalendarEvent) -> (URL, Double)? {
            for (dir, meta) in s.meetings where meta.status != "recording" {
                if let id = meta.calendarEvent?["id"] as? String, id == event.id { return (dir, meta.duration) }
                if let started = meta.startedAt, started >= event.start.addingTimeInterval(-600), started < event.end { return (dir, meta.duration) }
            }
            return nil
        }
        let time = DateFormatter()
        time.dateFormat = "h:mm"
        func row(_ event: CalendarEvent, past: Bool) -> EventRow {
            let kind: EventRow.Kind
            if past, let (dir, seconds) = recordingFor(event) {
                kind = .recorded(dir, "✓ \(Daemon.minutes(seconds))")
            } else if past {
                kind = event.isMeeting ? .missed : .past
            } else {
                kind = event.id == next?.id && event.start == next?.start ? .next : .upcoming
            }
            return EventRow(id: event.key, time: event.allDay ? "All day" : time.string(from: event.start), title: event.title, kind: kind)
        }
        let todays = s.events.filter { $0.start < startOfTomorrow && $0.end > startOfToday }
        if recording != nil {
            todayLabel = "Later today"
            today = todays.filter { $0.start > s.now }.map { row($0, past: false) }
        } else {
            today = todays.map { row($0, past: !$0.allDay && $0.end <= s.now) }
        }
        tomorrow = s.events.filter { $0.start >= startOfTomorrow && $0.start < endOfTomorrow }.prefix(4).map { row($0, past: false) }

        // Meetings and dictations, newest first.
        let clockTime = DateFormatter()
        clockTime.dateFormat = "h:mm a"
        let fm = FileManager.default
        var rows: [RecentRow] = s.meetings.prefix(6).compactMap { dir, meta in
            guard meta.status != "recording", let at = meta.startedAt else { return nil }
            let hasNotes = fm.fileExists(atPath: dir.appendingPathComponent("notes.md").path)
            let state = meta.status == "done" ? Daemon.minutes(meta.duration) : meta.status == "error" ? "failed" : "transcribing"
            let detail = ["Meeting", state, Self.when(at, clockTime, s.now)] + (hasNotes ? ["notes"] : [])
            return RecentRow(id: dir.path, at: at, title: meta.title, detail: detail.joined(separator: " · "), dir: dir, text: "",
                             hasNotes: hasNotes, hasTranscript: fm.fileExists(atPath: dir.appendingPathComponent("transcript.md").path))
        }
        for (i, entry) in s.dictations.enumerated() {
            guard let text = entry["text"] as? String, let at = parseISO(entry["at"] as? String) else { continue }
            let seconds = Int(((entry["seconds"] as? NSNumber)?.doubleValue ?? 0).rounded())
            let first = text.components(separatedBy: "\n").first { !$0.trimmed.isEmpty } ?? text
            rows.append(RecentRow(id: "dictation\(i)", at: at, title: first, detail: "Dictation · \(seconds / 60):\(String(format: "%02d", seconds % 60)) · \(Self.when(at, clockTime, s.now))",
                                  dir: nil, text: text, hasNotes: false, hasTranscript: false))
        }
        recent = Array(rows.sorted { $0.at > $1.at }.prefix(5))

        if s.refreshing {
            calendarAge = "Refreshing…"
        } else if let updated = s.updatedAt {
            let minutes = Int(s.now.timeIntervalSince(updated) / 60)
            calendarAge = "Calendar " + (minutes < 1 ? "just now" : minutes < 60 ? "\(minutes) min ago"
                : minutes < 48 * 60 ? "\(minutes / 60) h ago" : "\(minutes / 1440) days ago")
        } else {
            calendarAge = s.refreshMode == "off" ? "Calendar off" : "No calendar yet"
        }
    }

    /// "4:00 – 4:15 PM", "11:30 AM – 12:30 PM", "Tomorrow 9:00 – 9:30 AM".
    static func span(_ start: Date, _ end: Date, day: Bool) -> String {
        let f = DateFormatter()
        f.dateFormat = "a"
        let samePeriod = f.string(from: start) == f.string(from: end)
        f.dateFormat = samePeriod ? "h:mm" : "h:mm a"
        let from = f.string(from: start)
        f.dateFormat = "h:mm a"
        return (day ? "Tomorrow " : "") + "\(from) – \(f.string(from: end))"
    }

    static func app(_ link: String) -> String {
        let host = URL(string: link)?.host ?? ""
        if host.contains("meet.google") { return "Google Meet" }
        if host.contains("zoom") { return "Zoom" }
        if host.contains("teams") { return "Teams" }
        if host.contains("webex") { return "Webex" }
        return host.isEmpty ? "Link" : host
    }

    /// "10:12 AM" today, else "Mon 10:12 AM".
    private static func when(_ date: Date, _ f: DateFormatter, _ now: Date) -> String {
        if Calendar.current.isDate(date, inSameDayAs: now) { return f.string(from: date) }
        let day = DateFormatter()
        day.dateFormat = Calendar.current.isDate(date, equalTo: now, toGranularity: .weekOfYear) ? "EEE" : "MMM d"
        return "\(day.string(from: date)) \(f.string(from: date))"
    }

    /// The refresh error as a sentence a person can act on.
    static func plainWords(_ error: String) -> String {
        if error.contains("needs-auth") {
            return "Claude Code's Google Calendar connector isn't signed in. Run /mcp in Claude Code to sign in."
        }
        if error.contains("no calendar MCP server") { return "Claude Code has no calendar connector. Connect Google Calendar at claude.ai › Settings › Connectors." }
        if error.contains("claude isn't installed") { return "Claude Code isn't installed, or ButterRec can't find it." }
        if error.contains("timed out") { return "Claude Code took too long to answer." }
        if error.contains("couldn't read the calendar:") {
            return "Claude said: " + (error.components(separatedBy: "couldn't read the calendar:").last ?? "").trimmed
        }
        return error.count > 140 ? String(error.prefix(139)) + "…" : error
    }
}

final class MenuPanelModel: ObservableObject {
    @Published var content = MenuPanelContent()
}

private enum Palette {
    static let butter = Color(red: 0.961, green: 0.843, blue: 0.431)
    // Opaque: at 0.97 text behind the panel shows through.
    static let surface = Color(red: 28 / 255, green: 27 / 255, blue: 25 / 255)
    static let text = Color(white: 0.902)
    static let secondary = Color(white: 0.62)
    static let label = Color(white: 0.64)
    static let red = Color(red: 0.898, green: 0.451, blue: 0.373)
}

struct MenuPanelView: View {
    @ObservedObject var model: MenuPanelModel
    let act: (MenuBarAction) -> Void

    var body: some View {
        let c = model.content
        VStack(alignment: .leading, spacing: 2) {
            if let recording = c.recording {
                RecordingSection(recording: recording, now: c.now, act: act)
            } else {
                if let problem = c.problem { ProblemCard(text: problem, act: act) }
                if let next = c.next { NextSection(event: next, label: c.nextLabel, line: c.nextLine, act: act) }
            }
            if !c.today.isEmpty {
                SectionLabel(c.todayLabel)
                ForEach(c.today) { EventRowView(row: $0, act: act) }
            }
            if !c.tomorrow.isEmpty {
                SectionLabel("Tomorrow")
                ForEach(c.tomorrow) { EventRowView(row: $0, act: act) }
            }
            SectionLabel("Recent")
            if c.recent.isEmpty {
                Text("Nothing recorded yet").font(.system(size: 13)).foregroundColor(Palette.secondary).padding(.horizontal, 8).frame(height: 28)
            }
            ForEach(c.recent) { RecentRowView(row: $0, act: act) }
            HoverRow(height: 28, action: { act(.allRecordings) }) { _ in
                Text("All recordings…").font(.system(size: 13)).foregroundColor(Palette.secondary)
                Spacer()
            }
            Rectangle().fill(Color.white.opacity(0.08)).frame(height: 1).padding(.vertical, 4)
            Footer(age: c.calendarAge, refreshing: c.refreshing, act: act)
        }
        .padding(8)
        .frame(width: 360, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Palette.surface))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.white.opacity(0.1), lineWidth: 1))
        .environment(\.colorScheme, .dark)
    }
}

private struct SectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(.system(size: 11, weight: .semibold)).foregroundColor(Palette.label)
            .padding(.horizontal, 8).padding(.top, 8).padding(.bottom, 2)
    }
}

/// A row with a soft hover background; `content` gets whether it's hovered.
private struct HoverRow<Content: View>: View {
    var height: CGFloat = 28
    var tint: Color? = nil
    var action: (() -> Void)?
    @ViewBuilder let content: (Bool) -> Content
    @State private var hovered = false

    var body: some View {
        HStack(spacing: 8) { content(hovered) }
            .padding(.horizontal, 8)
            .frame(height: height)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(hovered && action != nil ? Color.white.opacity(0.07) : tint ?? .clear))
            .contentShape(Rectangle())
            .onHover { hovered = $0 }
            .onTapGesture { action?() }
    }
}

private enum PillStyle { case accent, outlined, plain }

private struct PillButton: View {
    let label: String
    var icon: String? = nil
    var dot = false
    var style = PillStyle.outlined
    var padding: CGFloat = 11
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if dot { Circle().fill(Palette.red).frame(width: 7, height: 7) }
                if let icon { Image(systemName: icon).font(.system(size: 10, weight: .semibold)) }
                Text(label).font(.system(size: 12, weight: .medium))
            }
            .foregroundColor(style == .accent ? Palette.butter : hovered ? Palette.text : Color(white: 0.8))
            .padding(.horizontal, padding)
            .frame(height: 24)
            .background(Capsule().fill(style == .accent ? Palette.butter.opacity(hovered ? 0.26 : 0.16)
                : hovered ? Color.white.opacity(0.1) : .clear))
            .overlay(Capsule().strokeBorder(style == .outlined ? Color.white.opacity(0.18) : .clear, lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
    }
}

private struct IconButton: View {
    let symbol: String
    var help = ""
    var color = Palette.secondary
    let action: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 11.5, weight: .medium))
                .foregroundColor(hovered && color == Palette.secondary ? Palette.text : color)
                .frame(width: 24, height: 24)
                .background(Circle().fill(hovered ? Color.white.opacity(0.1) : .clear))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .help(help)
    }
}

private struct NextSection: View {
    let event: CalendarEvent
    let label: String
    let line: String
    let act: (MenuBarAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.system(size: 11, weight: .semibold)).foregroundColor(Palette.butter)
            Text(event.title).font(.system(size: 14, weight: .semibold)).foregroundColor(Palette.text).lineLimit(1)
            Text(line).font(.system(size: 12)).foregroundColor(Palette.secondary).lineLimit(1)
            HStack(spacing: 6) {
                PillButton(label: "Record", dot: true, style: .accent) { act(.record(event)) }
                if let link = event.joinURL.flatMap(URL.init(string:)) {
                    PillButton(label: "Join") { act(.join(link)) }
                }
            }
            .padding(.top, 4)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct RecordingSection: View {
    let recording: MenuBarState.Recording
    let now: Date
    let act: (MenuBarAction) -> Void

    var body: some View {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        let elapsed = Int(now.timeIntervalSince(recording.since))
        let clock = elapsed >= 3600 ? String(format: "%d:%02d:%02d", elapsed / 3600, (elapsed % 3600) / 60, elapsed % 60)
            : String(format: "%d:%02d", elapsed / 60, elapsed % 60)
        let line = [clock, "started \(f.string(from: recording.since))"] + (recording.ends.map { ["ends \(f.string(from: $0))"] } ?? [])
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle().fill(Palette.butter).frame(width: 7, height: 7)
                Text("Recording · \(recording.bothSides ? "both sides" : "your mic")").font(.system(size: 11, weight: .semibold))
                    .foregroundColor(Palette.butter)
            }
            Text(recording.title).font(.system(size: 14, weight: .semibold)).foregroundColor(Palette.text).lineLimit(1)
            Text(line.joined(separator: " · ")).font(.system(size: 12).monospacedDigit()).foregroundColor(Palette.secondary)
            HStack(spacing: 6) {
                PillButton(label: "Stop", icon: "stop.fill", style: .accent) { act(.stop) }
                PillButton(label: "Screenshot", icon: "camera") { act(.screenshot) }
                PillButton(label: "Show pill", style: .plain) { act(.showPill) }
            }
            .padding(.top, 4)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ProblemCard: View {
    let text: String
    let act: (MenuBarAction) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "calendar.badge.exclamationmark").font(.system(size: 15)).foregroundColor(Palette.butter).padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                Text("Couldn't read your calendar").font(.system(size: 13, weight: .semibold)).foregroundColor(Palette.text)
                Text(text).font(.system(size: 12)).foregroundColor(Palette.secondary).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    PillButton(label: "Try again", style: .accent) { act(.refresh) }
                    PillButton(label: "How to connect") { act(.howToConnect) }
                    PillButton(label: "Turn off", style: .plain) { act(.turnOffCalendar) }
                }
                .padding(.top, 4)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.05)))
        .padding(.bottom, 4)
    }
}

private struct EventRowView: View {
    let row: MenuPanelContent.EventRow
    let act: (MenuBarAction) -> Void

    var body: some View {
        var action: (() -> Void)?
        var trailing = ""
        var titleColor = Palette.text
        var timeColor = Palette.secondary
        var tint: Color?
        switch row.kind {
        case let .recorded(dir, label):
            action = { act(.openTranscript(dir)) }
            trailing = label
        case .missed:
            trailing = "Not recorded"
            titleColor = Palette.secondary
        case .past:
            titleColor = Palette.secondary
        case .next:
            timeColor = Palette.butter
            tint = Palette.butter.opacity(0.08)
        case .upcoming:
            break
        }
        return HoverRow(height: 28, tint: tint, action: action) { _ in
            Text(row.time).font(.system(size: row.time.count > 5 ? 10.5 : 12).monospacedDigit()).foregroundColor(timeColor)
                .frame(width: 40, alignment: .leading)
            Text(row.title).font(.system(size: 13)).foregroundColor(titleColor).lineLimit(1)
            Spacer(minLength: 4)
            if !trailing.isEmpty {
                Text(trailing).font(.system(size: 11.5)).foregroundColor(trailing.hasPrefix("✓") ? Palette.butter : Palette.secondary)
            }
        }
    }
}

private struct RecentRowView: View {
    let row: MenuPanelContent.RecentRow
    let act: (MenuBarAction) -> Void
    @State private var copied = false

    var body: some View {
        HoverRow(height: 40, action: { row.dir.map { act(.openMeeting($0)) } ?? copy(.copyText(row.text)) }) { hovered in
            ZStack {
                Circle().fill(Color.white.opacity(0.06)).frame(width: 22, height: 22)
                if row.dir != nil {
                    Circle().strokeBorder(Palette.butter, lineWidth: 1.5).frame(width: 7, height: 7)
                } else {
                    Image(systemName: "mic").font(.system(size: 10, weight: .medium)).foregroundColor(Palette.secondary)
                }
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(row.title).font(.system(size: 13)).foregroundColor(Palette.text).lineLimit(1)
                Text(copied ? "Copied" : row.detail).font(.system(size: 11)).foregroundColor(copied ? Palette.butter : Palette.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            if hovered {
                if let dir = row.dir {
                    if row.hasTranscript { IconButton(symbol: "doc.text", help: "Open transcript") { act(.openTranscript(dir)) } }
                    IconButton(symbol: "sparkles", help: row.hasNotes ? "Open notes" : "Write notes", color: Palette.butter) { act(.openNotes(dir)) }
                    if row.hasTranscript { IconButton(symbol: "doc.on.doc", help: "Copy transcript") { copy(.copyTranscript(dir)) } }
                    IconButton(symbol: "folder", help: "Show in Finder") { act(.reveal(dir)) }
                } else {
                    PillButton(label: "Copy", style: .plain) { copy(.copyText(row.text)) }
                    PillButton(label: "Paste again", style: .plain) { act(.pasteAgain(row.text)) }
                }
            }
        }
    }

    private func copy(_ action: MenuBarAction) {
        act(action)
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
    }
}

private struct Footer: View {
    let age: String
    let refreshing: Bool
    let act: (MenuBarAction) -> Void

    var body: some View {
        HStack(spacing: 4) {
            PillButton(label: "Start meeting", style: .plain, padding: 7) { act(.startMeeting) }
            PillButton(label: "Dictate", style: .plain, padding: 7) { act(.dictate) }
            Spacer(minLength: 4)
            Text(age).font(.system(size: 11)).foregroundColor(Palette.secondary).lineLimit(1).fixedSize()
            IconButton(symbol: refreshing ? "hourglass" : "arrow.clockwise", help: "Refresh the calendar") { act(.refresh) }
            IconButton(symbol: "gearshape", help: "Open recorder.toml") { act(.settings) }
        }
        .padding(.horizontal, 2)
    }
}
