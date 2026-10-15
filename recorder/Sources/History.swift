import Foundation

/// Dictations are appended to ~/.butter/dictation/history.jsonl, one JSON object per line.
enum DictationHistory {
    static var url: URL { Paths.dictationDir.appendingPathComponent("history.jsonl") }

    /// Newest first. Without a search only the file's tail is read, so this stays
    /// fast as history grows.
    static func recent(limit: Int, search: String? = nil) -> [[String: Any]] {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return [] }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let window: UInt64 = search == nil ? 512 * 1024 : size
        let offset = size > window ? size - window : 0
        try? handle.seek(toOffset: offset)
        guard let data = try? handle.readToEnd(), let text = String(data: data, encoding: .utf8) else { return [] }
        var lines = text.split(separator: "\n")
        if offset > 0, !lines.isEmpty { lines.removeFirst() }  // probably cut mid-line
        let needle = search?.lowercased()
        var out: [[String: Any]] = []
        for line in lines.reversed() {
            guard let entry = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
                  let text = entry["text"] as? String else { continue }
            if let needle, !text.lowercased().contains(needle) { continue }
            out.append(entry)
            if out.count >= limit { break }
        }
        return out
    }

    static var last: String? { recent(limit: 1).first?["text"] as? String }
}
