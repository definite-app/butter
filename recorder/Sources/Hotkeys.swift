import Carbon.HIToolbox
import Foundation

struct HotkeySpec: CustomStringConvertible {
    /// nil: modifiers alone, e.g. "fn+shift".
    let keyCode: UInt32?
    /// Carbon modifier mask.
    let modifiers: UInt32
    let function: Bool
    let description: String

    /// Carbon can't register fn or modifier-only hotkeys; those go through an event tap.
    var needsEventTap: Bool { function || keyCode == nil }

    /// The modifiers as event flags, for the event tap.
    var flags: CGEventFlags {
        var flags: CGEventFlags = []
        if modifiers & UInt32(cmdKey) != 0 { flags.insert(.maskCommand) }
        if modifiers & UInt32(controlKey) != 0 { flags.insert(.maskControl) }
        if modifiers & UInt32(optionKey) != 0 { flags.insert(.maskAlternate) }
        if modifiers & UInt32(shiftKey) != 0 { flags.insert(.maskShift) }
        if function { flags.insert(.maskSecondaryFn) }
        return flags
    }

    private static let keys: [String: Int] = {
        var map: [String: Int] = [
            "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E,
            "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J,
            "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O,
            "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
            "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y,
            "z": kVK_ANSI_Z,
            "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
            "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
            "space": kVK_Space, "return": kVK_Return, "enter": kVK_Return, "tab": kVK_Tab,
            "escape": kVK_Escape, "esc": kVK_Escape, "delete": kVK_Delete, "backspace": kVK_Delete,
            "minus": kVK_ANSI_Minus, "-": kVK_ANSI_Minus, "equal": kVK_ANSI_Equal, "=": kVK_ANSI_Equal,
            "comma": kVK_ANSI_Comma, ",": kVK_ANSI_Comma, "period": kVK_ANSI_Period, ".": kVK_ANSI_Period,
            "slash": kVK_ANSI_Slash, "/": kVK_ANSI_Slash, "semicolon": kVK_ANSI_Semicolon, ";": kVK_ANSI_Semicolon,
            "quote": kVK_ANSI_Quote, "'": kVK_ANSI_Quote, "backslash": kVK_ANSI_Backslash, "\\": kVK_ANSI_Backslash,
            "grave": kVK_ANSI_Grave, "`": kVK_ANSI_Grave, "tilde": kVK_ANSI_Grave, "~": kVK_ANSI_Grave, "[": kVK_ANSI_LeftBracket, "]": kVK_ANSI_RightBracket,
            "left": kVK_LeftArrow, "right": kVK_RightArrow, "up": kVK_UpArrow, "down": kVK_DownArrow,
            "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pagedown": kVK_PageDown,
        ]
        let fkeys = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
                     kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20]
        for (i, code) in fkeys.enumerated() { map["f\(i + 1)"] = code }
        return map
    }()

    static func parse(_ text: String) throws -> HotkeySpec {
        var modifiers: UInt32 = 0
        var function = false
        var keyCode: Int?
        for part in text.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            switch part {
            case "cmd", "command", "⌘": modifiers |= UInt32(cmdKey)
            case "ctrl", "control", "⌃": modifiers |= UInt32(controlKey)
            case "alt", "opt", "option", "⌥": modifiers |= UInt32(optionKey)
            case "shift", "⇧": modifiers |= UInt32(shiftKey)
            case "fn", "function", "globe", "🌐": function = true
            case "capslock", "caps", "caps_lock", "⇪":
                // It turns Caps Lock on and off at the hardware level, and macOS
                // ignores quick presses of it, so it can't be a reliable hotkey.
                throw CLIError("Invalid hotkey \"\(text)\": Caps Lock can't be part of a hotkey")
            default:
                guard keyCode == nil, let code = keys[part] else {
                    throw CLIError("Invalid hotkey \"\(text)\": unknown or repeated key \"\(part)\"")
                }
                keyCode = code
            }
        }
        if keyCode == nil && !function && modifiers.nonzeroBitCount < 2 {
            // A lone shift, cmd, ... would go off all the time while typing.
            throw CLIError("Invalid hotkey \"\(text)\": a hotkey without a key needs fn or at least two modifiers")
        }
        return HotkeySpec(keyCode: keyCode.map(UInt32.init), modifiers: modifiers, function: function, description: text)
    }
}

enum HotkeyEvent {
    case pressed, released
    /// A modifier-only hotkey turned out to be part of another shortcut (a key
    /// was pressed, or another modifier joined) after it had been pressed.
    case interrupted
}

/// Global hotkeys. Plain ones go through Carbon's RegisterEventHotKey, which
/// needs no permission; fn and modifier-only ones through an event tap, which
/// needs Accessibility. Both deliver press and release, so push-to-talk works.
final class HotkeyManager {
    typealias Handler = (HotkeyEvent) -> Void

    private var refs: [UInt32: EventHotKeyRef] = [:]
    private var handlers: [UInt32: Handler] = [:]
    private var handlerRef: EventHandlerRef?
    private var nextID: UInt32 = 1
    private let tap = EventTapHotkeys()

    func install() {
        var types = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let event, let userData else { return noErr }
            var hotKeyID = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
            let manager = Unmanaged<HotkeyManager>.fromOpaque(userData).takeUnretainedValue()
            let pressed = GetEventKind(event) == UInt32(kEventHotKeyPressed)
            manager.handlers[hotKeyID.id]?(pressed ? .pressed : .released)
            return noErr
        }, types.count, &types, selfPtr, &handlerRef)
    }

    /// Returns an id for `unregister`.
    @discardableResult
    func register(_ spec: HotkeySpec, handler: @escaping Handler) throws -> UInt32 {
        let id = nextID
        nextID += 1
        if spec.needsEventTap {
            try tap.add(spec, id: id, handler: handler)
            return id
        }
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(spec.keyCode ?? 0, spec.modifiers, EventHotKeyID(signature: OSType(0x4252_5452), id: id),
                                         GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let ref else {
            throw CLIError("Couldn't register hotkey \(spec) (status \(status)); another app may own it")
        }
        refs[id] = ref
        handlers[id] = handler
        return id
    }

    func unregister(_ id: UInt32) {
        if let ref = refs.removeValue(forKey: id) { UnregisterEventHotKey(ref) }
        handlers[id] = nil
        tap.remove(id)
    }

    func unregisterAll() {
        refs.values.forEach { UnregisterEventHotKey($0) }
        refs.removeAll()
        handlers.removeAll()
        tap.removeAll()
    }
}

/// Hotkeys Carbon can't do (fn, or modifiers alone), seen through a CGEvent
/// tap on the main run loop. A hotkey with a key is swallowed so the app in
/// front doesn't get it too. A modifier-only one fires once its modifiers have
/// been held for a moment with no key, so fn+shift+arrow and the like don't
/// set it off; if a key comes after that, it gets `.interrupted`.
final class EventTapHotkeys {
    private struct Binding {
        let id: UInt32
        let spec: HotkeySpec
        let handler: HotkeyManager.Handler
    }

    private enum Chord {
        case idle
        /// Modifiers match, waiting out the grace period.
        case pending(Int, DispatchWorkItem)
        /// Pressed was sent; released or interrupted comes next.
        case held(Int)
        /// A key was pressed while they were down; wait for them to change.
        case spoiled
    }

    static let grace = 0.15
    private static let relevant: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift, .maskSecondaryFn]
    /// Keys macOS always reports with the fn flag set, fn held or not.
    private static let fnTagged: Set<Int64> = Set([
        kVK_LeftArrow, kVK_RightArrow, kVK_UpArrow, kVK_DownArrow, kVK_Home, kVK_End, kVK_PageUp, kVK_PageDown,
        kVK_ForwardDelete, kVK_Help, kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
        kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20,
    ].map(Int64.init))

    private var bindings: [Binding] = []
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var chord = Chord.idle
    /// Hotkeys whose key is down, by key code.
    private var down: [Int64: Int] = [:]

    func add(_ spec: HotkeySpec, id: UInt32, handler: @escaping HotkeyManager.Handler) throws {
        try start()
        bindings.append(Binding(id: id, spec: spec, handler: handler))
    }

    /// Key state is kept by index, so it starts over.
    func remove(_ id: UInt32) {
        guard bindings.contains(where: { $0.id == id }) else { return }
        bindings.removeAll { $0.id == id }
        if case let .pending(_, work) = chord { work.cancel() }
        chord = .idle
        down.removeAll()
    }

    func removeAll() {
        bindings.removeAll()
        if case let .pending(_, work) = chord { work.cancel() }
        chord = .idle
        down.removeAll()
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil
        source = nil
    }

    private func start() throws {
        guard tap == nil else { return }
        let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.flagsChanged.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, info in
            guard let info else { return Unmanaged.passUnretained(event) }
            let me = Unmanaged<EventTapHotkeys>.fromOpaque(info).takeUnretainedValue()
            return me.handle(type, event) ? nil : Unmanaged.passUnretained(event)
        }
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                          eventsOfInterest: CGEventMask(mask), callback: callback,
                                          userInfo: Unmanaged.passUnretained(self).toOpaque()) else {
            throw CLIError("fn and modifier-only hotkeys need Accessibility access for ButterRec "
                + "(System Settings > Privacy & Security > Accessibility)")
        }
        let source = CFMachPortCreateRunLoopSource(nil, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        self.source = source
    }

    /// Returns true to swallow the event.
    private func handle(_ type: CGEventType, _ event: CGEvent) -> Bool {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return false
        case .flagsChanged:
            flagsChanged(event.flags.intersection(Self.relevant))
            return false
        case .keyDown:
            return keyDown(event)
        case .keyUp:
            guard let i = down.removeValue(forKey: event.getIntegerValueField(.keyboardEventKeycode)) else { return false }
            fire(i, .released)
            return true
        default:
            return false
        }
    }

    private func flagsChanged(_ mods: CGEventFlags) {
        switch chord {
        case let .pending(i, work):
            if mods == bindings[i].spec.flags { return }
            work.cancel()
            chord = .idle
            // Let go before the grace period ran out: a quick tap still counts.
            if bindings[i].spec.flags.isSuperset(of: mods) {
                fire(i, .pressed)
                fire(i, .released)
            }
        case let .held(i):
            if mods == bindings[i].spec.flags { return }
            chord = .idle
            // Fewer modifiers: let go. More: it's the start of another shortcut.
            fire(i, bindings[i].spec.flags.isSuperset(of: mods) ? .released : .interrupted)
        case .spoiled:
            chord = .idle
        case .idle:
            break
        }
        guard case .idle = chord,
              let i = bindings.firstIndex(where: { $0.spec.keyCode == nil && $0.spec.flags == mods }) else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, case let .pending(j, _) = self.chord, j == i else { return }
            self.chord = .held(i)
            self.fire(i, .pressed)
        }
        chord = .pending(i, work)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.grace, execute: work)
    }

    private func keyDown(_ event: CGEvent) -> Bool {
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        if event.getIntegerValueField(.keyboardEventAutorepeat) != 0 { return down[code] != nil }
        var interrupted: Int?
        switch chord {
        case let .pending(_, work):
            work.cancel()
            chord = .spoiled
        case let .held(i):
            interrupted = i
            chord = .spoiled
        case .spoiled, .idle:
            break
        }
        let mods = event.flags.intersection(Self.relevant)
        let match = bindings.firstIndex { binding in
            guard let key = binding.spec.keyCode, Int64(key) == code else { return false }
            var mods = mods
            if !binding.spec.function && Self.fnTagged.contains(code) { mods.remove(.maskSecondaryFn) }
            return mods == binding.spec.flags
        }
        // The new hotkey first, so the interrupted one can see it was taken over.
        if let match {
            down[code] = match
            fire(match, .pressed)
        }
        if let interrupted { fire(interrupted, .interrupted) }
        return match != nil
    }

    /// Handlers run after the tap callback returns, so a slow one can't stall the keyboard.
    private func fire(_ i: Int, _ event: HotkeyEvent) {
        let handler = bindings[i].handler
        DispatchQueue.main.async { handler(event) }
    }
}
