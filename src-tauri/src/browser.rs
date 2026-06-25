use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Rect, Runtime, Size, Url,
    Webview, WebviewUrl,
};
use uuid::Uuid;

#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSDate, NSDictionary};
#[cfg(target_os = "macos")]
use objc2_web_kit::{WKSnapshotConfiguration, WKWebView, WKWebsiteDataStore};

const CALLBACK_TIMEOUT: Duration = Duration::from_secs(20);
const CONSOLE_BUFFER_LIMIT: usize = 400;
const NETWORK_BUFFER_LIMIT: usize = 400;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionState {
    pub session_id: String,
    pub open: bool,
    pub visible: bool,
    pub loading: bool,
    pub url: String,
    pub title: String,
    pub profile_path: Option<String>,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub bounds: Option<BrowserBounds>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserActionCallback {
    pub session_id: String,
    pub token: String,
    pub callback_id: String,
    pub ok: bool,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInteractiveElement {
    pub selector: String,
    pub tag: String,
    pub text: String,
    pub aria_label: Option<String>,
    pub placeholder: Option<String>,
    pub bounds: BrowserBounds,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDomSnapshot {
    pub url: String,
    pub title: String,
    pub html: String,
    pub text: String,
    pub interactives: Vec<BrowserInteractiveElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConsoleEntry {
    pub timestamp_ms: u64,
    pub level: String,
    pub text: String,
    pub args: Vec<String>,
    pub frame_url: Option<String>,
    pub source_url: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub stack: Option<String>,
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserConsoleEvent {
    pub session_id: String,
    pub token: String,
    pub timestamp_ms: u64,
    pub level: String,
    pub text: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub frame_url: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub column: Option<u32>,
    #[serde(default)]
    pub stack: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNetworkEntry {
    pub timestamp_ms: u64,
    pub kind: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub status_text: Option<String>,
    #[serde(default)]
    pub ok: Option<bool>,
    #[serde(default)]
    pub duration_ms: Option<f64>,
    #[serde(default)]
    pub frame_url: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserNetworkEvent {
    pub session_id: String,
    pub token: String,
    pub timestamp_ms: u64,
    pub kind: String,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub status_text: Option<String>,
    #[serde(default)]
    pub ok: Option<bool>,
    #[serde(default)]
    pub duration_ms: Option<f64>,
    #[serde(default)]
    pub frame_url: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserNetworkFilter {
    All,
    Errors,
    Fetch,
    Xhr,
}

impl BrowserNetworkFilter {
    pub fn from_query(value: Option<&str>) -> Result<Self, String> {
        match value
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref()
            .unwrap_or("all")
        {
            "" | "all" => Ok(Self::All),
            "error" | "errors" => Ok(Self::Errors),
            "fetch" => Ok(Self::Fetch),
            "xhr" => Ok(Self::Xhr),
            other => Err(format!(
                "Unsupported network filter '{other}'. Use all, errors, fetch, or xhr."
            )),
        }
    }

    fn matches(self, entry: &BrowserNetworkEntry) -> bool {
        match self {
            Self::All => true,
            Self::Errors => entry.error.is_some() || matches!(entry.ok, Some(false)),
            Self::Fetch => entry.kind.eq_ignore_ascii_case("fetch"),
            Self::Xhr => entry.kind.eq_ignore_ascii_case("xhr"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserConsoleFilter {
    All,
    Error,
    Warn,
    Info,
    Log,
    Debug,
}

impl BrowserConsoleFilter {
    pub fn from_query(value: Option<&str>) -> Result<Self, String> {
        match value
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref()
            .unwrap_or("all")
        {
            "" | "all" => Ok(Self::All),
            "error" | "errors" => Ok(Self::Error),
            "warn" | "warning" | "warnings" => Ok(Self::Warn),
            "info" => Ok(Self::Info),
            "log" => Ok(Self::Log),
            "debug" => Ok(Self::Debug),
            other => Err(format!(
                "Unsupported console filter '{other}'. Use all, errors, warn, info, log, or debug."
            )),
        }
    }

    fn matches(self, entry: &BrowserConsoleEntry) -> bool {
        match self {
            Self::All => true,
            Self::Error => entry.level.eq_ignore_ascii_case("error"),
            Self::Warn => entry.level.eq_ignore_ascii_case("warn"),
            Self::Info => entry.level.eq_ignore_ascii_case("info"),
            Self::Log => entry.level.eq_ignore_ascii_case("log"),
            Self::Debug => entry.level.eq_ignore_ascii_case("debug"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserImageFormat {
    Png,
    Jpeg,
    Tiff,
}

impl BrowserImageFormat {
    pub fn from_query(value: Option<&str>) -> Result<Self, String> {
        match value
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref()
            .unwrap_or("png")
        {
            "" | "png" => Ok(Self::Png),
            "jpg" | "jpeg" => Ok(Self::Jpeg),
            "tif" | "tiff" => Ok(Self::Tiff),
            other => Err(format!(
                "Unsupported image format '{other}'. Use png, jpeg, or tiff."
            )),
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Tiff => "image/tiff",
        }
    }

    #[cfg(target_os = "macos")]
    fn storage_type(self) -> NSBitmapImageFileType {
        match self {
            Self::Png => NSBitmapImageFileType::PNG,
            Self::Jpeg => NSBitmapImageFileType::JPEG,
            Self::Tiff => NSBitmapImageFileType::TIFF,
        }
    }
}

#[derive(Debug, Clone)]
struct BrowserSession {
    session_id: String,
    token: String,
    webview_label: Option<String>,
    profile_key: Option<String>,
    data_store_identifier: Option<[u8; 16]>,
    url: String,
    title: String,
    loading: bool,
    open: bool,
    visible: bool,
    can_go_back: bool,
    can_go_forward: bool,
    bounds: Option<BrowserBounds>,
    last_error: Option<String>,
    console_entries: VecDeque<BrowserConsoleEntry>,
    network_entries: VecDeque<BrowserNetworkEntry>,
}

impl BrowserSession {
    fn new(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            token: Uuid::new_v4().to_string(),
            webview_label: None,
            profile_key: None,
            data_store_identifier: None,
            url: "about:blank".to_string(),
            title: String::new(),
            loading: false,
            open: false,
            visible: false,
            can_go_back: false,
            can_go_forward: false,
            bounds: None,
            last_error: None,
            console_entries: VecDeque::new(),
            network_entries: VecDeque::new(),
        }
    }

    fn label(&self) -> String {
        format!("browser-{}", self.session_id)
    }

    fn state(&self) -> BrowserSessionState {
        BrowserSessionState {
            session_id: self.session_id.clone(),
            open: self.open,
            visible: self.visible,
            loading: self.loading,
            url: self.url.clone(),
            title: self.title.clone(),
            profile_path: self.profile_key.clone(),
            can_go_back: self.can_go_back,
            can_go_forward: self.can_go_forward,
            bounds: self.bounds.clone(),
            last_error: self.last_error.clone(),
        }
    }
}

pub struct BrowserManager<R: Runtime = tauri::Wry> {
    app: AppHandle<R>,
    sessions: Mutex<HashMap<String, BrowserSession>>,
    callbacks: Mutex<HashMap<String, mpsc::Sender<Result<serde_json::Value, String>>>>,
    server_port: AtomicU16,
}

impl<R: Runtime> BrowserManager<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self {
            app,
            sessions: Mutex::new(HashMap::new()),
            callbacks: Mutex::new(HashMap::new()),
            server_port: AtomicU16::new(9876),
        }
    }

    pub fn set_server_port(&self, port: u16) {
        self.server_port.store(port, Ordering::Relaxed);
    }

    pub fn server_port(&self) -> u16 {
        self.server_port.load(Ordering::Relaxed)
    }

    pub fn endpoint_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.server_port())
    }

    pub fn install_cli_shim(&self) -> Result<PathBuf, String> {
        let bin_dir = cli_bin_dir()?;
        fs::create_dir_all(&bin_dir).map_err(|e| format!("Failed to create CLI dir: {e}"))?;
        let cli_path = bin_dir.join("butter-browser");
        fs::write(&cli_path, cli_script()).map_err(|e| format!("Failed to write CLI shim: {e}"))?;
        let team_cli_path = bin_dir.join("butter-cli");
        fs::write(&team_cli_path, team_cli_script())
            .map_err(|e| format!("Failed to write butter-cli shim: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&cli_path, &team_cli_path] {
                let mut perms = fs::metadata(path)
                    .map_err(|e| format!("Failed to read CLI shim metadata: {e}"))?
                    .permissions();
                perms.set_mode(0o755);
                fs::set_permissions(path, perms)
                    .map_err(|e| format!("Failed to mark CLI shim executable: {e}"))?;
            }
        }
        Ok(bin_dir)
    }

    pub fn shell_env(&self, session_id: &str) -> Result<Vec<(String, String)>, String> {
        let token = self.ensure_token(session_id)?;
        let bin_dir = cli_bin_dir()?;
        let path_prefix = bin_dir.to_string_lossy().to_string();
        Ok(vec![
            ("BUTTER_SESSION_ID".to_string(), session_id.to_string()),
            ("BUTTER_BROWSER_ENDPOINT".to_string(), self.endpoint_url()),
            ("BUTTER_BROWSER_TOKEN".to_string(), token.clone()),
            ("BUTTER_TEAM_ENDPOINT".to_string(), self.endpoint_url()),
            ("BUTTER_TEAM_TOKEN".to_string(), token),
            ("BUTTER_BROWSER_BIN".to_string(), path_prefix.clone()),
            ("BUTTER_CLI_BIN".to_string(), path_prefix.clone()),
            (
                "PATH".to_string(),
                match std::env::var("PATH") {
                    Ok(existing) => format!("{path_prefix}:{existing}"),
                    Err(_) => path_prefix,
                },
            ),
        ])
    }

    pub fn ensure_token(&self, session_id: &str) -> Result<String, String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Browser sessions lock poisoned".to_string())?;
        let entry = sessions
            .entry(session_id.to_string())
            .or_insert_with(|| BrowserSession::new(session_id));
        Ok(entry.token.clone())
    }

    pub fn validate_token(&self, session_id: &str, token: &str) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "Browser sessions lock poisoned".to_string())?;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| "Unknown browser session".to_string())?;
        if entry.token == token {
            Ok(())
        } else {
            Err("Invalid browser token".to_string())
        }
    }

    pub fn register_session_directory(
        &self,
        session_id: &str,
        directory: Option<&str>,
    ) -> Result<(), String> {
        let profile_key = resolve_browser_profile_key(directory);
        let data_store_identifier = profile_key
            .as_deref()
            .map(stable_profile_identifier_from_key);

        let label_to_close = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Browser sessions lock poisoned".to_string())?;
            let entry = sessions
                .entry(session_id.to_string())
                .or_insert_with(|| BrowserSession::new(session_id));

            if entry.profile_key == profile_key
                && entry.data_store_identifier == data_store_identifier
            {
                None
            } else {
                entry.profile_key = profile_key;
                entry.data_store_identifier = data_store_identifier;
                entry.loading = false;
                entry.can_go_back = false;
                entry.can_go_forward = false;
                entry.console_entries.clear();
                entry.network_entries.clear();
                entry.webview_label.take()
            }
        };

        if let Some(label) = label_to_close {
            if let Some(webview) = self.app.get_webview(&label) {
                let _ = webview.close();
            }
        }

        Ok(())
    }

    pub fn open(
        &self,
        session_id: &str,
        url: Option<String>,
    ) -> Result<BrowserSessionState, String> {
        self.ensure_webview(session_id, url.as_deref())?;
        if let Some(url) = url {
            self.navigate(session_id, &url)?;
        }
        self.get_state(session_id)
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let label = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Browser sessions lock poisoned".to_string())?;
            let entry = sessions
                .entry(session_id.to_string())
                .or_insert_with(|| BrowserSession::new(session_id));
            entry.open = false;
            entry.visible = false;
            entry.loading = false;
            entry.can_go_back = false;
            entry.can_go_forward = false;
            entry.console_entries.clear();
            entry.network_entries.clear();
            entry.webview_label.take()
        };

        if let Some(label) = label {
            if let Some(webview) = self.app.get_webview(&label) {
                let _ = webview.close();
            }
        }
        self.emit_state(session_id)
    }

    pub fn navigate(&self, session_id: &str, url: &str) -> Result<BrowserSessionState, String> {
        self.ensure_webview(session_id, Some(url))?;
        let parsed = Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;
        let webview = self.require_webview(session_id)?;
        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Browser sessions lock poisoned".to_string())?;
            if let Some(entry) = sessions.get_mut(session_id) {
                entry.url = url.to_string();
                entry.loading = true;
                entry.last_error = None;
            }
        }
        webview.navigate(parsed).map_err(|e| e.to_string())?;
        self.emit_state(session_id)?;
        self.get_state(session_id)
    }

    pub fn reload(&self, session_id: &str) -> Result<BrowserSessionState, String> {
        let webview = self.require_webview(session_id)?;
        webview.reload().map_err(|e| e.to_string())?;
        self.get_state(session_id)
    }

    pub fn go_back(&self, session_id: &str) -> Result<BrowserSessionState, String> {
        let webview = self.require_webview(session_id)?;
        with_wkwebview(&webview, move |view| unsafe {
            let _ = view.goBack();
            Ok(())
        })?;
        self.refresh_navigation_flags(session_id)?;
        self.get_state(session_id)
    }

    pub fn go_forward(&self, session_id: &str) -> Result<BrowserSessionState, String> {
        let webview = self.require_webview(session_id)?;
        with_wkwebview(&webview, move |view| unsafe {
            let _ = view.goForward();
            Ok(())
        })?;
        self.refresh_navigation_flags(session_id)?;
        self.get_state(session_id)
    }

    pub fn set_bounds(
        &self,
        session_id: &str,
        bounds: BrowserBounds,
    ) -> Result<BrowserSessionState, String> {
        self.ensure_webview(session_id, None)?;
        let webview = self.require_webview(session_id)?;
        let rect = Rect {
            position: Position::Logical(LogicalPosition::new(bounds.x, bounds.y)),
            size: Size::Logical(LogicalSize::new(bounds.width, bounds.height)),
        };
        webview.set_bounds(rect).map_err(|e| e.to_string())?;
        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Browser sessions lock poisoned".to_string())?;
            if let Some(entry) = sessions.get_mut(session_id) {
                entry.bounds = Some(bounds);
            }
        }
        self.get_state(session_id)
    }

    pub fn set_visible(
        &self,
        session_id: &str,
        visible: bool,
    ) -> Result<BrowserSessionState, String> {
        self.ensure_webview(session_id, None)?;
        let webview = self.require_webview(session_id)?;
        if visible {
            webview.show().map_err(|e| e.to_string())?;
        } else {
            webview.hide().map_err(|e| e.to_string())?;
        }
        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Browser sessions lock poisoned".to_string())?;
            if let Some(entry) = sessions.get_mut(session_id) {
                entry.visible = visible;
            }
        }
        self.emit_state(session_id)?;
        self.get_state(session_id)
    }

    pub fn set_pane_open(
        &self,
        session_id: &str,
        pane_open: bool,
    ) -> Result<BrowserSessionState, String> {
        if pane_open {
            self.ensure_webview(session_id, None)?;
        }
        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Browser sessions lock poisoned".to_string())?;
            let entry = sessions
                .entry(session_id.to_string())
                .or_insert_with(|| BrowserSession::new(session_id));
            entry.open = pane_open;
            if !pane_open {
                entry.visible = false;
            }
        }
        if !pane_open {
            if let Ok(webview) = self.require_webview(session_id) {
                let _ = webview.hide();
            }
        }
        self.emit_state(session_id)?;
        self.get_state(session_id)
    }

    pub fn get_state(&self, session_id: &str) -> Result<BrowserSessionState, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "Browser sessions lock poisoned".to_string())?;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| "Unknown browser session".to_string())?;
        Ok(entry.state())
    }

    pub fn handle_page_load(
        &self,
        session_id: &str,
        url: &str,
        event: PageLoadEvent,
    ) -> Result<(), String> {
        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Browser sessions lock poisoned".to_string())?;
            if let Some(entry) = sessions.get_mut(session_id) {
                entry.url = url.to_string();
                entry.loading = matches!(event, PageLoadEvent::Started);
                entry.last_error = None;
                if matches!(event, PageLoadEvent::Started) {
                    entry.console_entries.clear();
                    entry.network_entries.clear();
                }
            }
        }
        self.refresh_navigation_flags(session_id)?;
        self.emit_state(session_id)
    }

    pub fn handle_title_changed(&self, session_id: &str, title: String) -> Result<(), String> {
        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Browser sessions lock poisoned".to_string())?;
            if let Some(entry) = sessions.get_mut(session_id) {
                entry.title = title;
            }
        }
        self.emit_state(session_id)
    }

    pub fn resolve_callback(&self, payload: BrowserActionCallback) -> Result<(), String> {
        self.validate_token(&payload.session_id, &payload.token)?;
        let sender = self
            .callbacks
            .lock()
            .map_err(|_| "Browser callbacks lock poisoned".to_string())?
            .remove(&payload.callback_id)
            .ok_or_else(|| "Unknown browser callback".to_string())?;
        let result = if payload.ok {
            Ok(payload.result.unwrap_or(serde_json::Value::Null))
        } else {
            Err(payload
                .error
                .unwrap_or_else(|| "Browser action failed".to_string()))
        };
        sender
            .send(result)
            .map_err(|_| "Failed to resolve browser callback".to_string())
    }

    pub fn record_console_event(&self, payload: BrowserConsoleEvent) -> Result<(), String> {
        self.validate_token(&payload.session_id, &payload.token)?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Browser sessions lock poisoned".to_string())?;
        let entry = sessions
            .get_mut(&payload.session_id)
            .ok_or_else(|| "Unknown browser session".to_string())?;
        if entry.console_entries.len() >= CONSOLE_BUFFER_LIMIT {
            entry.console_entries.pop_front();
        }
        entry.console_entries.push_back(BrowserConsoleEntry {
            timestamp_ms: payload.timestamp_ms,
            level: payload.level,
            text: payload.text,
            args: payload.args,
            frame_url: payload.frame_url,
            source_url: payload.source_url,
            line: payload.line,
            column: payload.column,
            stack: payload.stack,
            kind: payload.kind,
        });
        Ok(())
    }

    pub fn get_console_entries(
        &self,
        session_id: &str,
        filter: BrowserConsoleFilter,
        limit: usize,
    ) -> Result<Vec<BrowserConsoleEntry>, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "Browser sessions lock poisoned".to_string())?;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| "Unknown browser session".to_string())?;
        let limit = limit.clamp(1, CONSOLE_BUFFER_LIMIT);
        let mut entries = entry
            .console_entries
            .iter()
            .rev()
            .filter(|item| filter.matches(item))
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        entries.reverse();
        Ok(entries)
    }

    pub fn clear_console_entries(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Browser sessions lock poisoned".to_string())?;
        let entry = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Unknown browser session".to_string())?;
        entry.console_entries.clear();
        Ok(())
    }

    pub fn record_network_event(&self, payload: BrowserNetworkEvent) -> Result<(), String> {
        self.validate_token(&payload.session_id, &payload.token)?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Browser sessions lock poisoned".to_string())?;
        let entry = sessions
            .get_mut(&payload.session_id)
            .ok_or_else(|| "Unknown browser session".to_string())?;
        if entry.network_entries.len() >= NETWORK_BUFFER_LIMIT {
            entry.network_entries.pop_front();
        }
        entry.network_entries.push_back(BrowserNetworkEntry {
            timestamp_ms: payload.timestamp_ms,
            kind: payload.kind,
            method: payload.method,
            url: payload.url,
            status: payload.status,
            status_text: payload.status_text,
            ok: payload.ok,
            duration_ms: payload.duration_ms,
            frame_url: payload.frame_url,
            content_type: payload.content_type,
            error: payload.error,
        });
        Ok(())
    }

    pub fn get_network_entries(
        &self,
        session_id: &str,
        filter: BrowserNetworkFilter,
        limit: usize,
    ) -> Result<Vec<BrowserNetworkEntry>, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "Browser sessions lock poisoned".to_string())?;
        let entry = sessions
            .get(session_id)
            .ok_or_else(|| "Unknown browser session".to_string())?;
        let limit = limit.clamp(1, NETWORK_BUFFER_LIMIT);
        let mut entries = entry
            .network_entries
            .iter()
            .rev()
            .filter(|item| filter.matches(item))
            .take(limit)
            .cloned()
            .collect::<Vec<_>>();
        entries.reverse();
        Ok(entries)
    }

    pub fn clear_network_entries(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Browser sessions lock poisoned".to_string())?;
        let entry = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Unknown browser session".to_string())?;
        entry.network_entries.clear();
        Ok(())
    }

    pub fn clear_profile_state(&self, session_id: &str) -> Result<(), String> {
        let webview = self.require_webview(session_id)?;
        clear_webview_data_store(&webview)?;

        let (affected_session_ids, labels) = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Browser sessions lock poisoned".to_string())?;
            let target = sessions
                .get(session_id)
                .ok_or_else(|| "Unknown browser session".to_string())?;
            let target_profile_key = target.profile_key.clone();
            let target_data_store_identifier = target.data_store_identifier;

            let mut affected_session_ids = Vec::new();
            let mut labels = Vec::new();

            for entry in sessions.values_mut() {
                if entry.profile_key != target_profile_key
                    || entry.data_store_identifier != target_data_store_identifier
                {
                    continue;
                }

                affected_session_ids.push(entry.session_id.clone());
                if let Some(label) = entry.webview_label.take() {
                    labels.push(label);
                }
                entry.url = "about:blank".to_string();
                entry.title.clear();
                entry.loading = false;
                entry.open = false;
                entry.visible = false;
                entry.can_go_back = false;
                entry.can_go_forward = false;
                entry.last_error = None;
                entry.console_entries.clear();
                entry.network_entries.clear();
            }

            (affected_session_ids, labels)
        };

        for label in labels {
            if let Some(webview) = self.app.get_webview(&label) {
                let _ = webview.close();
            }
        }

        for affected_session_id in affected_session_ids {
            let _ = self.emit_state(&affected_session_id);
        }

        Ok(())
    }

    pub fn snapshot_dom(&self, session_id: &str) -> Result<BrowserDomSnapshot, String> {
        let raw = self.eval_with_result(
            session_id,
            r#"
const buildSelector = (el) => {
  if (!(el instanceof Element)) return "";
  if (el.id) return `#${CSS.escape(el.id)}`;
  const dataAttrs = ["data-testid", "data-test-id", "data-qa", "name", "aria-label"];
  for (const attr of dataAttrs) {
    const value = el.getAttribute(attr);
    if (value) {
      return `[${attr}="${String(value).replace(/"/g, '\\"')}"]`;
    }
  }
  const parts = [];
  let current = el;
  while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
    const tag = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index += 1;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${tag}:nth-of-type(${index})`);
    current = current.parentElement;
  }
  return parts.join(" > ");
};
const clampText = (value, max = 400) => {
  const text = (value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const interactives = Array.from(
  document.querySelectorAll('a, button, input, textarea, select, [role="button"], [tabindex]')
)
  .filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  })
  .slice(0, 200)
  .map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      text: clampText(el.innerText || el.textContent || ""),
      ariaLabel: el.getAttribute("aria-label"),
      placeholder: el.getAttribute("placeholder"),
      bounds: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
    };
  });
return {
  url: location.href,
  title: document.title || "",
  html: document.documentElement ? document.documentElement.outerHTML : "",
  text: document.body ? document.body.innerText || "" : "",
  interactives,
};
"#,
            CALLBACK_TIMEOUT,
        )?;
        serde_json::from_value(raw).map_err(|e| format!("Invalid DOM snapshot: {e}"))
    }

    pub fn snapshot_image(
        &self,
        session_id: &str,
        format: BrowserImageFormat,
    ) -> Result<Vec<u8>, String> {
        let webview = self.require_webview(session_id)?;
        capture_snapshot(&webview, format)
    }

    pub fn open_devtools(&self, session_id: &str) -> Result<(), String> {
        let webview = self.require_webview(session_id)?;
        #[cfg(debug_assertions)]
        {
            webview.open_devtools();
            return Ok(());
        }
        #[cfg(not(debug_assertions))]
        {
            let _ = webview;
            Err("Browser inspector is only available in debug builds.".to_string())
        }
    }

    pub fn close_devtools(&self, session_id: &str) -> Result<(), String> {
        let webview = self.require_webview(session_id)?;
        #[cfg(debug_assertions)]
        {
            webview.close_devtools();
            return Ok(());
        }
        #[cfg(not(debug_assertions))]
        {
            let _ = webview;
            Err("Browser inspector is only available in debug builds.".to_string())
        }
    }

    pub fn click(&self, session_id: &str, selector: &str) -> Result<serde_json::Value, String> {
        let selector = serde_json::to_string(selector).map_err(|e| e.to_string())?;
        self.eval_with_result(
            session_id,
            &format!(
                r#"
const target = document.querySelector({selector});
if (!target) throw new Error("Selector not found");
target.scrollIntoView({{ block: "center", inline: "center" }});
target.click();
return {{
  selector: {selector},
  tag: target.tagName.toLowerCase()
}};
"#
            ),
            CALLBACK_TIMEOUT,
        )
    }

    pub fn type_text(
        &self,
        session_id: &str,
        selector: &str,
        text: &str,
    ) -> Result<serde_json::Value, String> {
        let selector = serde_json::to_string(selector).map_err(|e| e.to_string())?;
        let text = serde_json::to_string(text).map_err(|e| e.to_string())?;
        self.eval_with_result(
            session_id,
            &format!(
                r#"
const target = document.querySelector({selector});
if (!target) throw new Error("Selector not found");
if (!("value" in target)) throw new Error("Target does not accept text input");
target.focus();
if (typeof target.select === "function") target.select();
target.value = {text};
target.dispatchEvent(new Event("input", {{ bubbles: true }}));
target.dispatchEvent(new Event("change", {{ bubbles: true }}));
return {{
  selector: {selector},
  value: target.value
}};
"#
            ),
            CALLBACK_TIMEOUT,
        )
    }

    pub fn press_key(&self, session_id: &str, key: &str) -> Result<serde_json::Value, String> {
        let key = serde_json::to_string(key).map_err(|e| e.to_string())?;
        self.eval_with_result(
            session_id,
            &format!(
                r#"
const target = document.activeElement || document.body;
const eventInit = {{ key: {key}, bubbles: true, cancelable: true }};
target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
target.dispatchEvent(new KeyboardEvent("keypress", eventInit));
target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
if ({key} === "Enter" && target && target.form && typeof target.form.requestSubmit === "function") {{
  target.form.requestSubmit();
}}
return {{
  key: {key},
  activeTag: target.tagName ? target.tagName.toLowerCase() : null
}};
"#
            ),
            CALLBACK_TIMEOUT,
        )
    }

    pub fn wait_for(
        &self,
        session_id: &str,
        selector: &str,
        timeout_ms: u64,
    ) -> Result<serde_json::Value, String> {
        let selector = serde_json::to_string(selector).map_err(|e| e.to_string())?;
        let timeout_ms = timeout_ms.clamp(50, 60_000);
        self.eval_with_result(
            session_id,
            &format!(
                r#"
await new Promise((resolve, reject) => {{
  const started = Date.now();
  const tick = () => {{
    const target = document.querySelector({selector});
    if (target) {{
      resolve(target);
      return;
    }}
    if (Date.now() - started >= {timeout_ms}) {{
      reject(new Error("Timed out waiting for selector"));
      return;
    }}
    window.setTimeout(tick, 120);
  }};
  tick();
}});
return {{
  selector: {selector},
  found: true
}};
"#
            ),
            Duration::from_millis(timeout_ms.saturating_add(2_000)),
        )
    }

    fn ensure_webview(&self, session_id: &str, initial_url: Option<&str>) -> Result<(), String> {
        let (needs_create, label, visible, bounds, token, session_id_owned, data_store_identifier) = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Browser sessions lock poisoned".to_string())?;
            let entry = sessions
                .entry(session_id.to_string())
                .or_insert_with(|| BrowserSession::new(session_id));
            let label = entry.label();
            if entry.webview_label.is_none() {
                entry.webview_label = Some(label.clone());
                entry.open = true;
                entry.visible = false;
                entry.last_error = None;
            } else {
                entry.open = true;
            }
            (
                self.app.get_webview(&label).is_none(),
                label,
                entry.visible,
                entry.bounds.clone(),
                entry.token.clone(),
                entry.session_id.clone(),
                entry.data_store_identifier,
            )
        };

        if !needs_create {
            return Ok(());
        }

        let window = self
            .app
            .get_window("main")
            .ok_or_else(|| "Main window not found".to_string())?;
        let url = initial_url.unwrap_or("about:blank");
        let app_handle_for_page = self.app.clone();
        let app_handle_for_title = self.app.clone();
        let app_handle_for_new_window = self.app.clone();
        let page_session_id = session_id_owned.clone();
        let title_session_id = session_id_owned.clone();
        let label_for_new_window = label.clone();
        let label_for_downloads = label.clone();
        let init_script = initialization_script(&session_id_owned, &token, &self.endpoint_url());
        let mut builder = WebviewBuilder::new(
            &label,
            WebviewUrl::External(Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?),
        )
        .devtools(true)
        .initialization_script_for_all_frames(init_script)
        .accept_first_mouse(true)
        .on_page_load(move |_webview, payload| {
            if let Some(manager) =
                app_handle_for_page.try_state::<std::sync::Arc<BrowserManager<R>>>()
            {
                let _ = manager.handle_page_load(
                    &page_session_id,
                    payload.url().as_str(),
                    payload.event(),
                );
            }
        })
        .on_document_title_changed(move |_webview, title| {
            if let Some(manager) =
                app_handle_for_title.try_state::<std::sync::Arc<BrowserManager<R>>>()
            {
                let _ = manager.handle_title_changed(&title_session_id, title);
            }
        })
        .on_navigation(|_| true)
        .on_download(move |_webview, event| {
            if let tauri::webview::DownloadEvent::Requested { url, .. } = event {
                eprintln!(
                    "[browser] download requested for {} via {}",
                    url, label_for_downloads
                );
            }
            true
        })
        .on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https" | "file") {
                if let Some(webview) = app_handle_for_new_window.get_webview(&label_for_new_window)
                {
                    let _ = webview.navigate(url.clone());
                }
            }
            tauri::webview::NewWindowResponse::Deny
        });

        if let Some(data_store_identifier) = data_store_identifier {
            builder = builder.data_store_identifier(data_store_identifier);
        }

        let size = bounds
            .clone()
            .map(|b| Size::Logical(LogicalSize::new(b.width.max(1.0), b.height.max(1.0))))
            .unwrap_or_else(|| Size::Logical(LogicalSize::new(1.0, 1.0)));
        let position = bounds
            .map(|b| Position::Logical(LogicalPosition::new(b.x, b.y)))
            .unwrap_or_else(|| Position::Logical(LogicalPosition::new(0.0, 0.0)));

        let webview = window
            .add_child(builder, position, size)
            .map_err(|e| format!("Failed to create browser webview: {e}"))?;
        if !visible {
            let _ = webview.hide();
        }
        self.refresh_navigation_flags(session_id)?;
        self.emit_state(session_id)
    }

    fn require_webview(&self, session_id: &str) -> Result<Webview<R>, String> {
        let label = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "Browser sessions lock poisoned".to_string())?;
            let entry = sessions
                .get(session_id)
                .ok_or_else(|| "Unknown browser session".to_string())?;
            entry
                .webview_label
                .clone()
                .ok_or_else(|| "Browser is not open".to_string())?
        };
        self.app
            .get_webview(&label)
            .ok_or_else(|| "Browser webview not found".to_string())
    }

    fn refresh_navigation_flags(&self, session_id: &str) -> Result<(), String> {
        let webview = match self.require_webview(session_id) {
            Ok(webview) => webview,
            Err(_) => return Ok(()),
        };
        let (can_go_back, can_go_forward, current_url) =
            with_wkwebview(&webview, move |view| unsafe {
                Ok((view.canGoBack(), view.canGoForward(), None::<String>))
            })?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Browser sessions lock poisoned".to_string())?;
        if let Some(entry) = sessions.get_mut(session_id) {
            entry.can_go_back = can_go_back;
            entry.can_go_forward = can_go_forward;
            if let Some(url) = current_url {
                entry.url = url;
            }
        }
        Ok(())
    }

    fn emit_state(&self, session_id: &str) -> Result<(), String> {
        let state = self.get_state(session_id)?;
        self.app
            .emit("browser-state", state)
            .map_err(|e| format!("Failed to emit browser state: {e}"))
    }

    fn eval_with_result(
        &self,
        session_id: &str,
        inner_script: &str,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let webview = self.require_webview(session_id)?;
        let callback_id = Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        self.callbacks
            .lock()
            .map_err(|_| "Browser callbacks lock poisoned".to_string())?
            .insert(callback_id.clone(), tx);
        let script = format_browser_eval_script(&callback_id, inner_script);
        if let Err(err) = webview.eval(script) {
            let _ = self
                .callbacks
                .lock()
                .map_err(|_| "Browser callbacks lock poisoned".to_string())?
                .remove(&callback_id);
            return Err(err.to_string());
        }
        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                let _ = self
                    .callbacks
                    .lock()
                    .map_err(|_| "Browser callbacks lock poisoned".to_string())?
                    .remove(&callback_id);
                Err("Timed out waiting for browser action callback".to_string())
            }
        }
    }
}

fn resolve_browser_profile_key(directory: Option<&str>) -> Option<String> {
    let directory = directory?.trim();
    if directory.is_empty() {
        return None;
    }

    let expanded = expand_home_path(directory);
    let canonical = canonicalize_profile_directory(&expanded);
    let resolved = resolve_git_worktree_root(&canonical).unwrap_or(canonical);
    Some(resolved.to_string_lossy().to_string())
}

fn expand_home_path(path: &str) -> PathBuf {
    if let Some(stripped) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    }
    PathBuf::from(path)
}

fn canonicalize_profile_directory(path: &Path) -> PathBuf {
    let candidate = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| path.to_path_buf())
    };
    fs::canonicalize(&candidate).unwrap_or(candidate)
}

fn resolve_git_worktree_root(path: &Path) -> Option<PathBuf> {
    let path_str = path.to_str()?;
    let output = Command::new("git")
        .args(["-C", path_str, "rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return None;
    }
    Some(canonicalize_profile_directory(Path::new(&root)))
}

fn stable_profile_identifier_from_key(key: &str) -> [u8; 16] {
    let first = fnv1a64(key.as_bytes(), 0xcbf29ce484222325);
    let second = fnv1a64(key.as_bytes(), 0x84222325cbf29ce4);
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&first.to_be_bytes());
    bytes[8..].copy_from_slice(&second.to_be_bytes());
    bytes
}

fn fnv1a64(bytes: &[u8], seed: u64) -> u64 {
    let mut hash = seed;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn cli_bin_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    Ok(home.join(".butter").join("bin"))
}

fn cli_script() -> &'static str {
    r#"#!/bin/sh
set -eu

infer_image_format() {
  output_path="${1:-}"
  case "$output_path" in
    *.jpg|*.jpeg|*.JPG|*.JPEG)
      printf '%s\n' jpeg
      ;;
    *.tif|*.tiff|*.TIF|*.TIFF)
      printf '%s\n' tiff
      ;;
    *)
      printf '%s\n' png
      ;;
  esac
}

usage() {
  code="${1:-0}"
  if [ "$code" -eq 0 ]; then
    cat <<'EOF'
Usage:
  butter-browser open [url]
  butter-browser goto <url>
  butter-browser close
  butter-browser show
  butter-browser hide
  butter-browser console [all|errors|warn|info|log|debug] [limit]
  butter-browser console-clear
  butter-browser network [all|errors|fetch|xhr] [limit]
  butter-browser network-clear
  butter-browser state
  butter-browser back
  butter-browser forward
  butter-browser reload
  butter-browser click <selector>
  butter-browser type <selector> <text>
  butter-browser press <key>
  butter-browser wait-for <selector> [timeout-ms]
  butter-browser html
  butter-browser snapshot [dom|image] [output-path]
  butter-browser help
EOF
  else
    cat >&2 <<'EOF'
Usage:
  butter-browser open [url]
  butter-browser goto <url>
  butter-browser close
  butter-browser show
  butter-browser hide
  butter-browser console [all|errors|warn|info|log|debug] [limit]
  butter-browser console-clear
  butter-browser network [all|errors|fetch|xhr] [limit]
  butter-browser network-clear
  butter-browser state
  butter-browser back
  butter-browser forward
  butter-browser reload
  butter-browser click <selector>
  butter-browser type <selector> <text>
  butter-browser press <key>
  butter-browser wait-for <selector> [timeout-ms]
  butter-browser html
  butter-browser snapshot [dom|image] [output-path]
  butter-browser help
EOF
  fi
  exit "$code"
}

need_env() {
  name="$1"
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "butter-browser: missing $name" >&2
    exit 1
  fi
}

command="${1:-}"
[ -n "$command" ] || usage 1
shift || true

case "$command" in
  help|-h|--help)
    usage 0
    ;;
esac

need_env BUTTER_SESSION_ID
need_env BUTTER_BROWSER_ENDPOINT
need_env BUTTER_BROWSER_TOKEN

sid="$BUTTER_SESSION_ID"
endpoint="$BUTTER_BROWSER_ENDPOINT"
token="$BUTTER_BROWSER_TOKEN"
current_cwd="${PWD:-}"

post_form() {
  route="$1"
  shift || true
  curl -fsS -X POST --data-urlencode "token=$token" "$@" "$endpoint/browser/$sid/$route"
}

get_query() {
  route="$1"
  shift || true
  curl -fsS -G --data-urlencode "token=$token" "$@" "$endpoint/browser/$sid/$route"
}

case "$command" in
  open)
    if [ "${1:-}" ]; then
      if [ -n "$current_cwd" ]; then
        post_form open --data-urlencode "cwd=$current_cwd" --data-urlencode "url=$1"
      else
        post_form open --data-urlencode "url=$1"
      fi
    else
      if [ -n "$current_cwd" ]; then
        post_form open --data-urlencode "cwd=$current_cwd"
      else
        post_form open
      fi
    fi
    ;;
  goto|navigate)
    [ "${1:-}" ] || usage 1
    if [ -n "$current_cwd" ]; then
      post_form navigate --data-urlencode "cwd=$current_cwd" --data-urlencode "url=$1"
    else
      post_form navigate --data-urlencode "url=$1"
    fi
    ;;
  close)
    post_form close
    ;;
  show)
    post_form show
    ;;
  hide)
    post_form hide
    ;;
  console)
    level="${1:-all}"
    limit="${2:-100}"
    get_query console --data-urlencode "level=$level" --data-urlencode "limit=$limit"
    ;;
  console-clear)
    post_form console/clear
    ;;
  network)
    kind="${1:-all}"
    limit="${2:-100}"
    get_query network --data-urlencode "kind=$kind" --data-urlencode "limit=$limit"
    ;;
  network-clear)
    post_form network/clear
    ;;
  state)
    get_query state
    ;;
  back)
    post_form back
    ;;
  forward)
    post_form forward
    ;;
  reload)
    post_form reload
    ;;
  click)
    [ "${1:-}" ] || usage 1
    post_form click --data-urlencode "selector=$1"
    ;;
  type)
    [ "${1:-}" ] || usage 1
    [ "${2:-}" ] || usage 1
    post_form type --data-urlencode "selector=$1" --data-urlencode "text=$2"
    ;;
  press)
    [ "${1:-}" ] || usage 1
    post_form press --data-urlencode "key=$1"
    ;;
  wait-for)
    [ "${1:-}" ] || usage 1
    timeout_ms="${2:-10000}"
    post_form wait-for --data-urlencode "selector=$1" --data-urlencode "timeout_ms=$timeout_ms"
    ;;
  html)
    get_query html
    ;;
  snapshot)
    mode="${1:-dom}"
    case "$mode" in
      dom)
        get_query snapshot --data-urlencode "mode=dom"
        ;;
      image)
        output="${2:-}"
        format="$(infer_image_format "$output")"
        if [ -n "$output" ]; then
          get_query snapshot --data-urlencode "mode=image" --data-urlencode "format=$format" > "$output"
        else
          get_query snapshot --data-urlencode "mode=image" --data-urlencode "format=$format"
        fi
        ;;
      *)
        usage 1
        ;;
    esac
    ;;
  *)
    usage 1
    ;;
esac
"#
}

fn team_cli_script() -> &'static str {
    r#"#!/bin/sh
set -eu

usage() {
  code="${1:-0}"
  if [ "$code" -eq 0 ]; then
    cat <<'EOF'
Usage:
  butter-cli team send --channel <name> <message>
  butter-cli team send --to <username> <message>
  butter-cli team reply <message-id> <message>
  butter-cli team inbox
  butter-cli team read --channel <name>
  butter-cli team mark-read <message-id>
  butter-cli team mark-unread <message-id>
  butter-cli team user list
  butter-cli team user set --username <name> --pwd <path> --cmd <command> [--display-name <name>] [--description <text>] [--disabled]
  butter-cli team channel list
  butter-cli team channel set --name <name> [--display-name <name>] [--description <text>]
  butter-cli help
EOF
  else
    cat >&2 <<'EOF'
Usage:
  butter-cli team send --channel <name> <message>
  butter-cli team send --to <username> <message>
  butter-cli team reply <message-id> <message>
  butter-cli team inbox
  butter-cli team read --channel <name>
  butter-cli team mark-read <message-id>
  butter-cli team mark-unread <message-id>
  butter-cli team user list
  butter-cli team user set --username <name> --pwd <path> --cmd <command> [--display-name <name>] [--description <text>] [--disabled]
  butter-cli team channel list
  butter-cli team channel set --name <name> [--display-name <name>] [--description <text>]
  butter-cli help
EOF
  fi
  exit "$code"
}

need_env() {
  name="$1"
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "butter-cli: missing $name" >&2
    exit 1
  fi
}

join_args() {
  out=""
  for item in "$@"; do
    if [ -z "$out" ]; then
      out="$item"
    else
      out="$out $item"
    fi
  done
  printf '%s\n' "$out"
}

root="${1:-}"
[ -n "$root" ] || usage 1
shift || true

case "$root" in
  help|-h|--help)
    usage 0
    ;;
  team)
    ;;
  *)
    usage 1
    ;;
esac

need_env BUTTER_SESSION_ID
need_env BUTTER_TEAM_ENDPOINT
need_env BUTTER_TEAM_TOKEN

sid="$BUTTER_SESSION_ID"
endpoint="$BUTTER_TEAM_ENDPOINT"
token="$BUTTER_TEAM_TOKEN"
actor="${BUTTER_TEAM_USER_ID:-}"

post_form() {
  route="$1"
  shift || true
  curl -fsS -X POST --data-urlencode "token=$token" --data-urlencode "actor_user_id=$actor" "$@" "$endpoint/team/$sid/$route"
}

get_query() {
  route="$1"
  shift || true
  curl -fsS -G --data-urlencode "token=$token" "$@" "$endpoint/team/$sid/$route"
}

value_arg() {
  opt="$1"
  value="${2:-}"
  if [ -z "$value" ]; then
    echo "butter-cli: missing value for $opt" >&2
    exit 1
  fi
  printf '%s\n' "$value"
}

command="${1:-}"
[ -n "$command" ] || usage 1
shift || true

case "$command" in
  send)
    target_kind="${1:-}"
    target_value="${2:-}"
    [ -n "$target_kind" ] || usage 1
    [ -n "$target_value" ] || usage 1
    shift 2 || true
    content="$(join_args "$@")"
    [ -n "$content" ] || usage 1
    case "$target_kind" in
      --channel)
        post_form send --data-urlencode "channel=$target_value" --data-urlencode "content=$content"
        ;;
      --to)
        post_form send --data-urlencode "to=$target_value" --data-urlencode "content=$content"
        ;;
      *)
        usage 1
        ;;
    esac
    ;;
  reply)
    parent_id="${1:-}"
    [ -n "$parent_id" ] || usage 1
    shift || true
    content="$(join_args "$@")"
    [ -n "$content" ] || usage 1
    post_form reply --data-urlencode "parent_message_id=$parent_id" --data-urlencode "content=$content"
    ;;
  inbox)
    get_query inbox
    ;;
  read)
    target_kind="${1:-}"
    target_value="${2:-}"
    [ "$target_kind" = "--channel" ] || usage 1
    [ -n "$target_value" ] || usage 1
    post_form read --data-urlencode "channel=$target_value"
    ;;
  mark-read)
    message_id="${1:-}"
    [ -n "$message_id" ] || usage 1
    post_form mark-read --data-urlencode "message_id=$message_id"
    ;;
  mark-unread)
    message_id="${1:-}"
    [ -n "$message_id" ] || usage 1
    post_form mark-unread --data-urlencode "message_id=$message_id"
    ;;
  user)
    subcommand="${1:-}"
    [ -n "$subcommand" ] || usage 1
    shift || true
    case "$subcommand" in
      list)
        get_query users
        ;;
      set)
        username=""
        display_name=""
        pwd=""
        cmd=""
        description=""
        enabled="true"
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --username)
              username="$(value_arg "$1" "${2:-}")"
              shift 2
              ;;
            --display-name)
              display_name="$(value_arg "$1" "${2:-}")"
              shift 2
              ;;
            --pwd)
              pwd="$(value_arg "$1" "${2:-}")"
              shift 2
              ;;
            --cmd)
              cmd="$(value_arg "$1" "${2:-}")"
              shift 2
              ;;
            --description)
              description="$(value_arg "$1" "${2:-}")"
              shift 2
              ;;
            --disabled)
              enabled="false"
              shift
              ;;
            --enabled)
              enabled="true"
              shift
              ;;
            *)
              usage 1
              ;;
          esac
        done
        [ -n "$username" ] || usage 1
        [ -n "$pwd" ] || usage 1
        [ -n "$cmd" ] || usage 1
        post_form users/set \
          --data-urlencode "username=$username" \
          --data-urlencode "pwd=$pwd" \
          --data-urlencode "cmd=$cmd" \
          --data-urlencode "enabled=$enabled" \
          --data-urlencode "display_name=$display_name" \
          --data-urlencode "description=$description"
        ;;
      *)
        usage 1
        ;;
    esac
    ;;
  channel)
    subcommand="${1:-}"
    [ -n "$subcommand" ] || usage 1
    shift || true
    case "$subcommand" in
      list)
        get_query channels
        ;;
      set)
        name=""
        display_name=""
        description=""
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --name)
              name="$(value_arg "$1" "${2:-}")"
              shift 2
              ;;
            --display-name)
              display_name="$(value_arg "$1" "${2:-}")"
              shift 2
              ;;
            --description)
              description="$(value_arg "$1" "${2:-}")"
              shift 2
              ;;
            *)
              usage 1
              ;;
          esac
        done
        [ -n "$name" ] || usage 1
        post_form channels/set \
          --data-urlencode "name=$name" \
          --data-urlencode "display_name=$display_name" \
          --data-urlencode "description=$description"
        ;;
      *)
        usage 1
        ;;
    esac
    ;;
  help|-h|--help)
    usage 0
    ;;
  *)
    usage 1
    ;;
esac
"#
}

fn initialization_script(session_id: &str, token: &str, endpoint_base: &str) -> String {
    let session_id = serde_json::to_string(session_id).unwrap_or_else(|_| "\"\"".to_string());
    let token = serde_json::to_string(token).unwrap_or_else(|_| "\"\"".to_string());
    let endpoint_base = serde_json::to_string(endpoint_base).unwrap_or_else(|_| "\"\"".to_string());
    let callback_endpoint = serde_json::to_string(&format!("{}/browser/callback", endpoint_base))
        .unwrap_or_else(|_| "\"\"".to_string());
    let console_endpoint = serde_json::to_string(&format!("{}/browser/console", endpoint_base))
        .unwrap_or_else(|_| "\"\"".to_string());
    let network_endpoint = serde_json::to_string(&format!("{}/browser/network", endpoint_base))
        .unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"
(() => {{
  const sessionId = {session_id};
  const token = {token};
  const endpointBase = {endpoint_base};
  const callbackEndpoint = {callback_endpoint};
  const consoleEndpoint = {console_endpoint};
  const networkEndpoint = {network_endpoint};
  const invokeOrFetch = async (command, endpoint, payload) => {{
    const body = {{
      session_id: sessionId,
      token,
      ...payload,
    }};
    try {{
      if (globalThis.__TAURI_INTERNALS__ && typeof globalThis.__TAURI_INTERNALS__.invoke === "function") {{
        await globalThis.__TAURI_INTERNALS__.invoke(command, {{ payload: body }});
        return;
      }}
    }} catch (_err) {{
    }}
    try {{
      await fetch(endpoint, {{
        method: "POST",
        mode: "no-cors",
        cache: "no-store",
        headers: {{ "Content-Type": "text/plain;charset=UTF-8" }},
        body: JSON.stringify(body),
        keepalive: true,
      }});
    }} catch (_err) {{
    }}
  }};
  const safeHref = () => {{
    try {{
      return globalThis.location && typeof globalThis.location.href === "string"
        ? globalThis.location.href
        : null;
    }} catch (_err) {{
      return null;
    }}
  }};
  const formatConsoleValue = (value, seen = new WeakSet()) => {{
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {{
      return String(value);
    }}
    if (typeof value === "function") {{
      return `[Function ${{value.name || "anonymous"}}]`;
    }}
    if (value instanceof Error) {{
      return value.stack || `${{value.name}}: ${{value.message}}`;
    }}
    if (typeof value === "object") {{
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      try {{
        return JSON.stringify(
          value,
          (_key, nested) => {{
            if (typeof nested === "bigint") return String(nested);
            if (nested instanceof Error) {{
              return nested.stack || `${{nested.name}}: ${{nested.message}}`;
            }}
            return nested;
          }},
          2,
        );
      }} catch (_err) {{
        try {{
          return String(value);
        }} catch (_err2) {{
          return "[Unserializable Object]";
        }}
      }}
    }}
    return String(value);
  }};
  const nowMs = () =>
    globalThis.performance && typeof globalThis.performance.now === "function"
      ? globalThis.performance.now()
      : Date.now();
  const normalizeMethod = (value) => {{
    const text = typeof value === "string" ? value.trim() : "";
    return text ? text.toUpperCase() : "GET";
  }};
  const resolveRequestUrl = (value) => {{
    try {{
      if (value && typeof value === "object" && typeof value.url === "string") {{
        return new URL(value.url, safeHref() || undefined).href;
      }}
      if (typeof value === "string") {{
        return new URL(value, safeHref() || undefined).href;
      }}
    }} catch (_err) {{
    }}
    if (value && typeof value === "object" && typeof value.url === "string") {{
      return String(value.url);
    }}
    return typeof value === "string" ? value : "";
  }};
  const isNetworkUrl = (url) => /^https?:\/\//i.test(url || "");
  const isBridgeInternalUrl = (url) => {{
    const resolved = resolveRequestUrl(url);
    return resolved.startsWith(`${{endpointBase}}/browser/`);
  }};
  const bridge = {{
    async postAction(payload) {{
      await invokeOrFetch("browser_ipc_callback", callbackEndpoint, payload);
    }},
    async postConsole(payload) {{
      await invokeOrFetch("browser_console_event", consoleEndpoint, payload);
    }},
    async postNetwork(payload) {{
      await invokeOrFetch("browser_network_event", networkEndpoint, payload);
    }},
  }};
  const emitNetwork = (payload) => {{
    const url = resolveRequestUrl(payload && payload.url ? payload.url : "");
    if (!isNetworkUrl(url) || isBridgeInternalUrl(url)) {{
      return;
    }}
    void bridge.postNetwork({{
      timestamp_ms: payload && typeof payload.timestamp_ms === "number" ? payload.timestamp_ms : Date.now(),
      kind: payload && typeof payload.kind === "string" ? payload.kind : "fetch",
      method: normalizeMethod(payload && payload.method),
      url,
      status:
        payload && typeof payload.status === "number" && Number.isFinite(payload.status)
          ? Math.max(0, Math.trunc(payload.status))
          : null,
      status_text:
        payload && typeof payload.status_text === "string" && payload.status_text
          ? payload.status_text
          : null,
      ok: payload && typeof payload.ok === "boolean" ? payload.ok : null,
      duration_ms:
        payload && typeof payload.duration_ms === "number" && Number.isFinite(payload.duration_ms)
          ? Math.max(0, Math.round(payload.duration_ms * 100) / 100)
          : null,
      frame_url: payload && payload.frame_url ? payload.frame_url : safeHref(),
      content_type:
        payload && typeof payload.content_type === "string" && payload.content_type
          ? payload.content_type
          : null,
      error:
        payload && typeof payload.error === "string" && payload.error
          ? payload.error
          : null,
    }});
  }};
  Object.defineProperty(globalThis, "__butterBridge", {{
    value: bridge,
    configurable: false,
    enumerable: false,
    writable: false
  }});
  if (!globalThis.__butterContextMenuBlocked) {{
    Object.defineProperty(globalThis, "__butterContextMenuBlocked", {{
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    }});
    globalThis.addEventListener(
      "contextmenu",
      (event) => {{
        event.preventDefault();
      }},
      true,
    );
  }}
  if (!globalThis.__butterConsoleHooked) {{
    Object.defineProperty(globalThis, "__butterConsoleHooked", {{
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    }});
    const captureConsole = (level, args) => {{
      const rendered = Array.from(args || [], (item) => formatConsoleValue(item));
      void bridge.postConsole({{
        timestamp_ms: Date.now(),
        level,
        text: rendered.join(" "),
        args: rendered,
        frame_url: safeHref(),
      }});
    }};
    for (const level of ["log", "info", "warn", "error", "debug"]) {{
      const original = console[level] ? console[level].bind(console) : null;
      console[level] = (...args) => {{
        captureConsole(level, args);
        if (original) {{
          return original(...args);
        }}
      }};
    }}
    globalThis.addEventListener("error", (event) => {{
      const text = event.message || "Unhandled error";
      void bridge.postConsole({{
        timestamp_ms: Date.now(),
        level: "error",
        text,
        args: [text],
        frame_url: safeHref(),
        source_url: event.filename || null,
        line: typeof event.lineno === "number" ? event.lineno : null,
        column: typeof event.colno === "number" ? event.colno : null,
        stack: event.error && event.error.stack ? String(event.error.stack) : null,
        kind: "window-error",
      }});
    }});
    globalThis.addEventListener("unhandledrejection", (event) => {{
      const reasonText = formatConsoleValue(event.reason);
      void bridge.postConsole({{
        timestamp_ms: Date.now(),
        level: "error",
        text: `Unhandled promise rejection: ${{reasonText}}`,
        args: [reasonText],
        frame_url: safeHref(),
        stack: event.reason && event.reason.stack ? String(event.reason.stack) : null,
        kind: "unhandledrejection",
      }});
    }});
  }}
  if (!globalThis.__butterNetworkHooked) {{
    Object.defineProperty(globalThis, "__butterNetworkHooked", {{
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    }});
    const originalFetch =
      typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
    if (originalFetch) {{
      globalThis.fetch = async (...args) => {{
        const [input, init] = args;
        const requestUrl = resolveRequestUrl(input);
        if (isBridgeInternalUrl(requestUrl)) {{
          return originalFetch(...args);
        }}
        const method = normalizeMethod(
          init && init.method
            ? init.method
            : input && typeof input === "object" && "method" in input
              ? input.method
              : "GET"
        );
        const startedAt = nowMs();
        const timestampMs = Date.now();
        try {{
          const response = await originalFetch(...args);
          emitNetwork({{
            timestamp_ms: timestampMs,
            kind: "fetch",
            method,
            url: response && response.url ? response.url : requestUrl,
            status: response && typeof response.status === "number" ? response.status : null,
            status_text: response && typeof response.statusText === "string" ? response.statusText : null,
            ok: response && typeof response.ok === "boolean" ? response.ok : null,
            duration_ms: nowMs() - startedAt,
            content_type:
              response && response.headers && typeof response.headers.get === "function"
                ? response.headers.get("content-type")
                : null,
          }});
          return response;
        }} catch (error) {{
          emitNetwork({{
            timestamp_ms: timestampMs,
            kind: "fetch",
            method,
            url: requestUrl,
            ok: false,
            duration_ms: nowMs() - startedAt,
            error: error && error.message ? String(error.message) : String(error),
          }});
          throw error;
        }}
      }};
    }}
    const OriginalXHR = globalThis.XMLHttpRequest;
    if (OriginalXHR && OriginalXHR.prototype) {{
      const originalOpen = OriginalXHR.prototype.open;
      const originalSend = OriginalXHR.prototype.send;
      OriginalXHR.prototype.open = function(method, url, ...rest) {{
        this.__butterNetwork = {{
          method: normalizeMethod(method),
          url: resolveRequestUrl(url),
          finalized: false,
          startedAt: null,
          timestampMs: null,
          error: null,
        }};
        return originalOpen.call(this, method, url, ...rest);
      }};
      OriginalXHR.prototype.send = function(...args) {{
        const meta =
          this.__butterNetwork ||
          (this.__butterNetwork = {{
            method: "GET",
            url: "",
            finalized: false,
            startedAt: null,
            timestampMs: null,
            error: null,
          }});
        if (isBridgeInternalUrl(meta.url)) {{
          return originalSend.apply(this, args);
        }}
        meta.startedAt = nowMs();
        meta.timestampMs = Date.now();
        const finalize = () => {{
          if (meta.finalized) return;
          meta.finalized = true;
          let contentType = null;
          try {{
            contentType = this.getResponseHeader("content-type");
          }} catch (_err) {{
          }}
          const status =
            typeof this.status === "number" && Number.isFinite(this.status) && this.status > 0
              ? this.status
              : null;
          emitNetwork({{
            timestamp_ms: meta.timestampMs,
            kind: "xhr",
            method: meta.method,
            url: meta.url,
            status,
            status_text: this.statusText || null,
            ok: status !== null ? status >= 200 && status < 400 : meta.error ? false : null,
            duration_ms:
              typeof meta.startedAt === "number" && Number.isFinite(meta.startedAt)
                ? nowMs() - meta.startedAt
                : null,
            content_type: contentType,
            error: meta.error,
          }});
        }};
        this.addEventListener("load", finalize, {{ once: true }});
        this.addEventListener(
          "error",
          () => {{
            meta.error = "Network error";
            finalize();
          }},
          {{ once: true }}
        );
        this.addEventListener(
          "abort",
          () => {{
            meta.error = "Request aborted";
            finalize();
          }},
          {{ once: true }}
        );
        this.addEventListener(
          "timeout",
          () => {{
            meta.error = "Request timed out";
            finalize();
          }},
          {{ once: true }}
        );
        return originalSend.apply(this, args);
      }};
    }}
  }}
}})();
"#
    )
}

fn format_browser_eval_script(callback_id: &str, inner_script: &str) -> String {
    let callback_id_json =
        serde_json::to_string(callback_id).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"
(async () => {{
  const callbackId = {callback_id_json};
  try {{
    const result = await (async () => {{
      {inner_script}
    }})();
    if (globalThis.__butterBridge) {{
      await globalThis.__butterBridge.postAction({{
        callback_id: callbackId,
        ok: true,
        result
      }});
    }}
  }} catch (error) {{
    if (globalThis.__butterBridge) {{
      await globalThis.__butterBridge.postAction({{
        callback_id: callbackId,
        ok: false,
        error: error && error.message ? error.message : String(error)
      }});
    }}
  }}
}})();
"#
    )
}

#[cfg(target_os = "macos")]
fn clear_webview_data_store<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    webview
        .with_webview(move |platform| unsafe {
            let view: &WKWebView = &*platform.inner().cast();
            let config = view.configuration();
            let store = config.websiteDataStore();
            let mtm = MainThreadMarker::new_unchecked();
            let all_data_types = WKWebsiteDataStore::allWebsiteDataTypes(mtm);
            let date = NSDate::dateWithTimeIntervalSince1970(0.0);
            let callback = RcBlock::new(move || {
                let _ = tx.send(Ok(()));
            });
            store.removeDataOfTypes_modifiedSince_completionHandler(
                &all_data_types,
                &date,
                &callback,
            );
        })
        .map_err(|e| e.to_string())?;

    rx.recv_timeout(CALLBACK_TIMEOUT)
        .map_err(|_| "Timed out waiting for browser data clear".to_string())?
}

#[cfg(not(target_os = "macos"))]
fn clear_webview_data_store<R: Runtime>(_webview: &Webview<R>) -> Result<(), String> {
    Err("Browser profile clearing is only supported on macOS".to_string())
}

fn with_wkwebview<R: Runtime, T, F>(webview: &Webview<R>, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&WKWebView) -> Result<T, String> + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    webview
        .with_webview(move |platform| unsafe {
            let wk_webview: &WKWebView = &*platform.inner().cast();
            let result = f(wk_webview);
            let _ = tx.send(result);
        })
        .map_err(|e| e.to_string())?;
    rx.recv()
        .map_err(|_| "Failed to receive WKWebView callback result".to_string())?
}

#[cfg(target_os = "macos")]
fn capture_snapshot<R: Runtime>(
    webview: &Webview<R>,
    format: BrowserImageFormat,
) -> Result<Vec<u8>, String> {
    let (tx, rx) = mpsc::channel();
    webview
        .with_webview(move |platform| unsafe {
            let view: &WKWebView = &*platform.inner().cast();
            let tx = tx.clone();
            let callback = RcBlock::new(
                move |image_ptr: *mut NSImage, _error_ptr: *mut objc2_foundation::NSError| {
                    if image_ptr.is_null() {
                        let _ = tx.send(Err("WKWebView snapshot returned no image".to_string()));
                        return;
                    }
                    let image = &*image_ptr;
                    let result = encode_snapshot_image(image, format);
                    let _ = tx.send(result);
                },
            );
            let mtm = MainThreadMarker::new_unchecked();
            let config = WKSnapshotConfiguration::new(mtm);
            view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &callback);
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(CALLBACK_TIMEOUT)
        .map_err(|_| "Timed out waiting for snapshot image".to_string())?
}

#[cfg(target_os = "macos")]
fn encode_snapshot_image(image: &NSImage, format: BrowserImageFormat) -> Result<Vec<u8>, String> {
    let tiff_data = image
        .TIFFRepresentation()
        .ok_or_else(|| "WKWebView snapshot returned no TIFF data".to_string())?;

    if format == BrowserImageFormat::Tiff {
        return Ok(tiff_data.to_vec());
    }

    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff_data)
        .ok_or_else(|| "Failed to convert snapshot TIFF into bitmap image".to_string())?;
    let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
    let encoded =
        unsafe { bitmap.representationUsingType_properties(format.storage_type(), &properties) }
            .ok_or_else(|| format!("Failed to encode snapshot as {}", format.content_type()))?;
    Ok(encoded.to_vec())
}

#[cfg(not(target_os = "macos"))]
fn capture_snapshot<R: Runtime>(
    _webview: &Webview<R>,
    _format: BrowserImageFormat,
) -> Result<Vec<u8>, String> {
    Err("Browser image snapshots are only supported on macOS".to_string())
}
