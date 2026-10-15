import Carbon.HIToolbox
import Foundation

struct HotkeySpec: CustomStringConvertible {
    let keyCode: UInt32
    let modifiers: UInt32
    let description: String

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
            "grave": kVK_ANSI_Grave, "`": kVK_ANSI_Grave, "[": kVK_ANSI_LeftBracket, "]": kVK_ANSI_RightBracket,
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
        var keyCode: Int?
        for part in text.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            switch part {
            case "cmd", "command", "⌘": modifiers |= UInt32(cmdKey)
            case "ctrl", "control", "⌃": modifiers |= UInt32(controlKey)
            case "alt", "opt", "option", "⌥": modifiers |= UInt32(optionKey)
            case "shift", "⇧": modifiers |= UInt32(shiftKey)
            default:
                guard keyCode == nil, let code = keys[part] else {
                    throw CLIError("Invalid hotkey \"\(text)\": unknown or repeated key \"\(part)\"")
                }
                keyCode = code
            }
        }
        guard let keyCode else { throw CLIError("Invalid hotkey \"\(text)\": no key (modifier-only hotkeys aren't supported)") }
        return HotkeySpec(keyCode: UInt32(keyCode), modifiers: modifiers, description: text)
    }
}

/// Global hotkeys via Carbon's RegisterEventHotKey: works from a background
/// agent and needs no Accessibility permission. Delivers press and release so
/// push-to-talk works.
final class HotkeyManager {
    typealias Handler = (_ pressed: Bool) -> Void

    private var refs: [EventHotKeyRef] = []
    private var handlers: [UInt32: Handler] = [:]
    private var handlerRef: EventHandlerRef?
    private var nextID: UInt32 = 1

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
            manager.handlers[hotKeyID.id]?(pressed)
            return noErr
        }, types.count, &types, selfPtr, &handlerRef)
    }

    func register(_ spec: HotkeySpec, handler: @escaping Handler) throws {
        let id = nextID
        nextID += 1
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(spec.keyCode, spec.modifiers, EventHotKeyID(signature: OSType(0x4252_5452), id: id),
                                         GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let ref else {
            throw CLIError("Couldn't register hotkey \(spec) (status \(status)); another app may own it")
        }
        refs.append(ref)
        handlers[id] = handler
    }

    func unregisterAll() {
        refs.forEach { UnregisterEventHotKey($0) }
        refs.removeAll()
        handlers.removeAll()
    }
}
