//! Private local IPC for `butter-cli session create`.
//! Requests are scoped to this app run; success means a real PTY was created.
use crate::{paths, pty::PtyManager};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;

#[derive(Deserialize)]
struct Request {
    run_id: String,
    id: String,
    created_at: u64,
    directory: String,
    agent: String,
    prompt: Option<String>,
    title: Option<String>,
}

#[derive(Serialize)]
pub struct PreparedSession {
    pub id: String,
    pub directory: String,
    pub command: String,
    pub title: String,
}

pub struct SessionCli {
    directory: PathBuf,
    run_id: String,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn private_write(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    file.write_all(data).map_err(|e| e.to_string())?;
    fs::rename(tmp, path).map_err(|e| e.to_string())
}

fn agent_command(agent: &str, prompt: Option<&str>) -> Result<String, String> {
    if !matches!(agent, "claude" | "codex") {
        return Err("agent must be claude or codex".into());
    }
    match prompt {
        None => Ok(agent.into()),
        Some(prompt)
            if prompt.trim().is_empty() || prompt.len() > 32768 || prompt.contains('\0') =>
        {
            Err("prompt must contain 1–32768 bytes and no NUL".into())
        }
        // POSIX single quoting keeps dollar signs, backticks, newlines, and
        // quotes as prompt data. `--` prevents a prompt becoming CLI flags.
        Some(prompt) => Ok(format!("{agent} -- '{}'", prompt.replace('\'', "'\\''"))),
    }
}

impl SessionCli {
    pub fn install() -> Result<Self, String> {
        use std::os::unix::fs::PermissionsExt;
        let home = paths::butter_home()?;
        let directory = home.join("session-requests");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        let run_id = uuid::Uuid::new_v4().to_string();
        let runtime = serde_json::json!({"run_id": run_id, "pid": std::process::id()});
        private_write(
            &directory.join("runtime.json"),
            runtime.to_string().as_bytes(),
        )?;
        let bin = home.join("bin");
        fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
        let cli = bin.join("butter-session-cli");
        private_write(&cli, include_bytes!("../scripts/session-cli.py"))?;
        fs::set_permissions(cli, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        Ok(Self { directory, run_id })
    }

    fn finish(&self, id: &str, result: serde_json::Value) -> Result<(), String> {
        private_write(
            &self.directory.join(format!("{id}.response.json")),
            result.to_string().as_bytes(),
        )?;
        fs::remove_file(self.directory.join(format!("{id}.request.json")))
            .map_err(|e| e.to_string())
    }

    fn prepare(&self, request: &Request) -> Result<PreparedSession, String> {
        if request.run_id != self.run_id || now().abs_diff(request.created_at) > 60 {
            return Err("request expired or belongs to a previous Butter run".into());
        }
        let directory = PathBuf::from(&request.directory);
        if !directory.is_absolute() || !directory.is_dir() {
            return Err("directory must be an existing absolute directory".into());
        }
        let command = agent_command(&request.agent, request.prompt.as_deref())?;
        let title = request.title.clone().unwrap_or_else(|| {
            format!(
                "{} · {}",
                request.agent,
                directory.file_name().unwrap_or_default().to_string_lossy()
            )
        });
        if title.trim().is_empty() || title.len() > 200 {
            return Err("title must contain 1–200 bytes".into());
        }
        Ok(PreparedSession {
            id: request.id.clone(),
            directory: request.directory.clone(),
            command,
            title,
        })
    }

    fn pending(&self, ptys: &PtyManager) -> Result<Vec<PreparedSession>, String> {
        let mut result = Vec::new();
        for entry in fs::read_dir(&self.directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(id) = name.strip_suffix(".request.json") else {
                continue;
            };
            if uuid::Uuid::parse_str(id).is_err() {
                continue;
            }
            // JSON escaping can expand a valid 32 KiB prompt to nearly 192 KiB.
            if entry.metadata().map_err(|e| e.to_string())?.len() > 256 * 1024 {
                self.finish(
                    id,
                    serde_json::json!({"error": "request too large", "session_id": id}),
                )?;
                continue;
            }
            let parsed = fs::read(entry.path())
                .ok()
                .and_then(|v| serde_json::from_slice::<Request>(&v).ok());
            let request = match parsed {
                Some(r) if r.id == id => r,
                _ => {
                    self.finish(
                        id,
                        serde_json::json!({"error": "invalid request", "session_id": id}),
                    )?;
                    continue;
                }
            };
            if let Ok(Some(pid)) = ptys.get_pid(id) {
                self.finish(
                    id,
                    serde_json::json!({"status": "started", "session_id": id, "pid": pid}),
                )?;
                continue;
            }
            match self.prepare(&request) {
                Ok(prepared) => result.push(prepared),
                Err(error) => {
                    self.finish(id, serde_json::json!({"error": error, "session_id": id}))?
                }
            }
        }
        result.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(result)
    }
}

#[tauri::command]
pub fn session_cli_pending(
    manager: State<SessionCli>,
    ptys: State<PtyManager>,
) -> Result<Vec<PreparedSession>, String> {
    manager.pending(&ptys)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_is_one_literal_argument() {
        let prompt = "--dangerously-skip-permissions ' $(printf EXPANDED) `echo no`\nhello";
        let command = agent_command("claude", Some(prompt)).unwrap();
        let script = format!("claude() {{ printf '%s\\0' \"$@\"; }}; {command}");
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &script])
            .output()
            .unwrap();
        assert!(output.status.success());
        let expected = format!("--\0{prompt}\0").into_bytes();
        assert_eq!(output.stdout, expected);
    }
    #[test]
    fn reject_unknown_agent_and_invalid_prompt() {
        assert!(agent_command("sh", Some("ls")).is_err());
        assert!(agent_command("codex", Some("\0")).is_err());
        assert!(agent_command("codex", Some("  ")).is_err());
        assert_eq!(agent_command("codex", None).unwrap(), "codex");
    }

    #[test]
    fn reject_expired_requests_and_invalid_directories() {
        let manager = SessionCli {
            directory: std::env::temp_dir(),
            run_id: "this-run".into(),
        };
        let mut request = Request {
            run_id: "this-run".into(),
            id: uuid::Uuid::new_v4().to_string(),
            created_at: now(),
            directory: std::env::temp_dir().to_string_lossy().into(),
            agent: "codex".into(),
            prompt: Some("Review the project".into()),
            title: None,
        };
        assert!(manager.prepare(&request).is_ok());
        request.run_id = "previous-run".into();
        assert!(manager.prepare(&request).is_err());
        request.run_id = "this-run".into();
        request.created_at = now() - 120;
        assert!(manager.prepare(&request).is_err());
        request.created_at = now();
        request.directory = "relative/path".into();
        assert!(manager.prepare(&request).is_err());
    }
}
