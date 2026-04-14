#[cfg(unix)]
use libc;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

#[derive(Clone, Serialize)]
struct PtyOutput {
    id: String,
    data: String,
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

pub struct PtyManager {
    app: AppHandle,
    sessions: Mutex<HashMap<String, PtySession>>,
}

#[cfg(unix)]
fn terminate_pid(pid: u32) -> Result<(), String> {
    unsafe {
        if libc::kill(-(pid as i32), libc::SIGTERM) == 0 {
            return Ok(());
        }
        let group_err = std::io::Error::last_os_error();
        if libc::kill(pid as i32, libc::SIGTERM) == 0 {
            return Ok(());
        }
        let pid_err = std::io::Error::last_os_error();
        Err(format!(
            "Failed to terminate PTY process {} (group: {}; pid: {})",
            pid, group_err, pid_err
        ))
    }
}

#[cfg(not(unix))]
fn terminate_pid(_pid: u32) -> Result<(), String> {
    Ok(())
}

/// Find the byte position up to which we have valid UTF-8.
/// Returns the number of bytes that form complete UTF-8 characters.
fn find_utf8_boundary(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(e) => e.valid_up_to(),
    }
}

impl PtyManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn create(
        &self,
        id: Option<String>,
        rows: u16,
        cols: u16,
        cwd: Option<String>,
        command: Option<String>,
        extra_env: Option<Vec<(String, String)>>,
    ) -> Result<String, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(shell.clone());
        cmd.env("TERM", "xterm-256color");
        if let Some(extra_env) = extra_env {
            for (key, value) in extra_env {
                cmd.env(key, value);
            }
        }
        if let Some(cwd) = cwd {
            cmd.cwd(cwd);
        }
        if let Some(command) = command {
            let wrapped = format!("{}; exec {}", command, shell);
            cmd.args(["-lc", &wrapped]);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let session_id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let app_handle = self.app.clone();
        let id_for_thread = session_id.clone();

        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);

                        let valid_up_to = find_utf8_boundary(&pending);

                        if valid_up_to > 0 {
                            let valid_bytes: Vec<u8> = pending.drain(..valid_up_to).collect();
                            let data = String::from_utf8(valid_bytes).unwrap_or_else(|e| {
                                String::from_utf8_lossy(e.as_bytes()).to_string()
                            });

                            let _ = app_handle.emit(
                                "pty-data",
                                PtyOutput {
                                    id: id_for_thread.clone(),
                                    data,
                                },
                            );
                        }
                    }
                    Err(_) => break,
                }
            }

            // Emit any remaining pending bytes on exit
            if !pending.is_empty() {
                let data = String::from_utf8_lossy(&pending).to_string();
                let _ = app_handle.emit(
                    "pty-data",
                    PtyOutput {
                        id: id_for_thread.clone(),
                        data,
                    },
                );
            }
        });

        let session = PtySession {
            master: pair.master,
            writer,
            child,
        };

        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "PTY sessions lock poisoned".to_string())?;
        sessions.insert(session_id.clone(), session);

        Ok(session_id)
    }

    pub fn write(&self, id: &str, data: String) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "PTY sessions lock poisoned".to_string())?;
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| "PTY session not found".to_string())?;
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.writer.flush().ok();
        Ok(())
    }

    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "PTY sessions lock poisoned".to_string())?;
        let session = sessions
            .get(id)
            .ok_or_else(|| "PTY session not found".to_string())?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "PTY sessions lock poisoned".to_string())?;
        if let Some(mut session) = sessions.remove(id) {
            if let Some(pid) = session.child.process_id() {
                let _ = terminate_pid(pid);
            }
            let mut exited = false;
            for attempt in 0..5 {
                if attempt > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                if let Ok(Some(_)) = session.child.try_wait() {
                    exited = true;
                    break;
                }
            }
            if !exited {
                let _ = session.child.kill();
                let _ = session.child.try_wait();
            }
        }
        Ok(())
    }

    pub fn get_pid(&self, id: &str) -> Result<Option<u32>, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "PTY sessions lock poisoned".to_string())?;
        let session = sessions
            .get(id)
            .ok_or_else(|| "PTY session not found".to_string())?;
        Ok(session.child.process_id())
    }
}
