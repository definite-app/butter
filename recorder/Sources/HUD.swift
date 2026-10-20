import AppKit

/// Small floating pill: live mic level while dictating, a soft wave while
/// transcribing, and a timer with buttons for open-ended sessions (hands-free
/// dictation, meetings). After a meeting it says when the transcript is ready.
/// A non-activating panel, so clicking it never takes focus from the app the
/// text will be pasted into. Drag it anywhere; it stays there (double-click to
/// put it back).
final class HUD {
    enum State {
        case recording(level: () -> Float)
        /// Hands-free; `sessionMeeting` picks the Dictate or Meeting side of its switch.
        case handsFree(level: () -> Float, since: Date)
        case meeting(level: () -> Float, since: Date)
        case transcribing
        /// A breathing ✦ and a label: "Cleaning up", "Writing notes".
        case working(String)
        /// A slow wave and a label, e.g. "Transcribing meeting · 32 min". Stays up.
        case processing(String)
        /// A meeting's transcript is ready: Open, Copy, ✦ Notes, ×. Stays until dismissed.
        case ready(title: String, detail: String)
        case message(String)
        case error
    }

    var onStop: (() -> Void)?
    var onCancel: (() -> Void)?
    /// Stop, then clean up the transcript before pasting (hands-free only).
    var onCleanup: (() -> Void)?
    /// The Dictate | Meeting switch: true = meeting.
    var onMode: ((Bool) -> Void)?
    var onScreenshot: (() -> Void)?
    /// The ready pill's buttons.
    var onOpen: (() -> Void)?
    var onCopy: (() -> Void)?
    var onNotes: (() -> Void)?
    var onDismiss: (() -> Void)?
    var showCleanup: Bool {
        get { view.showCleanup }
        set { view.showCleanup = newValue }
    }
    /// Which side of the hands-free switch is on.
    var sessionMeeting: Bool {
        get { view.sessionMeeting }
        set { view.sessionMeeting = newValue; relayout() }
    }
    /// Screenshots taken this session (the badge on 📷).
    var screenshotCount: Int {
        get { view.screenshotCount }
        set { view.screenshotCount = newValue; view.needsDisplay = true }
    }
    /// Recent dictations and meetings for the history list (newest first).
    var historyProvider: (() -> [HUDHistoryItem])?
    /// A dictation row was clicked: copy its text.
    var onPickHistory: ((String) -> Void)?
    /// A meeting row's Open, Copy or Notes.
    var onMeetingAction: ((URL, HUDMeetingAction) -> Void)?
    var position = "bottom"

    private let panel: NSPanel
    private let view = HUDView()
    private var timer: Timer?
    private var hideWork: DispatchWorkItem?
    private var cardWork: DispatchWorkItem?
    private var dragging = false
    private static let positionKey = "pillPosition"
    /// Where the pill was dragged to: its center x and bottom y as fractions of
    /// the screen's visible frame, so it lands in the same spot on any screen.
    private var dragged: NSPoint? = {
        guard let xy = UserDefaults.standard.array(forKey: HUD.positionKey) as? [Double], xy.count == 2 else { return nil }
        return NSPoint(x: xy[0], y: xy[1])
    }() {
        didSet {
            if let dragged { UserDefaults.standard.set([dragged.x, dragged.y], forKey: Self.positionKey) }
            else { UserDefaults.standard.removeObject(forKey: Self.positionKey) }
        }
    }
    /// The caption, cards and history go under the pill when it's near the top.
    private var upperBelow: Bool { dragged.map { $0.y > 0.5 } ?? (position == "top") }

    init() {
        panel = NSPanel(contentRect: NSRect(origin: .zero, size: NSSize(width: 112, height: 34)),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.contentView = view
        view.onAction = { [weak self] action in self?.perform(action) }
        view.onMeeting = { [weak self] dir, action in self?.onMeetingAction?(dir, action) }
        view.historyProvider = { [weak self] in self?.historyProvider?() ?? [] }
        view.onLayoutChange = { [weak self] in self?.relayout() }
        view.onDrag = { [weak self] event in self?.drag(event) }
    }

    var isVisible: Bool { panel.isVisible }

    private func perform(_ action: String) {
        switch action {
        case "stop": onStop?()
        case "cancel": onCancel?()
        case "cleanup": onCleanup?()
        case "mode:dictate": onMode?(false)
        case "mode:meeting": onMode?(true)
        case "shot": onScreenshot?()
        case "open": onOpen?()
        case "copy": onCopy?()
        case "notes": onNotes?()
        case "dismiss": onDismiss?()
        default:
            if action.hasPrefix("pick:") { onPickHistory?(String(action.dropFirst(5))) }
        }
    }

    private func relayout() {
        guard panel.isVisible else { return }
        place(view.totalSize)
        view.needsDisplay = true
    }

    /// Live transcript shown above the pill (below it when position = "top").
    func setCaption(_ text: String?) {
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        view.caption = trimmed?.isEmpty == false ? trimmed : nil
        relayout()
    }

    /// A thumbnail card above the pill for a couple of seconds: an image, or the
    /// start of some copied text.
    func flashCard(_ image: NSImage?, snippet: String? = nil, title: String, detail: String) {
        cardWork?.cancel()
        view.card = HUDCard(image: image, snippet: snippet, title: title, detail: detail)
        relayout()
        let work = DispatchWorkItem { [weak self] in
            self?.view.card = nil
            self?.relayout()
        }
        cardWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: work)
    }

    /// Out of the way while a screenshot is taken, without the fade.
    func suspend() {
        guard panel.isVisible else { return }
        panel.alphaValue = 0
    }

    func resume() {
        guard panel.isVisible else { return }
        panel.alphaValue = 1
    }

    /// `for`: how long a message stays up (default 1.6s).
    func show(_ state: State, for seconds: TimeInterval? = nil) {
        hideWork?.cancel()
        hideWork = nil
        view.setState(state)
        panel.ignoresMouseEvents = !view.hasButtons
        place(view.totalSize)
        if !panel.isVisible || panel.alphaValue < 1 {
            if !panel.isVisible { panel.alphaValue = 0 }
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { $0.duration = 0.08; panel.animator().alphaValue = 1 }
        }
        if timer == nil {
            let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.view.tick() }
            RunLoop.main.add(timer, forMode: .common)
            self.timer = timer
        }
        switch state {
        case .message: hide(after: seconds ?? 1.6)
        case .error: hide(after: 1.0)
        default: break
        }
    }

    func hide(after delay: TimeInterval = 0) {
        hideWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            NSAnimationContext.runAnimationGroup({ $0.duration = 0.15; self.panel.animator().alphaValue = 0 }) {
                // A newer show() cancels this hide; don't yank the panel out from under it.
                guard let work = self.hideWork, !work.isCancelled else { return }
                self.panel.orderOut(nil)
                self.view.caption = nil
                self.view.card = nil
                self.timer?.invalidate()
                self.timer = nil
                self.hideWork = nil
            }
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// Where it was dragged to, else centered near the bottom (or top), on the
    /// screen with the mouse when it appears. It stays on that screen while up.
    private func place(_ size: NSSize) {
        guard !dragging else { return }
        view.captionBelow = upperBelow
        let mouse = NSEvent.mouseLocation
        let screen = (panel.isVisible ? panel.screen : nil) ?? NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        guard let frame = screen?.visibleFrame else { return }
        var rect = NSRect(x: (frame.midX - size.width / 2).rounded(), y: 0, width: size.width, height: size.height)
        if let dragged {
            // The pill's bottom edge sits at the remembered spot, whatever is above or below it.
            let pillBottom = view.captionBelow ? size.height - view.pillHeight : 0
            rect.origin.x = (frame.minX + dragged.x * frame.width - size.width / 2).rounded()
            rect.origin.y = (frame.minY + dragged.y * frame.height - pillBottom).rounded()
            rect.origin.x = min(max(rect.minX, frame.minX), frame.maxX - size.width)
            rect.origin.y = min(max(rect.minY, frame.minY), frame.maxY - size.height)
        } else {
            rect.origin.y = position == "top" ? frame.maxY - size.height - 48 : frame.minY + 56
        }
        panel.setFrame(rect, display: true)
    }

    /// Moves the panel with the mouse until it's let go, then remembers where
    /// the pill is. A double-click puts it back in its usual place.
    private func drag(_ event: NSEvent) {
        if event.clickCount == 2 {
            dragged = nil
            relayout()
            return
        }
        let start = NSEvent.mouseLocation
        let origin = panel.frame.origin
        var moved = false
        dragging = true
        while let next = panel.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            let now = NSEvent.mouseLocation
            if abs(now.x - start.x) + abs(now.y - start.y) > 2 { moved = true }
            if moved { panel.setFrameOrigin(NSPoint(x: origin.x + now.x - start.x, y: origin.y + now.y - start.y)) }
            if next.type == .leftMouseUp { break }
        }
        dragging = false
        guard moved, let frame = panel.screen?.visibleFrame, frame.width > 0, frame.height > 0 else { return }
        let pill = view.pillFrame.offsetBy(dx: panel.frame.minX, dy: panel.frame.minY)
        dragged = NSPoint(x: min(1, max(0, (pill.midX - frame.minX) / frame.width)),
                          y: min(1, max(0, (pill.minY - frame.minY) / frame.height)))
        // Crossing the middle of the screen moves the caption to the other side.
        relayout()
    }
}

enum HUDMeetingAction { case open, copy, notes }

struct HUDHistoryItem {
    let text: String
    let at: Date?
    /// Set for a meeting: its folder. `detail` is its length, e.g. "32 min".
    var meeting: URL? = nil
    var detail: String? = nil
}

private struct HUDCard {
    let image: NSImage?
    var snippet: String? = nil
    let title: String
    let detail: String
}

private final class HUDView: NSView {
    private static let butter = NSColor(srgbRed: 0.961, green: 0.843, blue: 0.431, alpha: 1)  // #F5D76E
    private static let surface = NSColor(srgbRed: 0.11, green: 0.106, blue: 0.098, alpha: 0.94)
    private static let errorColor = NSColor(srgbRed: 0.898, green: 0.451, blue: 0.373, alpha: 1)
    private static let text = NSColor(white: 0.9, alpha: 1)
    private static let soft = NSColor(white: 0.78, alpha: 1)
    private static let muted = NSColor(white: 0.62, alpha: 1)
    private static let height: CGFloat = 34
    private static let barCount = 9
    private static let compactBars = 5
    private static let labelFont = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
    private static let switchFont = NSFont.systemFont(ofSize: 11.5, weight: .medium)

    private static let captionWidth: CGFloat = 460
    private static let cardWidth: CGFloat = 300
    private static let captionGap: CGFloat = 8
    private static let captionFont = NSFont.systemFont(ofSize: 13.5, weight: .regular)

    private static let rowHeight: CGFloat = 30
    private static let historyLimit = 6

    var onAction: ((String) -> Void)?
    var showCleanup = true
    var sessionMeeting = false
    var screenshotCount = 0
    var historyProvider: (() -> [HUDHistoryItem])?
    var onLayoutChange: (() -> Void)?
    /// A press outside the buttons: move the pill.
    var onDrag: ((NSEvent) -> Void)?
    /// Non-nil while the history list is open; it takes the caption's place.
    private var history: [HUDHistoryItem]?
    /// What was just copied ("copy", "row3"); it reads "Copied" for a moment.
    private var copied: String?
    var caption: String?
    var card: HUDCard?
    var captionBelow = false
    private var state: HUD.State = .transcribing
    private var start = Date()
    private var levels = [CGFloat](repeating: 0, count: HUDView.barCount)
    private var hovered: String?
    /// Clickable areas from the last draw, in view coordinates.
    private var hits: [(rect: NSRect, id: String)] = []

    private func width(_ s: String, _ font: NSFont = HUDView.labelFont) -> CGFloat {
        ceil(NSAttributedString(string: s, attributes: [.font: font]).size().width)
    }

    /// The Dictate | Meeting switch.
    private var switchSegments: [(id: String, label: String, width: CGFloat)] {
        [("mode:dictate", "Dictate", width("Dictate", Self.switchFont) + 18),
         ("mode:meeting", "Meeting", width("Meeting", Self.switchFont) + 18)]
    }

    private var switchWidth: CGFloat { switchSegments.reduce(6) { $0 + $1.width } }

    /// Text buttons on the ready pill.
    private let readyButtons: [(id: String, label: String)] = [("open", "Open"), ("copy", "Copy"), ("notes", "Notes")]

    private func readyButtonWidth(_ button: (id: String, label: String)) -> CGFloat {
        width(button.label) + (button.id == "notes" ? 34 : 22)
    }

    private var pillSize: NSSize {
        let w: CGFloat
        switch state {
        case .handsFree:
            // [ Dictate|Meeting  bars 0:42  ⟲ × 📷 ✦ ■ ] / [ Dictate|Meeting  ● 0:42  📷 × ■ ]
            let time = width("00:00") + 8
            let left = 5 + switchWidth + (sessionMeeting ? 14 + 9 + 9 : 12 + 31 + 10) + time
            let buttons: CGFloat = sessionMeeting ? 3 : (showCleanup ? 5 : 4)
            w = left + 12 + 26 + (buttons - 1) * 30 + 9
        case .meeting:
            w = 200
        case let .working(label):
            w = 14 + 8 + width(label) + 48
        case let .processing(label):
            w = 19 + 31 + 13 + width(label) + 19
        case let .ready(title, detail):
            let buttons = readyButtons.reduce(0) { $0 + readyButtonWidth($1) + 4 }
            w = 17 + 12 + 8 + width(title) + 7 + width(detail) + 16 + buttons + 24 + 5
        case let .message(message):
            w = max(150, width(message) + 12 + 40)
        default:
            w = 112
        }
        return NSSize(width: ceil(w), height: Self.height)
    }

    /// One or two lines, depending on how much text there is.
    private var captionHeight: CGFloat {
        guard let caption else { return 0 }
        let line = ceil(Self.captionFont.ascender - Self.captionFont.descender + Self.captionFont.leading) + 1
        let needed = NSAttributedString(string: caption, attributes: [.font: Self.captionFont])
            .boundingRect(with: NSSize(width: Self.captionWidth - 28, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin])
            .height
        return (needed > line * 1.5 ? line * 2 : line) + 20
    }

    private var historyHeight: CGFloat {
        CGFloat(max(1, history?.count ?? 0)) * Self.rowHeight + 12
    }

    /// The box above the pill: the history list when open, else a screenshot card, else the live caption.
    private var upper: (width: CGFloat, height: CGFloat)? {
        if history != nil { return (Self.captionWidth, historyHeight) }
        if card != nil { return (Self.cardWidth, 72) }
        return caption == nil ? nil : (Self.captionWidth, captionHeight)
    }

    var totalSize: NSSize {
        guard let upper else { return pillSize }
        return NSSize(width: max(pillSize.width, upper.width), height: pillSize.height + Self.captionGap + upper.height)
    }

    private var upperRect: NSRect {
        let size = upper ?? (0, 0)
        return NSRect(x: ((bounds.width - size.width) / 2).rounded(), y: captionBelow ? 0 : bounds.height - size.height,
                      width: size.width, height: size.height)
    }

    var pillHeight: CGFloat { Self.height }
    var pillFrame: NSRect { NSRect(origin: pillOrigin, size: pillSize) }

    /// Where the pill sits inside the view.
    private var pillOrigin: NSPoint {
        let x = ((bounds.width - pillSize.width) / 2).rounded()
        let y = upper != nil && captionBelow ? bounds.height - pillSize.height : 0
        return NSPoint(x: x, y: y)
    }

    private func toggleHistory() {
        history = history == nil ? Array((historyProvider?() ?? []).prefix(Self.historyLimit)) : nil
        hovered = nil
        copied = nil
        onLayoutChange?()
    }

    var hasButtons: Bool {
        switch state {
        case .handsFree, .meeting, .ready: return true
        default: return false
        }
    }

    func setState(_ state: HUD.State) {
        self.state = state
        history = nil
        start = Date()
        levels = [CGFloat](repeating: 0, count: Self.barCount)
        needsDisplay = true
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways], owner: self))
    }

    /// The most specific area under the point: a row's own buttons win over the row.
    private func hit(_ p: NSPoint) -> String? {
        hits.filter { $0.rect.contains(p) }.max { $0.id.count < $1.id.count }?.id
    }

    override func mouseMoved(with event: NSEvent) {
        let next = hit(convert(event.locationInWindow, from: nil))
        // Hovering a row's button keeps the row hovered too.
        if next != hovered { hovered = next; needsDisplay = true }
    }

    override func mouseExited(with event: NSEvent) {
        hovered = nil
        needsDisplay = true
    }

    private func flashCopied(_ id: String) {
        copied = id
        needsDisplay = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            guard let self, self.copied == id else { return }
            self.copied = nil
            self.needsDisplay = true
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard let id = hit(convert(event.locationInWindow, from: nil)) else {
            onDrag?(event)
            return
        }
        if id == "history" { toggleHistory(); return }
        if id.hasPrefix("row") {
            let parts = id.split(separator: ":")
            guard let index = Int(parts[0].dropFirst(3)), let item = history?[index] else { return }
            if let dir = item.meeting {
                let action: HUDMeetingAction = parts.count > 1 ? (parts[1] == "copy" ? .copy : parts[1] == "notes" ? .notes : .open) : .open
                if action == .copy { flashCopied("row\(index):copy") }
                onMeeting?(dir, action)
            } else {
                onAction?("pick:" + item.text)
                flashCopied("row\(index)")
            }
            return
        }
        if id == "copy" { flashCopied("copy") }
        onAction?(id)
    }

    /// A meeting row's Open, Copy or Notes, with its folder.
    var onMeeting: ((URL, HUDMeetingAction) -> Void)?

    func tick() {
        switch state {
        case let .recording(level), let .handsFree(level, _), let .meeting(level, _):
            // Speech RMS sits roughly between 0.003 and 0.3; map that log range to 0...1.
            let raw = CGFloat(level())
            levels.removeFirst()
            levels.append(min(1, max(0, (log10(max(raw, 1e-4)) + 2.6) / 2.1)))
        default:
            break
        }
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        hits = []
        if let history { drawHistory(history) } else if let card { drawCard(card) } else if let caption { drawCaption(caption) }
        let origin = pillOrigin
        let before = hits.count
        NSGraphicsContext.saveGraphicsState()
        let shift = NSAffineTransform()
        shift.translateX(by: origin.x, yBy: origin.y)
        shift.concat()
        drawPill(NSRect(origin: .zero, size: pillSize))
        NSGraphicsContext.restoreGraphicsState()
        // The pill's hit rects were computed in pill space.
        for i in before..<hits.count { hits[i].rect = hits[i].rect.offsetBy(dx: origin.x, dy: origin.y) }
    }

    private func drawBox(_ rect: NSRect) {
        let box = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 12, yRadius: 12)
        Self.surface.setFill()
        box.fill()
        NSColor(white: 1, alpha: 0.08).setStroke()
        box.lineWidth = 1
        box.stroke()
    }

    /// Recent dictations and meetings, newest nearest the pill. Click a dictation
    /// to copy it; a meeting opens, and shows Open, Copy and Notes on hover.
    private func drawHistory(_ items: [HUDHistoryItem]) {
        let rect = upperRect
        drawBox(rect)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        guard !items.isEmpty else {
            let empty = NSAttributedString(string: "No dictations yet", attributes: [.font: Self.captionFont, .foregroundColor: Self.muted])
            empty.draw(at: NSPoint(x: rect.minX + 14, y: rect.midY - empty.size().height / 2))
            return
        }
        for (i, item) in items.enumerated() {
            // Newest sits next to the pill: bottom row when the list is above it.
            let slot = captionBelow ? i : items.count - 1 - i
            let row = NSRect(x: rect.minX + 6, y: rect.minY + 6 + CGFloat(slot) * Self.rowHeight,
                             width: rect.width - 12, height: Self.rowHeight)
            let id = "row\(i)"
            hits.append((row, id))
            let isHovered = hovered == id || hovered?.hasPrefix(id + ":") == true
            if isHovered {
                NSColor(white: 1, alpha: 0.07).setFill()
                NSBezierPath(roundedRect: row, xRadius: 7, yRadius: 7).fill()
            }
            var textX = row.minX + 8
            var right = row.maxX - 10
            if item.meeting != nil {
                drawSymbol("person.2", in: NSRect(x: textX, y: row.midY - 8, width: 18, height: 16), size: 11,
                           color: isHovered ? Self.text : Self.muted)
                textX += 24
                if isHovered {
                    // Open · Copy · ✦ Notes, right to left.
                    right = row.maxX - 4
                    for (action, label) in [("notes", "Notes"), ("copy", "Copy"), ("open", "Open")] {
                        let shown = copied == "\(id):copy" && action == "copy" ? "Copied" : label
                        let w = width(shown, Self.switchFont) + (action == "notes" ? 30 : 18)
                        let button = NSRect(x: right - w, y: row.midY - 11, width: w, height: 22)
                        drawTextButton(shown, in: button, id: "\(id):\(action)", primary: action == "open",
                                       sparkle: action == "notes", font: Self.switchFont)
                        right = button.minX - 2
                    }
                    right -= 6
                }
            }
            if item.meeting == nil || !isHovered {
                let copiedNow = copied == id
                var label = copiedNow ? "Copied" : relativeTime(item.at)
                if let detail = item.detail, !copiedNow { label = "\(detail) · \(label)" }
                let time = NSAttributedString(string: label, attributes: [
                    .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: copiedNow ? .medium : .regular),
                    .foregroundColor: copiedNow ? Self.butter : Self.muted,
                ])
                let timeSize = time.size()
                time.draw(at: NSPoint(x: right - timeSize.width, y: row.midY - timeSize.height / 2))
                right -= timeSize.width + 12
            }
            let text = NSAttributedString(string: item.text.replacingOccurrences(of: "\n", with: " "), attributes: [
                .font: Self.captionFont, .foregroundColor: isHovered ? Self.text : Self.soft, .paragraphStyle: paragraph,
            ])
            let textHeight = text.size().height
            text.draw(with: NSRect(x: textX, y: row.midY - textHeight / 2, width: max(0, right - textX), height: textHeight),
                      options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        }
    }

    private func relativeTime(_ date: Date?) -> String {
        guard let date else { return "" }
        let s = Int(Date().timeIntervalSince(date))
        if s < 60 { return "now" }
        if s < 3600 { return "\(s / 60)m" }
        if s < 86400 { return "\(s / 3600)h" }
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f.string(from: date)
    }

    /// Shows the tail of the live transcript: older words dim, the newest bright.
    private func drawCaption(_ text: String) {
        let rect = upperRect
        drawBox(rect)

        let inner = rect.insetBy(dx: 14, dy: 10)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        func styled(_ s: String) -> NSAttributedString {
            let out = NSMutableAttributedString(string: s, attributes: [
                .font: Self.captionFont, .foregroundColor: Self.muted, .paragraphStyle: paragraph,
            ])
            // Brighten the last few words: that's where the eye goes.
            let words = s.split(separator: " ")
            let tail = words.suffix(4).joined(separator: " ")
            if let range = s.range(of: tail, options: .backwards) {
                out.addAttribute(.foregroundColor, value: Self.text, range: NSRange(range, in: s))
            }
            return out
        }
        // Drop words from the front until it fits in two lines.
        var words = text.split(separator: " ").map(String.init)
        var shown = styled(text)
        while words.count > 1,
              shown.boundingRect(with: NSSize(width: inner.width, height: .greatestFiniteMagnitude),
                                 options: [.usesLineFragmentOrigin]).height > inner.height + 1 {
            words.removeFirst()
            shown = styled("… " + words.joined(separator: " "))
        }
        shown.draw(with: inner, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }

    /// "Screenshot 2 saved" with a thumbnail.
    private func drawCard(_ card: HUDCard) {
        let rect = upperRect
        drawBox(rect)
        let thumb = NSRect(x: rect.minX + 8, y: rect.midY - 28, width: 88, height: 56)
        NSGraphicsContext.saveGraphicsState()
        let clip = NSBezierPath(roundedRect: thumb, xRadius: 6, yRadius: 6)
        clip.addClip()
        NSColor(white: 1, alpha: 0.06).setFill()
        clip.fill()
        if let image = card.image, image.size.width > 0, image.size.height > 0 {
            // Aspect fill.
            let scale = max(thumb.width / image.size.width, thumb.height / image.size.height)
            let size = NSSize(width: image.size.width * scale, height: image.size.height * scale)
            image.draw(in: NSRect(x: thumb.midX - size.width / 2, y: thumb.midY - size.height / 2, width: size.width, height: size.height))
        } else if let snippet = card.snippet {
            // The start of the copied text, like a tiny page.
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byCharWrapping
            NSAttributedString(string: String(snippet.prefix(160)), attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 7.5, weight: .regular), .foregroundColor: Self.soft, .paragraphStyle: paragraph,
            ]).draw(with: thumb.insetBy(dx: 6, dy: 5), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
        }
        NSGraphicsContext.restoreGraphicsState()
        let truncating = NSMutableParagraphStyle()
        truncating.lineBreakMode = .byTruncatingTail
        let title = NSAttributedString(string: card.title, attributes: [.font: Self.labelFont, .foregroundColor: Self.text, .paragraphStyle: truncating])
        let detail = NSAttributedString(string: card.detail, attributes: [.font: NSFont.systemFont(ofSize: 11.5), .foregroundColor: Self.muted,
                                                                          .paragraphStyle: truncating])
        let x = thumb.maxX + 10
        let textWidth = rect.maxX - 10 - x
        title.draw(with: NSRect(x: x, y: rect.midY + 1, width: textWidth, height: title.size().height), options: [.usesLineFragmentOrigin])
        detail.draw(with: NSRect(x: x, y: rect.midY - detail.size().height - 1, width: textWidth, height: detail.size().height),
                    options: [.usesLineFragmentOrigin])
    }

    private var pill = NSRect.zero

    private func drawPill(_ bounds: NSRect) {
        pill = bounds
        let pill = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: bounds.height / 2, yRadius: bounds.height / 2)
        Self.surface.setFill()
        pill.fill()
        NSColor(white: 1, alpha: 0.08).setStroke()
        pill.lineWidth = 1
        pill.stroke()

        let t = Date().timeIntervalSince(start)
        switch state {
        case .recording:
            drawBars(count: Self.barCount, centerX: bounds.midX, color: Self.butter) { i in levels[i] }

        case let .handsFree(_, since):
            // [ Dictate|Meeting  bars 0:42  ⟲ × 📷 ✦ ■ ]  (✦ = stop and clean up)
            var x = drawSwitch(at: 5)
            if sessionMeeting {
                drawLevelDot(centerX: x + 14 + 4.5)
                x += 14 + 9 + 9
            } else {
                x += 12
                drawBars(count: Self.compactBars, centerX: x + 15.5, color: Self.butter) { i in levels[Self.barCount - Self.compactBars + i] }
                x += 31 + 10
            }
            drawText(clock(since), at: x, color: Self.text)
            var right = bounds.maxX - 9 - 26
            drawStop(NSRect(x: right, y: bounds.midY - 13, width: 26, height: 26))
            var icons: [String] = sessionMeeting ? ["shot", "cancel"] : ["history", "cancel", "shot"]
            if !sessionMeeting && showCleanup { icons.append("cleanup") }
            for id in icons.reversed() {
                right -= 30
                let rect = NSRect(x: right, y: bounds.midY - 12, width: 24, height: 24)
                switch id {
                case "history": drawHistoryButton(rect)
                case "cancel": drawCancel(rect)
                case "shot": drawScreenshotButton(rect)
                default: drawCleanupButton(rect)
                }
            }

        case let .meeting(_, since):
            // [ ● 12:03  📷 ■ ]  — the dot breathes with your mic level
            drawLevelDot(centerX: 22)
            drawText(clock(since), at: 36, color: Self.text)
            drawStop(NSRect(x: bounds.maxX - 35, y: bounds.midY - 13, width: 26, height: 26))
            drawScreenshotButton(NSRect(x: bounds.maxX - 65, y: bounds.midY - 12, width: 24, height: 24))

        case .transcribing:
            drawBars(count: Self.barCount, centerX: bounds.midX, color: Self.butter.withAlphaComponent(0.55)) { i in
                CGFloat(0.16 + 0.22 * (1 + sin(t * 7 - Double(i) * 0.7)) / 2)
            }

        case let .working(text):
            // [ ✦ Cleaning up ]  — the sparkle breathes while the model works
            let label = attributedString(text, color: Self.text)
            let total = 14 + 8 + label.size().width
            let x = bounds.midX - total / 2
            let alpha = 0.55 + 0.45 * (1 + sin(t * 4)) / 2
            drawSymbol("sparkles", in: NSRect(x: x, y: bounds.midY - 7, width: 14, height: 14), size: 12,
                       color: Self.butter.withAlphaComponent(alpha))
            label.draw(at: NSPoint(x: x + 22, y: bounds.midY - label.size().height / 2))

        case let .processing(text):
            // [ ∿ Transcribing meeting · 32 min ]
            drawBars(count: Self.compactBars, centerX: 19 + 15.5, color: Self.butter.withAlphaComponent(0.55)) { i in
                CGFloat(0.16 + 0.22 * (1 + sin(t * 5 - Double(i) * 0.8)) / 2)
            }
            drawText(text, at: 19 + 31 + 13, color: Self.text)

        case let .ready(title, detail):
            // [ ✓ Meeting ready 32 min  Open Copy ✦Notes × ]
            drawSymbol("checkmark", in: NSRect(x: 17, y: bounds.midY - 6, width: 12, height: 12), size: 11, color: Self.butter)
            drawText(title, at: 37, color: Self.text)
            drawText(detail, at: 37 + width(title) + 7, color: Self.muted)
            var right = bounds.maxX - 5 - 24
            drawCancel(NSRect(x: right, y: bounds.midY - 12, width: 24, height: 24), id: "dismiss")
            for button in readyButtons.reversed() {
                let label = copied == "copy" && button.id == "copy" ? "Copied" : button.label
                let w = readyButtonWidth((button.id, label))
                right -= w + 4
                drawTextButton(label, in: NSRect(x: right, y: bounds.midY - 12, width: w, height: 24), id: button.id,
                               primary: button.id == "open", sparkle: button.id == "notes", font: Self.labelFont)
            }

        case .error:
            drawBars(count: Self.barCount, centerX: bounds.midX, color: Self.errorColor) { _ in 0.1 }

        case let .message(message):
            let attributed = attributedString(message, color: Self.text)
            let width = attributed.size().width + 12
            Self.butter.setFill()
            NSBezierPath(ovalIn: NSRect(x: bounds.midX - width / 2, y: bounds.midY - 3, width: 6, height: 6)).fill()
            attributed.draw(at: NSPoint(x: bounds.midX - width / 2 + 12, y: bounds.midY - attributed.size().height / 2))
        }
    }

    /// The Dictate | Meeting switch; returns its right edge.
    private func drawSwitch(at x: CGFloat) -> CGFloat {
        let track = NSRect(x: x, y: pill.midY - 12, width: switchWidth, height: 24)
        NSColor(white: 1, alpha: 0.06).setFill()
        NSBezierPath(roundedRect: track, xRadius: 12, yRadius: 12).fill()
        var sx = track.minX + 2
        for segment in switchSegments {
            let rect = NSRect(x: sx, y: track.minY + 2, width: segment.width, height: 20)
            let active = (segment.id == "mode:meeting") == sessionMeeting
            if active {
                Self.butter.withAlphaComponent(0.16).setFill()
                NSBezierPath(roundedRect: rect, xRadius: 10, yRadius: 10).fill()
            } else {
                hits.append((rect, segment.id))
                if hovered == segment.id {
                    NSColor(white: 1, alpha: 0.08).setFill()
                    NSBezierPath(roundedRect: rect, xRadius: 10, yRadius: 10).fill()
                }
            }
            let color = active ? Self.butter : hovered == segment.id ? Self.text : Self.muted
            let label = NSAttributedString(string: segment.label, attributes: [.font: Self.switchFont, .foregroundColor: color])
            let size = label.size()
            label.draw(at: NSPoint(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2))
            sx += segment.width + 2
        }
        return track.maxX
    }

    private func drawLevelDot(centerX: CGFloat) {
        let level = levels.last ?? 0
        let r = 3.5 + 1.5 * level
        Self.butter.withAlphaComponent(0.55 + 0.45 * level).setFill()
        NSBezierPath(ovalIn: NSRect(x: centerX - r, y: pill.midY - r, width: r * 2, height: r * 2)).fill()
    }

    private func drawTextButton(_ text: String, in rect: NSRect, id: String, primary: Bool, sparkle: Bool, font: NSFont) {
        hits.append((rect, id))
        let hover = hovered == id
        if primary {
            Self.butter.withAlphaComponent(hover ? 0.28 : 0.16).setFill()
            NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2).fill()
        } else if hover {
            NSColor(white: 1, alpha: 0.1).setFill()
            NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2).fill()
        }
        let color = primary || text == "Copied" ? Self.butter : hover ? Self.text : Self.soft
        let label = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
        let size = label.size()
        var x = rect.midX - size.width / 2
        if sparkle {
            x += 7
            drawSymbol("sparkles", in: NSRect(x: x - 16, y: rect.midY - 6, width: 12, height: 12), size: 10.5, color: Self.butter)
        }
        label.draw(at: NSPoint(x: x, y: rect.midY - size.height / 2))
    }

    private func clock(_ since: Date) -> String {
        let s = Int(Date().timeIntervalSince(since))
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }

    private func attributedString(_ string: String, color: NSColor) -> NSAttributedString {
        NSAttributedString(string: string, attributes: [.font: Self.labelFont, .foregroundColor: color])
    }

    private func drawText(_ string: String, at x: CGFloat, color: NSColor) {
        let attributed = attributedString(string, color: color)
        attributed.draw(at: NSPoint(x: x, y: pill.midY - attributed.size().height / 2))
    }

    private func drawStop(_ rect: NSRect) {
        hits.append((rect, "stop"))
        (hovered == "stop" ? Self.butter : Self.butter.withAlphaComponent(0.16)).setFill()
        NSBezierPath(ovalIn: rect).fill()
        (hovered == "stop" ? Self.surface : Self.butter).setFill()
        let square = NSRect(x: rect.midX - 4.5, y: rect.midY - 4.5, width: 9, height: 9)
        NSBezierPath(roundedRect: square, xRadius: 2, yRadius: 2).fill()
    }

    private func drawHistoryButton(_ rect: NSRect) {
        hits.append((rect, "history"))
        let open = history != nil
        if open || hovered == "history" {
            (open ? Self.butter.withAlphaComponent(0.16) : NSColor(white: 1, alpha: 0.1)).setFill()
            NSBezierPath(ovalIn: rect).fill()
        }
        let color = open ? Self.butter : hovered == "history" ? Self.text : Self.muted
        drawSymbol("clock.arrow.circlepath", in: rect, size: 11.5, color: color)
    }

    private func drawCleanupButton(_ rect: NSRect) {
        hits.append((rect, "cleanup"))
        let hover = hovered == "cleanup"
        if hover {
            Self.butter.withAlphaComponent(0.16).setFill()
            NSBezierPath(ovalIn: rect).fill()
        }
        drawSymbol("sparkles", in: rect, size: 11.5, color: hover ? Self.butter : Self.butter.withAlphaComponent(0.75))
    }

    /// 📷, with a count once screenshots have been taken.
    private func drawScreenshotButton(_ rect: NSRect) {
        hits.append((rect, "shot"))
        let hover = hovered == "shot"
        if hover {
            NSColor(white: 1, alpha: 0.1).setFill()
            NSBezierPath(ovalIn: rect).fill()
        }
        let taken = screenshotCount > 0
        drawSymbol("camera", in: rect, size: 11, color: taken ? Self.butter : hover ? Self.text : Self.muted)
        guard taken else { return }
        let count = NSAttributedString(string: "\(screenshotCount)", attributes: [
            .font: NSFont.systemFont(ofSize: 9, weight: .bold), .foregroundColor: Self.surface.withAlphaComponent(1),
        ])
        let size = count.size()
        let badge = NSRect(x: rect.maxX - 11, y: rect.maxY - 11, width: max(12, size.width + 6), height: 12)
        Self.butter.setFill()
        NSBezierPath(roundedRect: badge, xRadius: 6, yRadius: 6).fill()
        count.draw(at: NSPoint(x: badge.midX - size.width / 2, y: badge.midY - size.height / 2))
    }

    private func drawSymbol(_ name: String, in rect: NSRect, size: CGFloat, color: NSColor) {
        let config = NSImage.SymbolConfiguration(pointSize: size, weight: .medium)
            .applying(NSImage.SymbolConfiguration(paletteColors: [color]))
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(config) else { return }
        let s = image.size
        image.draw(in: NSRect(x: rect.midX - s.width / 2, y: rect.midY - s.height / 2, width: s.width, height: s.height))
    }

    private func drawCancel(_ rect: NSRect, id: String = "cancel") {
        hits.append((rect, id))
        if hovered == id {
            NSColor(white: 1, alpha: 0.1).setFill()
            NSBezierPath(ovalIn: rect).fill()
        }
        let path = NSBezierPath()
        let d: CGFloat = 4
        path.move(to: NSPoint(x: rect.midX - d, y: rect.midY - d))
        path.line(to: NSPoint(x: rect.midX + d, y: rect.midY + d))
        path.move(to: NSPoint(x: rect.midX - d, y: rect.midY + d))
        path.line(to: NSPoint(x: rect.midX + d, y: rect.midY - d))
        path.lineWidth = 1.6
        path.lineCapStyle = .round
        (hovered == id ? Self.text : Self.muted).setStroke()
        path.stroke()
    }

    private func drawBars(count: Int, centerX: CGFloat, color: NSColor, height: (Int) -> CGFloat) {
        let width: CGFloat = 3, gap: CGFloat = 4
        let total = CGFloat(count) * width + CGFloat(count - 1) * gap
        let maxHeight = pill.height - 14, minHeight: CGFloat = 3
        color.setFill()
        for i in 0..<count {
            // Taper the edges so it reads as a waveform, not a bar chart.
            let taper = 1 - 0.45 * abs(CGFloat(i) - CGFloat(count - 1) / 2) / (CGFloat(count) / 2)
            let h = max(minHeight, height(i) * maxHeight * taper)
            let x = centerX - total / 2 + CGFloat(i) * (width + gap)
            NSBezierPath(roundedRect: NSRect(x: x, y: pill.midY - h / 2, width: width, height: h), xRadius: width / 2, yRadius: width / 2).fill()
        }
    }
}
