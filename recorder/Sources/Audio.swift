import Accelerate
import AVFoundation
import CoreAudio
import Foundation

/// Streams buffers of any format into a 16 kHz mono 16-bit WAV — the format every
/// ASR engine wants, and ~115 MB/hour instead of ~1.4 GB for raw 48k float stereo.
final class WavSink {
    let url: URL
    private var file: AVAudioFile?
    private let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    private var converter: AVAudioConverter?
    private var inFormat: AVAudioFormat?
    private let lock = NSLock()
    private(set) var framesWritten: AVAudioFramePosition = 0
    private(set) var firstWriteAt: Date?
    private(set) var peak: Float = 0
    /// In-memory copy of the converted audio, for live previews (dictation only).
    private var samples: [Float]?

    init(url: URL, keepSamples: Bool = false) throws {
        self.url = url
        if keepSamples { samples = [] }
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    }

    var seconds: Double { Double(framesWritten) / 16000 }

    func write(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard let file, buffer.frameLength > 0 else { return }
        if converter == nil || inFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: outFormat)
            converter?.downmix = true
            inFormat = buffer.format
        }
        guard let converter else { return }
        let ratio = outFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if fed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        if status == .error {
            log("audio convert failed: \(error?.localizedDescription ?? "unknown")")
            return
        }
        guard out.frameLength > 0 else { return }
        if firstWriteAt == nil { firstWriteAt = Date() }
        if let data = out.floatChannelData?[0] {
            let chunk = UnsafeBufferPointer(start: data, count: Int(out.frameLength))
            peak = max(peak, vDSP.maximumMagnitude(chunk))
            samples?.append(contentsOf: chunk)
        }
        do {
            try file.write(from: out)
            framesWritten += AVAudioFramePosition(out.frameLength)
        } catch {
            log("wav write failed: \(error.localizedDescription)")
        }
    }

    /// Writes the last `seconds` of audio to a standalone WAV (the main file's
    /// header isn't final until close()).
    func writeTail(seconds: Double, to url: URL) -> Bool {
        lock.lock()
        let tail = samples.map { Array($0.suffix(Int(seconds * 16000))) } ?? []
        lock.unlock()
        guard !tail.isEmpty,
              let buffer = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: AVAudioFrameCount(tail.count)) else { return false }
        buffer.frameLength = AVAudioFrameCount(tail.count)
        tail.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: tail.count) }
        do {
            let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
                                           AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
            let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
            try file.write(from: buffer)
            return true
        } catch {
            log("preview write failed: \(error.localizedDescription)")
            return false
        }
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        // Dropping the last reference finalizes the WAV header on older macOS.
        if #available(macOS 15.0, *) { file?.close() }
        file = nil
    }
}

/// Picks the microphone from the `[audio] input_device` setting.
enum InputDevices {
    struct Device {
        let id: AudioDeviceID
        let name: String
        let transport: UInt32
        var isBluetooth: Bool { transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE }
    }

    static func all() -> [Device] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids.compactMap { id in
            var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput,
                                                     mElement: kAudioObjectPropertyElementMain)
            var streamSize: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &streamSize) == noErr, streamSize > 0 else { return nil }
            return Device(id: id, name: stringProperty(id, kAudioObjectPropertyName) ?? "?", transport: uint32Property(id, kAudioDevicePropertyTransportType))
        }
    }

    static func defaultInputID() -> AudioDeviceID? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var id = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr,
              id != kAudioObjectUnknown else { return nil }
        return id
    }

    static func defaultInput() -> Device? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var id = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr else { return nil }
        return all().first { $0.id == id }
    }

    /// nil means "use the system default". "auto" avoids Bluetooth mics: opening
    /// one flips AirPods & co. into headset mode, which takes seconds and
    /// degrades playback while recording.
    private static var cache: (key: String, device: Device?)?
    private static let cacheLock = NSLock()

    /// Cached per (setting, current default input): enumerating devices can poke
    /// Continuity mics like "iPhone Microphone", which isn't free.
    static func resolve(_ spec: String) -> Device? {
        let key = "\(spec)|\(defaultInputID() ?? 0)"
        cacheLock.lock()
        defer { cacheLock.unlock() }
        if let cache, cache.key == key { return cache.device }
        let device = resolveUncached(spec)
        cache = (key, device)
        return device
    }

    private static func resolveUncached(_ spec: String) -> Device? {
        let wanted = spec.trimmingCharacters(in: .whitespaces).lowercased()
        switch wanted {
        case "", "default", "system":
            return nil
        case "auto":
            guard let current = defaultInputID() else { return nil }
            let transport = uint32Property(current, kAudioDevicePropertyTransportType)
            guard transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE else { return nil }
            return all().first { $0.transport == kAudioDeviceTransportTypeBuiltIn }
        default:
            if let match = all().first(where: { $0.name.lowercased().contains(wanted) }) { return match }
            log("input_device \"\(spec)\" not found; using the system default. Available: \(all().map(\.name).joined(separator: ", "))")
            return nil
        }
    }

    private static func uint32Property(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32 {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value)
        return value
    }

    private static func stringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: CFString = "" as CFString
        var size = UInt32(MemoryLayout<CFString>.size)
        let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(id, &address, 0, nil, &size, $0) }
        return status == noErr ? value as String : nil
    }
}

/// Microphone via a bare AUHAL input unit. AVAudioEngine took ~2s to start;
/// this is the same HAL path without the engine graph on top.
final class MicRecorder {
    private var unit: AudioUnit?
    private var format: AVAudioFormat?
    private weak var sink: WavSink?
    private let queue = DispatchQueue(label: "app.butter.rec.mic", qos: .userInitiated)
    private(set) var running = false
    private(set) var firstBufferAt: Date?
    /// RMS of the latest buffer, for the HUD meter.
    private(set) var level: Float = 0

    func start(into sink: WavSink, device: InputDevices.Device? = nil) throws {
        guard let deviceID = device?.id ?? InputDevices.defaultInputID() else {
            throw CLIError("No microphone input available")
        }
        self.sink = sink
        var description = AudioComponentDescription(componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_HALOutput,
                                                    componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
        guard let component = AudioComponentFindNext(nil, &description) else { throw CLIError("No HAL audio unit") }
        var newUnit: AudioUnit?
        try check(AudioComponentInstanceNew(component, &newUnit), "create input unit")
        guard let unit = newUnit else { throw CLIError("No HAL audio unit") }
        self.unit = unit

        var on: UInt32 = 1, off: UInt32 = 0
        let u32 = UInt32(MemoryLayout<UInt32>.size)
        try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &on, u32), "enable input")
        try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &off, u32), "disable output")
        var id = deviceID
        try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                       &id, UInt32(MemoryLayout<AudioDeviceID>.size)), "select input device")

        var hardware = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioUnitGetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 1, &hardware, &size), "read mic format")
        guard hardware.mSampleRate > 0, hardware.mChannelsPerFrame > 0,
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: hardware.mSampleRate,
                                         channels: hardware.mChannelsPerFrame, interleaved: false) else {
            throw CLIError("Microphone reported no usable format (is microphone access granted?)")
        }
        self.format = format
        var client = format.streamDescription.pointee
        try check(AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &client, size), "set client format")

        var callback = AURenderCallbackStruct(inputProc: { refCon, flags, timeStamp, bus, frames, _ in
            Unmanaged<MicRecorder>.fromOpaque(refCon).takeUnretainedValue().render(flags, timeStamp, bus, frames)
        }, inputProcRefCon: Unmanaged.passUnretained(self).toOpaque())
        try check(AudioUnitSetProperty(unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0,
                                       &callback, UInt32(MemoryLayout<AURenderCallbackStruct>.size)), "set input callback")
        try check(AudioUnitInitialize(unit), "initialize input")
        try check(AudioOutputUnitStart(unit), "start input")
        running = true
    }

    private func render(_ flags: UnsafeMutablePointer<AudioUnitRenderActionFlags>, _ timeStamp: UnsafePointer<AudioTimeStamp>,
                        _ bus: UInt32, _ frames: UInt32) -> OSStatus {
        guard let unit, let format, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return noErr }
        buffer.frameLength = frames
        let status = AudioUnitRender(unit, flags, timeStamp, bus, frames, buffer.mutableAudioBufferList)
        guard status == noErr else { return status }
        if firstBufferAt == nil { firstBufferAt = Date() }
        if let data = buffer.floatChannelData?[0] {
            level = vDSP.rootMeanSquare(UnsafeBufferPointer(start: data, count: Int(frames)))
        }
        // Conversion and disk writes happen off the realtime thread.
        queue.async { [weak self] in self?.sink?.write(buffer) }
        return noErr
    }

    func stop() {
        guard let unit else { return }
        AudioOutputUnitStop(unit)
        AudioUnitUninitialize(unit)
        AudioComponentInstanceDispose(unit)
        self.unit = nil
        running = false
        queue.sync {}  // flush pending writes before the caller closes the sink
    }

    private func check(_ status: OSStatus, _ what: String) throws {
        guard status == noErr else {
            stop()
            throw CLIError("Couldn't \(what) (status \(status))")
        }
    }
}

/// Everything the Mac is playing (the other side of a call), via a Core Audio
/// process tap (macOS 14.2+). Needs only the "System Audio Recording" permission,
/// not Screen Recording — the same approach Granola-style recorders use.
final class SystemAudioRecorder {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "app.butter.rec.system-audio", qos: .userInitiated)

    func start(into sink: WavSink) throws {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.uuid = UUID()
        description.name = "Butter Rec"
        description.isPrivate = true
        description.muteBehavior = .unmuted

        var status = AudioHardwareCreateProcessTap(description, &tapID)
        guard status == noErr else { throw CLIError("Couldn't create system audio tap (status \(status))") }

        var formatAddress = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat,
                                                       mScope: kAudioObjectPropertyScopeGlobal,
                                                       mElement: kAudioObjectPropertyElementMain)
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        status = AudioObjectGetPropertyData(tapID, &formatAddress, 0, nil, &size, &asbd)
        guard status == noErr, let format = AVAudioFormat(streamDescription: &asbd) else {
            stop()
            throw CLIError("Couldn't read system audio tap format (status \(status))")
        }

        let outputUID = try Self.defaultOutputDeviceUID()
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Butter Rec Tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: description.uuid.uuidString,
            ]],
        ]
        status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
        guard status == noErr else {
            stop()
            throw CLIError("Couldn't create aggregate device for system audio (status \(status))")
        }

        status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { _, inputData, _, _, _ in
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: inputData, deallocator: nil) else { return }
            sink.write(buffer)
        }
        guard status == noErr else {
            stop()
            throw CLIError("Couldn't attach to system audio (status \(status))")
        }
        status = AudioDeviceStart(aggregateID, procID)
        guard status == noErr else {
            stop()
            throw CLIError("Couldn't start system audio capture (status \(status))")
        }
    }

    func stop() {
        if aggregateID != kAudioObjectUnknown {
            if let procID {
                AudioDeviceStop(aggregateID, procID)
                AudioDeviceDestroyIOProcID(aggregateID, procID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        procID = nil
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }

    private static func defaultOutputDeviceUID() throws -> String {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
                                                 mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        var deviceID = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID)
        guard status == noErr else { throw CLIError("Couldn't find the default output device (status \(status))") }

        address.mSelector = kAudioDevicePropertyDeviceUID
        var uid: CFString = "" as CFString
        size = UInt32(MemoryLayout<CFString>.size)
        status = withUnsafeMutablePointer(to: &uid) { AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, $0) }
        guard status == noErr else { throw CLIError("Couldn't read the output device UID (status \(status))") }
        return uid as String
    }
}
