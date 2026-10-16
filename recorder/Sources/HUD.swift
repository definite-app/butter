import AppKit

/// Small floating pill: live mic level while dictating, a soft wave while
/// transcribing, and a timer with stop/cancel buttons for open-ended sessions
/// (hands-free dictation, meetings). A non-activating panel, so clicking it
/// never takes focus from the app the text will be pasted into.
final class HUD {
    enum State {
        case recording(level: () -> Float)
        case handsFree(level: () -> Float, since: Date)
        case meeting(level: () -> Float, since: Date)
        case transcribing
        case message(String)
        case error
    }

    var onStop: (() -> Void)?
    var onCancel: (() -> Void)?
    /// Recent dictations for the history list (newest first), and what to do when one is picked.
    var historyProvider: (() -> [HUDHistoryItem])?
    var onPickHistory: ((String) -> Void)?
    var position = "bottom"

    private let panel: NSPanel
    private let view = HUDView()
    private var timer: Timer?
    private var hideWork: DispatchWorkItem?

    init() {
        panel = NSPanel(contentRect: NSRect(origin: .zero, size: HUDView.size(for: .transcribing)),
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
        view.onStop = { [weak self] in self?.onStop?() }
        view.onCancel = { [weak self] in self?.onCancel?() }
        view.historyProvider = { [weak self] in self?.historyProvider?() ?? [] }
        view.onPick = { [weak self] in self?.onPickHistory?($0) }
        view.onLayoutChange = { [weak self] in
            guard let self else { return }
            self.place(self.view.totalSize)
            self.view.needsDisplay = true
        }
    }

    var isVisible: Bool { panel.isVisible }

    /// Live transcript shown above the pill (below it when position = "top").
    func setCaption(_ text: String?) {
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        view.caption = trimmed?.isEmpty == false ? trimmed : nil
        view.captionBelow = position == "top"
        guard panel.isVisible else { return }
        place(view.totalSize)
        view.needsDisplay = true
    }

    func show(_ state: State) {
        hideWork?.cancel()
        hideWork = nil
        view.setState(state)
        view.captionBelow = position == "top"
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
        case .message: hide(after: 1.6)
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
                self.timer?.invalidate()
                self.timer = nil
                self.hideWork = nil
            }
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// Centered on the screen with the mouse, near the bottom (or top).
    private func place(_ size: NSSize) {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
        guard let frame = screen?.visibleFrame else { return }
        let y = position == "top" ? frame.maxY - size.height - 48 : frame.minY + 56
        panel.setFrame(NSRect(x: (frame.midX - size.width / 2).rounded(), y: y, width: size.width, height: size.height), display: true)
    }
}

struct HUDHistoryItem {
    let text: String
    let at: Date?
}

private final class HUDView: NSView {
    private static let butter = NSColor(srgbRed: 0.961, green: 0.843, blue: 0.431, alpha: 1)  // #F5D76E
    private static let surface = NSColor(srgbRed: 0.11, green: 0.106, blue: 0.098, alpha: 0.94)
    private static let errorColor = NSColor(srgbRed: 0.898, green: 0.451, blue: 0.373, alpha: 1)
    private static let text = NSColor(white: 0.9, alpha: 1)
    private static let muted = NSColor(white: 0.62, alpha: 1)
    private static let height: CGFloat = 34
    private static let barCount = 9
    private static let compactBars = 5

    static func size(for state: HUD.State) -> NSSize {
        switch state {
        case .handsFree: return NSSize(width: 226, height: height)
        case .meeting: return NSSize(width: 170, height: height)
        case .message: return NSSize(width: 210, height: height)
        default: return NSSize(width: 112, height: height)
        }
    }

    private static let captionWidth: CGFloat = 460
    private static let captionGap: CGFloat = 8
    private static let captionFont = NSFont.systemFont(ofSize: 13.5, weight: .regular)

    private static let rowHeight: CGFloat = 30
    private static let historyLimit = 6

    var onStop: (() -> Void)?
    var onCancel: (() -> Void)?
    var historyProvider: (() -> [HUDHistoryItem])?
    var onPick: ((String) -> Void)?
    var onLayoutChange: (() -> Void)?
    /// Non-nil while the history list is open; it takes the caption's place.
    private var history: [HUDHistoryItem]?
    private var historyButtonRect = NSRect.zero
    private var rowRects: [NSRect] = []
    /// The row just clicked; it shows "Copied" in place of its time for a moment.
    private var copiedRow: Int?
    var caption: String?
    var captionBelow = false
    private var state: HUD.State = .transcribing
    private var start = Date()
    private var levels = [CGFloat](repeating: 0, count: HUDView.barCount)
    private var hovered: String?
    private var stopRect = NSRect.zero
    private var cancelRect = NSRect.zero

    private var pillSize: NSSize { Self.size(for: state) }

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

    /// The box above the pill: the history list when open, else the live caption.
    private var upperHeight: CGFloat? {
        if history != nil { return historyHeight }
        return caption == nil ? nil : captionHeight
    }

    var totalSize: NSSize {
        guard let upperHeight else { return pillSize }
        return NSSize(width: max(pillSize.width, Self.captionWidth), height: pillSize.height + Self.captionGap + upperHeight)
    }

    private var upperRect: NSRect {
        let height = upperHeight ?? 0
        return NSRect(x: (bounds.width - Self.captionWidth) / 2, y: captionBelow ? 0 : bounds.height - height,
                      width: Self.captionWidth, height: height)
    }

    /// Where the pill sits inside the view.
    private var pillOrigin: NSPoint {
        let x = ((bounds.width - pillSize.width) / 2).rounded()
        let y = upperHeight != nil && captionBelow ? bounds.height - pillSize.height : 0
        return NSPoint(x: x, y: y)
    }

    private func toggleHistory() {
        history = history == nil ? Array((historyProvider?() ?? []).prefix(Self.historyLimit)) : nil
        hovered = nil
        copiedRow = nil
        onLayoutChange?()
    }

    var hasButtons: Bool {
        switch state {
        case .handsFree, .meeting: return true
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

    override func mouseMoved(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        var next: String?
        if stopRect.contains(p) { next = "stop" }
        else if cancelRect.contains(p) { next = "cancel" }
        else if historyButtonRect.contains(p) { next = "history" }
        else if let row = rowRects.firstIndex(where: { $0.contains(p) }) { next = "row\(row)" }
        if next != hovered { hovered = next; needsDisplay = true }
    }

    override func mouseExited(with event: NSEvent) {
        hovered = nil
        needsDisplay = true
    }

    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if stopRect.contains(p) {
            onStop?()
        } else if cancelRect.contains(p) {
            onCancel?()
        } else if historyButtonRect.contains(p) {
            toggleHistory()
        } else if let row = rowRects.firstIndex(where: { $0.contains(p) }), let item = history?[row] {
            onPick?(item.text)
            copiedRow = row
            needsDisplay = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                guard let self, self.copiedRow == row else { return }
                self.copiedRow = nil
                self.needsDisplay = true
            }
        }
    }

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
        rowRects = []
        if let history { drawHistory(history) } else if let caption { drawCaption(caption) }
        let origin = pillOrigin
        NSGraphicsContext.saveGraphicsState()
        let shift = NSAffineTransform()
        shift.translateX(by: origin.x, yBy: origin.y)
        shift.concat()
        drawPill(NSRect(origin: .zero, size: pillSize))
        NSGraphicsContext.restoreGraphicsState()
        // Hit rects were computed in pill space.
        stopRect = stopRect.offsetBy(dx: origin.x, dy: origin.y)
        cancelRect = cancelRect.offsetBy(dx: origin.x, dy: origin.y)
        historyButtonRect = historyButtonRect.offsetBy(dx: origin.x, dy: origin.y)
    }

    private func drawBox(_ rect: NSRect) {
        let box = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 12, yRadius: 12)
        Self.surface.setFill()
        box.fill()
        NSColor(white: 1, alpha: 0.08).setStroke()
        box.lineWidth = 1
        box.stroke()
    }

    /// Recent dictations, newest nearest the pill. Click one to copy it.
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
            rowRects.append(row)
            let isHovered = hovered == "row\(i)"
            if isHovered {
                NSColor(white: 1, alpha: 0.07).setFill()
                NSBezierPath(roundedRect: row, xRadius: 7, yRadius: 7).fill()
            }
            let copied = copiedRow == i
            let time = NSAttributedString(string: copied ? "Copied" : relativeTime(item.at), attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: copied ? .medium : .regular),
                .foregroundColor: copied ? Self.butter : Self.muted,
            ])
            let timeSize = time.size()
            time.draw(at: NSPoint(x: row.maxX - 10 - timeSize.width, y: row.midY - timeSize.height / 2))
            let text = NSAttributedString(string: item.text.replacingOccurrences(of: "\n", with: " "), attributes: [
                .font: Self.captionFont, .foregroundColor: isHovered ? Self.text : NSColor(white: 0.78, alpha: 1), .paragraphStyle: paragraph,
            ])
            let textHeight = text.size().height
            text.draw(with: NSRect(x: row.minX + 8, y: row.midY - textHeight / 2, width: row.width - 30 - timeSize.width, height: textHeight),
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

    private var pill = NSRect.zero

    private func drawPill(_ bounds: NSRect) {
        pill = bounds
        let pill = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: bounds.height / 2, yRadius: bounds.height / 2)
        Self.surface.setFill()
        pill.fill()
        NSColor(white: 1, alpha: 0.08).setStroke()
        pill.lineWidth = 1
        pill.stroke()
        stopRect = .zero
        cancelRect = .zero
        historyButtonRect = .zero

        let t = Date().timeIntervalSince(start)
        switch state {
        case .recording:
            drawBars(count: Self.barCount, centerX: bounds.midX, color: Self.butter) { i in levels[i] }

        case let .handsFree(_, since):
            // [ bars  0:42  ×  ■ ]
            drawBars(count: Self.compactBars, centerX: 36, color: Self.butter) { i in levels[Self.barCount - Self.compactBars + i] }
            drawText(clock(since), at: 64, color: Self.text)
            historyButtonRect = NSRect(x: bounds.maxX - 96, y: bounds.midY - 12, width: 24, height: 24)
            cancelRect = NSRect(x: bounds.maxX - 66, y: bounds.midY - 12, width: 24, height: 24)
            stopRect = NSRect(x: bounds.maxX - 36, y: bounds.midY - 13, width: 26, height: 26)
            drawHistoryButton(historyButtonRect)
            drawCancel(cancelRect)
            drawStop(stopRect)

        case let .meeting(_, since):
            // [ ● 12:03  ■ ]  — the dot breathes with your mic level
            let level = levels.last ?? 0
            let r = 3.5 + 1.5 * level
            Self.butter.withAlphaComponent(0.55 + 0.45 * level).setFill()
            NSBezierPath(ovalIn: NSRect(x: 22 - r, y: bounds.midY - r, width: r * 2, height: r * 2)).fill()
            drawText(clock(since), at: 36, color: Self.text)
            stopRect = NSRect(x: bounds.maxX - 36, y: bounds.midY - 13, width: 26, height: 26)
            drawStop(stopRect)

        case .transcribing:
            drawBars(count: Self.barCount, centerX: bounds.midX, color: Self.butter.withAlphaComponent(0.55)) { i in
                CGFloat(0.16 + 0.22 * (1 + sin(t * 7 - Double(i) * 0.7)) / 2)
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

    private func clock(_ since: Date) -> String {
        let s = Int(Date().timeIntervalSince(since))
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }

    private func attributedString(_ string: String, color: NSColor) -> NSAttributedString {
        NSAttributedString(string: string, attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium),
            .foregroundColor: color,
        ])
    }

    private func drawText(_ string: String, at x: CGFloat, color: NSColor) {
        let attributed = attributedString(string, color: color)
        attributed.draw(at: NSPoint(x: x, y: pill.midY - attributed.size().height / 2))
    }

    private func drawStop(_ rect: NSRect) {
        (hovered == "stop" ? Self.butter : Self.butter.withAlphaComponent(0.16)).setFill()
        NSBezierPath(ovalIn: rect).fill()
        (hovered == "stop" ? Self.surface : Self.butter).setFill()
        let square = NSRect(x: rect.midX - 4.5, y: rect.midY - 4.5, width: 9, height: 9)
        NSBezierPath(roundedRect: square, xRadius: 2, yRadius: 2).fill()
    }

    private func drawHistoryButton(_ rect: NSRect) {
        let open = history != nil
        if open || hovered == "history" {
            (open ? Self.butter.withAlphaComponent(0.16) : NSColor(white: 1, alpha: 0.1)).setFill()
            NSBezierPath(ovalIn: rect).fill()
        }
        let color = open ? Self.butter : hovered == "history" ? Self.text : Self.muted
        let config = NSImage.SymbolConfiguration(pointSize: 11.5, weight: .medium)
            .applying(NSImage.SymbolConfiguration(paletteColors: [color]))
        guard let image = NSImage(systemSymbolName: "clock.arrow.circlepath", accessibilityDescription: "History")?
            .withSymbolConfiguration(config) else { return }
        let size = image.size
        image.draw(in: NSRect(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2, width: size.width, height: size.height))
    }

    private func drawCancel(_ rect: NSRect) {
        if hovered == "cancel" {
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
        (hovered == "cancel" ? Self.text : Self.muted).setStroke()
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
