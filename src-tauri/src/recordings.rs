//! Read-only view of butter-rec's meetings and dictations for the command
//! palette. butter-rec writes these straight to disk; Butter only reads them.
//! They aren't flavored: butter-rec always uses `~/.butter` and
//! `~/.config/butter`, so Butter Dev sees the same recordings as Butter.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Statuses that mean butter-rec is still working on the meeting.
const IN_PROGRESS: &[&str] = &["recording", "recorded", "queued", "transcribing", "summarizing"];

/// Bytes read per step when walking history.jsonl backwards.
const TAIL_CHUNK: usize = 64 * 1024;

#[derive(Deserialize, Default)]
struct RecorderConfig {
    #[serde(default)]
    meeting: MeetingConfig,
}

#[derive(Deserialize, Default)]
struct MeetingConfig {
    directory: Option<String>,
}

#[derive(Deserialize)]
struct MeetingFile {
    id: Option<String>,
    title: Option<String>,
    started_at: Option<String>,
    ended_at: Option<String>,
    duration: Option<f64>,
    status: Option<String>,
    error: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct MeetingSummary {
    pub id: String,
    pub title: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub duration: Option<f64>,
    pub status: String,
    pub error: Option<String>,
    pub in_progress: bool,
    pub has_transcript: bool,
    pub has_summary: bool,
    pub dir: String,
    pub transcript_path: String,
    pub summary_path: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Dictation {
    pub at: String,
    pub text: String,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub seconds: Option<f64>,
    #[serde(default)]
    pub elapsed: Option<f64>,
}

#[derive(Serialize, Debug)]
pub struct MeetingText {
    pub id: String,
    pub transcript: Option<String>,
    pub summary: Option<String>,
    pub transcript_path: String,
    pub summary_path: Option<String>,
}

fn expand_home(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        home.to_path_buf()
    } else if let Some(rest) = path.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(path)
    }
}

/// `[meeting] directory` from recorder.toml, or `~/.butter/recordings` when
/// the file, the key or the value is missing or unreadable.
fn meetings_dir_from(config_path: &Path, home: &Path) -> PathBuf {
    let configured = fs::read_to_string(config_path)
        .ok()
        .and_then(|raw| toml::from_str::<RecorderConfig>(&raw).ok())
        .and_then(|config| config.meeting.directory)
        .filter(|dir| !dir.trim().is_empty());
    match configured {
        Some(dir) => expand_home(dir.trim(), home),
        None => home.join(".butter").join("recordings"),
    }
}

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Could not find the home directory".to_string())
}

fn meetings_dir() -> Result<PathBuf, String> {
    let home = home()?;
    let config = home.join(".config").join("butter").join("recorder.toml");
    Ok(meetings_dir_from(&config, &home))
}

fn dictation_history() -> Result<PathBuf, String> {
    Ok(home()?.join(".butter").join("dictation").join("history.jsonl"))
}

fn read_meeting(dir: &Path) -> Option<MeetingSummary> {
    let folder = dir.file_name()?.to_string_lossy().to_string();
    let raw = fs::read_to_string(dir.join("meeting.json")).ok()?;
    let file: MeetingFile = serde_json::from_str(&raw).ok()?;
    let status = file.status.unwrap_or_else(|| "recorded".to_string());
    let transcript = dir.join("transcript.md");
    let summary = dir.join("summary.md");
    let has_summary = summary.is_file();
    Some(MeetingSummary {
        title: file
            .title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| folder.clone()),
        // The folder name is the id butter-rec resolves; meeting.json's is
        // only a fallback for display.
        id: if folder.is_empty() { file.id.unwrap_or_default() } else { folder },
        started_at: file.started_at,
        ended_at: file.ended_at,
        duration: file.duration,
        in_progress: IN_PROGRESS.contains(&status.as_str()),
        status,
        error: file.error,
        has_transcript: transcript.is_file(),
        has_summary,
        dir: dir.to_string_lossy().to_string(),
        transcript_path: transcript.to_string_lossy().to_string(),
        summary_path: has_summary.then(|| summary.to_string_lossy().to_string()),
    })
}

/// Meetings in `root`, newest first. Folders without a readable meeting.json
/// (e.g. one butter-rec is still creating) are skipped.
fn list_meetings_in(root: &Path, limit: usize) -> Vec<MeetingSummary> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut meetings: Vec<MeetingSummary> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|entry| read_meeting(&entry.path()))
        .collect();
    // ISO-8601 UTC timestamps and the date-prefixed ids both sort as strings.
    meetings.sort_by(|a, b| {
        b.started_at
            .cmp(&a.started_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    meetings.truncate(limit);
    meetings
}

/// Lines of `path`, last first, read backwards a chunk at a time so a long
/// history doesn't have to be loaded to show its tail. Stops when `visit`
/// returns false.
fn for_each_line_reversed(path: &Path, mut visit: impl FnMut(&str) -> bool) -> Result<(), String> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(format!("Failed to open {}: {err}", path.display())),
    };
    let mut pos = file
        .metadata()
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?
        .len();
    // Bytes after the last newline seen so far: the start of a line whose
    // beginning is in an earlier chunk.
    let mut carry: Vec<u8> = Vec::new();
    while pos > 0 {
        let step = (TAIL_CHUNK as u64).min(pos);
        pos -= step;
        let mut chunk = vec![0u8; step as usize];
        file.seek(SeekFrom::Start(pos))
            .and_then(|_| file.read_exact(&mut chunk))
            .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
        chunk.extend_from_slice(&carry);
        let mut end = chunk.len();
        while let Some(newline) = chunk[..end].iter().rposition(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(&chunk[newline + 1..end]);
            if !line.trim().is_empty() && !visit(&line) {
                return Ok(());
            }
            end = newline;
        }
        carry = chunk[..end].to_vec();
    }
    let line = String::from_utf8_lossy(&carry);
    if !line.trim().is_empty() {
        visit(&line);
    }
    Ok(())
}

/// Dictations, newest first. Lines that don't parse are skipped. `search`
/// matches the text case-insensitively.
fn list_dictations_in(path: &Path, limit: usize, search: Option<&str>) -> Result<Vec<Dictation>, String> {
    let needle = search
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let mut found = Vec::new();
    if limit == 0 {
        return Ok(found);
    }
    for_each_line_reversed(path, |line| {
        if let Ok(dictation) = serde_json::from_str::<Dictation>(line) {
            let matches = needle
                .as_deref()
                .is_none_or(|needle| dictation.text.to_lowercase().contains(needle));
            if matches && !dictation.text.trim().is_empty() {
                found.push(dictation);
            }
        }
        found.len() < limit
    })?;
    Ok(found)
}

/// The meeting folder for `id`, which must be a plain folder name directly
/// inside `root`.
fn meeting_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    let plain = !id.is_empty()
        && !id.starts_with('.')
        && !id.contains(['/', '\\', '\0'])
        && Path::new(id).components().count() == 1;
    if !plain {
        return Err(format!("Invalid meeting id: {id:?}"));
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("Recordings folder {} is unreadable: {e}", root.display()))?;
    let dir = root
        .join(id)
        .canonicalize()
        .map_err(|_| format!("No meeting {id:?}"))?;
    if dir.parent() != Some(root.as_path()) || !dir.is_dir() {
        return Err(format!("No meeting {id:?}"));
    }
    Ok(dir)
}

fn read_meeting_text_in(root: &Path, id: &str) -> Result<MeetingText, String> {
    let dir = meeting_dir(root, id)?;
    let transcript_path = dir.join("transcript.md");
    let summary_path = dir.join("summary.md");
    let summary = fs::read_to_string(&summary_path).ok();
    Ok(MeetingText {
        id: id.to_string(),
        transcript: fs::read_to_string(&transcript_path).ok(),
        summary_path: summary.is_some().then(|| summary_path.to_string_lossy().to_string()),
        summary,
        transcript_path: transcript_path.to_string_lossy().to_string(),
    })
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("recordings task failed: {e}"))?
}

#[tauri::command]
pub async fn recordings_list_meetings(limit: Option<usize>) -> Result<Vec<MeetingSummary>, String> {
    let limit = limit.unwrap_or(50);
    blocking(move || Ok(list_meetings_in(&meetings_dir()?, limit))).await
}

#[tauri::command]
pub async fn recordings_list_dictations(
    limit: Option<usize>,
    search: Option<String>,
) -> Result<Vec<Dictation>, String> {
    let limit = limit.unwrap_or(50);
    blocking(move || list_dictations_in(&dictation_history()?, limit, search.as_deref())).await
}

#[tauri::command]
pub async fn recordings_read_meeting(id: String) -> Result<MeetingText, String> {
    blocking(move || read_meeting_text_in(&meetings_dir()?, &id)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("butter-recordings-test-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_meeting(root: &Path, id: &str, started_at: &str, status: &str, transcript: bool) {
        let dir = root.join(id);
        fs::create_dir_all(&dir).unwrap();
        let json = serde_json::json!({
            "id": id,
            "title": format!("Title {id}"),
            "started_at": started_at,
            "ended_at": null,
            "duration": 1830.5,
            "status": status,
            "warnings": [],
        });
        fs::write(dir.join("meeting.json"), json.to_string()).unwrap();
        if transcript {
            fs::write(dir.join("transcript.md"), format!("# {id}\n")).unwrap();
        }
    }

    #[test]
    fn meetings_dir_reads_config_and_falls_back() {
        let root = temp_dir("config");
        let home = root.join("home");
        let config = root.join("recorder.toml");
        let default = home.join(".butter").join("recordings");

        assert_eq!(meetings_dir_from(&config, &home), default);
        fs::write(&config, "[asr]\nengine = \"parakeet\"\n").unwrap();
        assert_eq!(meetings_dir_from(&config, &home), default);
        fs::write(&config, "not = [valid").unwrap();
        assert_eq!(meetings_dir_from(&config, &home), default);
        fs::write(&config, "[meeting]\ndirectory = \"~/Meetings\"\n").unwrap();
        assert_eq!(meetings_dir_from(&config, &home), home.join("Meetings"));
        fs::write(&config, "[meeting]\ndirectory = \"/srv/rec\"\n").unwrap();
        assert_eq!(meetings_dir_from(&config, &home), PathBuf::from("/srv/rec"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lists_meetings_newest_first_and_skips_partial_folders() {
        let root = temp_dir("meetings");
        write_meeting(&root, "2026-10-14_0900_standup", "2026-10-14T09:00:00.120Z", "done", true);
        write_meeting(&root, "2026-10-15_1510_acme-sync", "2026-10-15T15:10:00.5Z", "transcribing", false);
        write_meeting(&root, "2026-10-13_1100_retro", "2026-10-13T11:00:00Z", "done", true);
        fs::write(root.join("2026-10-14_0900_standup").join("summary.md"), "notes").unwrap();
        fs::create_dir_all(root.join("2026-10-15_1600_starting")).unwrap();
        fs::write(root.join("stray.txt"), "x").unwrap();

        let meetings = list_meetings_in(&root, 10);
        let ids: Vec<&str> = meetings.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            ["2026-10-15_1510_acme-sync", "2026-10-14_0900_standup", "2026-10-13_1100_retro"]
        );
        assert!(meetings[0].in_progress);
        assert!(!meetings[0].has_transcript);
        assert!(!meetings[1].in_progress);
        assert!(meetings[1].has_summary);
        assert!(meetings[1].summary_path.as_deref().unwrap().ends_with("summary.md"));
        assert_eq!(meetings[1].title, "Title 2026-10-14_0900_standup");
        assert_eq!(list_meetings_in(&root, 1).len(), 1);
        assert!(list_meetings_in(&root.join("missing"), 5).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn dictations_tail_newest_first_with_search_and_bad_lines() {
        let root = temp_dir("dictation");
        let path = root.join("history.jsonl");
        let mut body = String::new();
        // Enough lines to span several backwards chunks.
        for i in 0..3000 {
            let text = if i % 1000 == 0 { format!("Pricing note {i}") } else { format!("line {i} {}", "x".repeat(40)) };
            body.push_str(&serde_json::json!({"at": format!("2026-10-15T10:00:{:02}Z", i % 60), "text": text, "engine": "parakeet", "model": "", "seconds": 1.5, "elapsed": 0.2}).to_string());
            body.push('\n');
            if i == 2998 {
                body.push_str("{not json\n\n");
            }
        }
        // A final line without a trailing newline still counts.
        body.push_str(r#"{"at":"2026-10-15T11:00:00Z","text":"last one"}"#);
        fs::write(&path, body).unwrap();

        let recent = list_dictations_in(&path, 3, None).unwrap();
        let texts: Vec<&str> = recent.iter().map(|d| d.text.as_str()).collect();
        assert_eq!(texts[0], "last one");
        assert!(texts[1].starts_with("line 2999 "));
        assert!(texts[2].starts_with("line 2998 "));

        let found = list_dictations_in(&path, 10, Some("  PRICING ")).unwrap();
        let texts: Vec<&str> = found.iter().map(|d| d.text.as_str()).collect();
        assert_eq!(texts, ["Pricing note 2000", "Pricing note 1000", "Pricing note 0"]);

        assert!(list_dictations_in(&root.join("missing.jsonl"), 5, None).unwrap().is_empty());
        assert!(list_dictations_in(&path, 0, None).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_meeting_text_and_rejects_paths_outside_the_folder() {
        let root = temp_dir("read");
        let recordings = root.join("recordings");
        write_meeting(&recordings, "2026-10-15_1510_acme-sync", "2026-10-15T15:10:00Z", "done", true);
        fs::write(root.join("secret.md"), "nope").unwrap();
        std::os::unix::fs::symlink(&root, recordings.join("escape")).unwrap();

        let text = read_meeting_text_in(&recordings, "2026-10-15_1510_acme-sync").unwrap();
        assert_eq!(text.transcript.as_deref(), Some("# 2026-10-15_1510_acme-sync\n"));
        assert!(text.summary.is_none());
        assert!(text.summary_path.is_none());

        for bad in ["", ".", "..", "../secret.md", "a/b", "/etc", ".hidden", "escape", "missing"] {
            assert!(read_meeting_text_in(&recordings, bad).is_err(), "accepted {bad:?}");
        }
        fs::remove_dir_all(root).unwrap();
    }
}
