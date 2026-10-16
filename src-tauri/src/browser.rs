use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2::MainThreadOnly;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
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
use objc2_foundation::{NSDate, NSDictionary, NSString};
#[cfg(target_os = "macos")]
use objc2_web_kit::{
    WKContentWorld, WKSnapshotConfiguration, WKUserScript, WKUserScriptInjectionTime, WKWebView,
    WKWebsiteDataStore,
};

const CALLBACK_TIMEOUT: Duration = Duration::from_secs(20);
const CONSOLE_BUFFER_LIMIT: usize = 400;
const NETWORK_BUFFER_LIMIT: usize = 400;

/// Browser sessions for pinned web apps (browser.toml `[[app]]`) are
/// `app:<id>`; every other browser session id is a terminal's.
pub const APP_SESSION_PREFIX: &str = "app:";

pub fn is_app_session(session_id: &str) -> bool {
    session_id.starts_with(APP_SESSION_PREFIX)
}

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
    /// The browser.toml profile whose data store this pane uses.
    pub profile_id: String,
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

/// A page's Cmd+K / Cmd+Shift+K / Cmd+Shift+F, posted by the
/// initialization script.
#[derive(Debug, Clone, Deserialize)]
pub struct BrowserShortcutEvent {
    pub session_id: String,
    pub token: String,
    /// "commands", "switcher" or "fullscreen".
    pub action: String,
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
    /// browser.toml profile id. Fixed once a webview exists, until the user
    /// switches it (`switch_profile`).
    profile_id: String,
    /// Set when the first webview is created or the user picks a profile, so
    /// a later `assign_initial_profile` doesn't move the pane.
    profile_locked: bool,
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
    /// Fingerprint of the userscripts injected into the current webview.
    userscripts_fingerprint: Option<u64>,
}

impl BrowserSession {
    fn new(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            token: Uuid::new_v4().to_string(),
            webview_label: None,
            profile_id: crate::browser_config::DEFAULT_PROFILE_ID.to_string(),
            profile_locked: false,
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
            userscripts_fingerprint: None,
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
            profile_id: self.profile_id.clone(),
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

    pub fn app_handle(&self) -> &AppHandle<R> {
        &self.app
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
        let mut env = self.base_shell_env(session_id, token, path_prefix);
        if crate::paths::IS_DEV_FLAVOR {
            // Lets hook scripts that honor BUTTER_DB_PATH write activity
            // events to the dev DB instead of the release one.
            if let Ok(db_path) = crate::database::AgentDatabase::get_db_path() {
                env.push((
                    "BUTTER_DB_PATH".to_string(),
                    db_path.to_string_lossy().to_string(),
                ));
            }
        }
        Ok(env)
    }

    fn base_shell_env(
        &self,
        session_id: &str,
        token: String,
        path_prefix: String,
    ) -> Vec<(String, String)> {
        vec![
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
        ]
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

    /// Gives the pane its starting profile (a preset's `browser_profile`, an
    /// app's `profile`). No-op once the pane has a webview or the user picked
    /// a profile: a pane keeps its profile until switched from the footer.
    pub fn assign_initial_profile(
        &self,
        session_id: &str,
        requested: Option<&str>,
    ) -> Result<(), String> {
        let profile_id = crate::browser_config::current().resolve_profile(requested);
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Browser sessions lock poisoned".to_string())?;
        let entry = sessions
            .entry(session_id.to_string())
            .or_insert_with(|| BrowserSession::new(session_id));
        if !entry.profile_locked && entry.webview_label.is_none() {
            entry.profile_id = profile_id;
        }
        Ok(())
    }

    /// Moves the pane to another profile: recreates its webview on that
    /// profile's data store and reloads the page it was on.
    pub fn switch_profile(
        &self,
        session_id: &str,
        requested: &str,
    ) -> Result<BrowserSessionState, String> {
        let profile_id = crate::browser_config::current().resolve_profile(Some(requested));
        let (label_to_close, reload_url) = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Browser sessions lock poisoned".to_string())?;
            let entry = sessions
                .entry(session_id.to_string())
                .or_insert_with(|| BrowserSession::new(session_id));
            entry.profile_locked = true;
            if entry.profile_id == profile_id {
                (None, None)
            } else {
                entry.profile_id = profile_id;
                entry.loading = false;
                entry.can_go_back = false;
                entry.can_go_forward = false;
                entry.console_entries.clear();
                entry.network_entries.clear();
                let label = entry.webview_label.take();
                let url = entry.url.clone();
                let reload = label.is_some() && is_reloadable_url(&url);
                (label, reload.then_some(url))
            }
        };
        let had_webview = label_to_close.is_some();
        if let Some(label) = label_to_close {
            if let Some(webview) = self.app.get_webview(&label) {
                let _ = webview.close();
            }
        }
        if had_webview {
            match reload_url {
                Some(url) => {
                    self.open(session_id, Some(url))?;
                }
                None => {
                    self.ensure_webview(session_id, None)?;
                }
            }
        }
        self.emit_state(session_id)?;
        self.get_state(session_id)
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
        self.sync_userscripts(session_id, &webview, Userscripts::load());
        let same_document = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Browser sessions lock poisoned".to_string())?;
            match sessions.get_mut(session_id) {
                Some(entry) => {
                    let same_document = is_fragment_navigation(&entry.url, url);
                    entry.url = url.to_string();
                    entry.loading = !same_document;
                    entry.last_error = None;
                    same_document
                }
                None => false,
            }
        };
        if same_document {
            // Only the #fragment changes (a browser.toml command such as
            // "#search/is:unread"): let the page's router handle it, as a click
            // on a link would, instead of a load that never reports finishing.
            let target = serde_json::to_string(url).map_err(|e| e.to_string())?;
            webview
                .eval(format!("location.href = {target};"))
                .map_err(|e| e.to_string())?;
        } else {
            webview.navigate(parsed).map_err(|e| e.to_string())?;
        }
        self.emit_state(session_id)?;
        self.get_state(session_id)
    }

    pub fn reload(&self, session_id: &str) -> Result<BrowserSessionState, String> {
        let webview = self.require_webview(session_id)?;
        self.sync_userscripts(session_id, &webview, Userscripts::load());
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

    /// Deletes every cookie, cache and site storage in `profile_id`'s data
    /// store and resets the panes that use it. Returns the panes that were
    /// open, for the caller to reopen. Call off the main thread.
    pub fn clear_profile(&self, profile_id: &str) -> Result<Vec<String>, String> {
        clear_profile_data_store(&self.app, profile_id)?;

        let (reopen, affected_session_ids, labels) = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Browser sessions lock poisoned".to_string())?;
            let mut reopen = Vec::new();
            let mut affected_session_ids = Vec::new();
            let mut labels = Vec::new();

            for entry in sessions.values_mut() {
                if entry.profile_id != profile_id {
                    continue;
                }
                affected_session_ids.push(entry.session_id.clone());
                if entry.open {
                    reopen.push(entry.session_id.clone());
                }
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

            (reopen, affected_session_ids, labels)
        };

        for label in labels {
            if let Some(webview) = self.app.get_webview(&label) {
                let _ = webview.close();
            }
        }

        for affected_session_id in affected_session_ids {
            let _ = self.emit_state(&affected_session_id);
        }

        Ok(reopen)
    }

    /// Sites (WebKit's display names, usually the registrable domain) with
    /// data in the profile's store. Call off the main thread.
    pub fn profile_sites(&self, profile_id: &str) -> Result<Vec<String>, String> {
        fetch_profile_sites(&self.app, profile_id)
    }

    /// Deletes one site's data from the profile's store. Call off the main
    /// thread.
    pub fn remove_profile_site(&self, profile_id: &str, site: &str) -> Result<(), String> {
        remove_profile_site_data(&self.app, profile_id, site)
    }

    /// Hides a visible pane, returning a JPEG of what it showed first, so the
    /// UI can put a dimmed picture in its place while a palette is open.
    /// Call off the main thread.
    pub fn suspend_with_snapshot(&self, session_id: &str) -> Result<Option<Vec<u8>>, String> {
        let (visible, width) = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| "Browser sessions lock poisoned".to_string())?;
            match sessions.get(session_id) {
                Some(entry) => (
                    entry.visible && entry.webview_label.is_some(),
                    entry.bounds.as_ref().map(|b| b.width).unwrap_or(0.0),
                ),
                None => (false, 0.0),
            }
        };
        let snapshot = if visible {
            let webview = self.require_webview(session_id)?;
            // Half width: on a Retina screen that's one pixel per point, plenty
            // for a dimmed backdrop, and quick to encode.
            let snapshot_width = (width / 2.0).round();
            capture_snapshot_sized(
                &webview,
                BrowserImageFormat::Jpeg,
                (snapshot_width >= 64.0).then_some(snapshot_width),
                Duration::from_millis(400),
            )
            .ok()
        } else {
            None
        };
        self.set_visible(session_id, false)?;
        Ok(snapshot)
    }

    /// Gives the pane's webview keyboard focus.
    pub fn focus(&self, session_id: &str) -> Result<(), String> {
        let webview = self.require_webview(session_id)?;
        webview.set_focus().map_err(|e| e.to_string())
    }

    /// A page asked for one of Butter's shortcuts (Cmd+K, Cmd+Shift+K,
    /// Cmd+Shift+F). Hands focus to Butter's own webview so typing goes to
    /// the palette, and tells the UI.
    pub fn handle_page_shortcut(&self, payload: BrowserShortcutEvent) -> Result<(), String> {
        self.validate_token(&payload.session_id, &payload.token)?;
        let action = match payload.action.as_str() {
            "commands" | "switcher" | "fullscreen" => payload.action.clone(),
            other => return Err(format!("Unknown browser shortcut {other:?}")),
        };
        // Palettes take typing; full screen leaves focus in the page.
        if action != "fullscreen" {
            if let Some(main) = self.app.get_webview("main") {
                let _ = main.set_focus();
            }
        }
        self.app
            .emit(
                "browser-shortcut",
                serde_json::json!({ "sessionId": payload.session_id, "action": action }),
            )
            .map_err(|e| format!("Failed to emit browser shortcut: {e}"))
    }

    /// Inbox Keys' commands on the pane's page (Gmail), or `null` when Inbox
    /// Keys isn't running there. Asks the userscript's Butter shim, which
    /// lives in an isolated world, through DOM events. Call off the main
    /// thread.
    pub fn inbox_keys_commands(&self, session_id: &str) -> Result<serde_json::Value, String> {
        self.eval_with_result(
            session_id,
            &inbox_keys_request_script(r#"{ "type": "list" }"#),
            Duration::from_millis(2_500),
        )
    }

    /// Runs one Inbox Keys command by id. Call off the main thread.
    pub fn inbox_keys_run(
        &self,
        session_id: &str,
        command_id: &str,
    ) -> Result<serde_json::Value, String> {
        let request = serde_json::json!({ "type": "run", "command": command_id }).to_string();
        self.eval_with_result(
            session_id,
            &inbox_keys_request_script(&request),
            Duration::from_millis(2_500),
        )
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
        // Tauri panics on a label with other characters.
        if !session_id
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '/' | ':' | '_'))
        {
            return Err(format!("Invalid browser session id {session_id:?}"));
        }
        let (needs_create, label, visible, bounds, token, session_id_owned, profile_id) = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|_| "Browser sessions lock poisoned".to_string())?;
            let entry = sessions
                .entry(session_id.to_string())
                .or_insert_with(|| BrowserSession::new(session_id));
            let label = entry.label();
            entry.profile_locked = true;
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
                entry.profile_id.clone(),
            )
        };

        if !needs_create {
            return Ok(());
        }

        let window = self
            .app
            .get_window("main")
            .ok_or_else(|| "Main window not found".to_string())?;
        let userscripts = Userscripts::load();
        // Userscripts are added once the webview exists, so start blank and let
        // the caller's navigate() (open and navigate both follow up with one)
        // load the page with them in place.
        let url = if userscripts.is_empty() {
            initial_url.unwrap_or("about:blank")
        } else {
            "about:blank"
        };
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
        .user_agent(safari_user_agent())
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

        // Every profile, "default" included, has a store of its own. WebKit's
        // default store belongs to Butter's UI.
        builder = builder
            .data_store_identifier(crate::browser_config::data_store_identifier(&profile_id));

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
        self.set_userscripts_fingerprint(session_id, None);
        self.sync_userscripts(session_id, &webview, userscripts);
        self.refresh_navigation_flags(session_id)?;
        self.emit_state(session_id)
    }

    fn set_userscripts_fingerprint(&self, session_id: &str, fingerprint: Option<u64>) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(entry) = sessions.get_mut(session_id) {
                entry.userscripts_fingerprint = fingerprint;
            }
        }
    }

    /// Puts `userscripts` into the webview in place of the ones injected
    /// before. They apply from the next page load. No-op when unchanged.
    fn sync_userscripts(&self, session_id: &str, webview: &Webview<R>, userscripts: Userscripts) {
        let previous = self.sessions.lock().ok().and_then(|sessions| {
            sessions
                .get(session_id)
                .and_then(|e| e.userscripts_fingerprint)
        });
        let fingerprint = userscripts.fingerprint();
        if previous == Some(fingerprint) || (previous.is_none() && userscripts.is_empty()) {
            self.set_userscripts_fingerprint(session_id, Some(fingerprint));
            return;
        }
        match replace_userscripts(webview, userscripts.injections) {
            Ok(()) => self.set_userscripts_fingerprint(session_id, Some(fingerprint)),
            Err(err) => eprintln!("[userscripts] could not inject into {session_id}: {err}"),
        }
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

fn fnv1a64(bytes: &[u8], seed: u64) -> u64 {
    let mut hash = seed;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// `to` is the page `from` is on, with a #fragment.
fn is_fragment_navigation(from: &str, to: &str) -> bool {
    let Some((to_page, _)) = to.split_once('#') else {
        return false;
    };
    let from_page = from.split_once('#').map_or(from, |(page, _)| page);
    is_reloadable_url(from_page) && from_page == to_page
}

/// A page worth loading again after a profile switch.
fn is_reloadable_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("file://")
}

/// Page-world script for `eval_with_result` that sends `request` (JSON) to
/// the Inbox Keys shim (`vendor/inbox-keys/butter-chrome-shim.js`), which
/// runs in the userscript's isolated world. DOM events cross worlds; their
/// string `detail` does too. Resolves `null` when nothing answers.
fn inbox_keys_request_script(request: &str) -> String {
    format!(
        r#"
const request = {request};
request.id = "butter-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
return await new Promise((resolve) => {{
  let done = false;
  const finish = (value) => {{
    if (done) return;
    done = true;
    document.removeEventListener("butter:inboxkeys-response", onResponse);
    resolve(value);
  }};
  const onResponse = (event) => {{
    let message = null;
    try {{ message = JSON.parse(event.detail); }} catch (_err) {{ return; }}
    if (!message || message.id !== request.id) return;
    finish(message.payload === undefined ? null : message.payload);
  }};
  document.addEventListener("butter:inboxkeys-response", onResponse);
  window.setTimeout(() => finish(null), 1500);
  document.dispatchEvent(new CustomEvent("butter:inboxkeys-request", {{ detail: JSON.stringify(request) }}));
}});
"#
    )
}

/// `~/.butter/bin` (`~/.butter-dev/bin` in the dev flavor). Only put on PATH
/// for shells that Butter itself spawns, so the dev shims never shadow the
/// release ones.
fn cli_bin_dir() -> Result<PathBuf, String> {
    Ok(crate::paths::butter_home()?.join("bin"))
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
  butter-browser open [--profile <id>] [url]
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
  butter-browser open [--profile <id>] [url]
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
    profile=""
    case "${1:-}" in
      --profile)
        [ "${2:-}" ] || usage 1
        profile="$2"
        shift 2
        ;;
      --profile=*)
        profile="${1#--profile=}"
        shift
        ;;
    esac
    set -- "${1:-}" "$profile"
    if [ -n "$1" ] && [ -n "$2" ]; then
      post_form open --data-urlencode "url=$1" --data-urlencode "profile=$2"
    elif [ -n "$1" ]; then
      post_form open --data-urlencode "url=$1"
    elif [ -n "$2" ]; then
      post_form open --data-urlencode "profile=$2"
    else
      post_form open
    fi
    ;;
  goto|navigate)
    [ "${1:-}" ] || usage 1
    post_form navigate --data-urlencode "url=$1"
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
  butter-cli session create --directory <path> --agent <claude|codex> [--prompt-stdin | --prompt <text>]
  butter-cli team send --channel <name> <message>
  butter-cli team send --to <username> <message>
  butter-cli team reply <message-id> <message>
  butter-cli team inbox [--recent]
  butter-cli team search <query>
  butter-cli team search --advanced <query>
  butter-cli team read --channel <name>
  butter-cli team mark-read <message-id>
  butter-cli team mark-unread <message-id>
  butter-cli team user list
  butter-cli team user set --username <name> --pwd <path> --cmd <command> [--display-name <name>] [--description <text>] [--disabled]
  butter-cli team channel list
  butter-cli team channel set --name <name> [--display-name <name>] [--description <text>]
  butter-cli thread reply [--image <path>]... <message>
  butter-cli routine create (--in <30m|4h|3d|2w> | --at <YYYY-MM-DD [HH:MM]>) [--title <name>] <prompt>
  butter-cli routine list [--all]
  butter-cli routine snooze [<id>] (--in <duration> | --at <when>) [<new prompt>]
  butter-cli routine cancel <id>
  butter-cli rec <status|meeting start|meeting stop|dictate|list|transcript|...>  (local recorder; butter-cli rec help)
  butter-cli help
EOF
  else
    cat >&2 <<'EOF'
Usage:
  butter-cli session create --directory <path> --agent <claude|codex> [--prompt-stdin | --prompt <text>]
  butter-cli team send --channel <name> <message>
  butter-cli team send --to <username> <message>
  butter-cli team reply <message-id> <message>
  butter-cli team inbox [--recent]
  butter-cli team search <query>
  butter-cli team search --advanced <query>
  butter-cli team read --channel <name>
  butter-cli team mark-read <message-id>
  butter-cli team mark-unread <message-id>
  butter-cli team user list
  butter-cli team user set --username <name> --pwd <path> --cmd <command> [--display-name <name>] [--description <text>] [--disabled]
  butter-cli team channel list
  butter-cli team channel set --name <name> [--display-name <name>] [--description <text>]
  butter-cli thread reply [--image <path>]... <message>
  butter-cli routine create (--in <30m|4h|3d|2w> | --at <YYYY-MM-DD [HH:MM]>) [--title <name>] <prompt>
  butter-cli routine list [--all]
  butter-cli routine snooze [<id>] (--in <duration> | --at <when>) [<new prompt>]
  butter-cli routine cancel <id>
  butter-cli rec <status|meeting start|meeting stop|dictate|list|transcript|...>  (local recorder; butter-cli rec help)
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
  session)
    exec "$(dirname "$0")/butter-session-cli" "$@"
    ;;
  rec)
    rec="$(dirname "$0")/butter-rec"
    if [ ! -x "$rec" ]; then
      echo "butter-cli: butter-rec isn't installed; build it with recorder/build.sh in the Butter repo" >&2
      exit 1
    fi
    exec "$rec" "$@"
    ;;
  team)
    ;;
  thread)
    need_env BUTTER_SESSION_ID
    need_env BUTTER_TEAM_ENDPOINT
    need_env BUTTER_TEAM_TOKEN
    subcommand="${1:-}"
    [ -n "$subcommand" ] || usage 1
    shift || true
    case "$subcommand" in
      reply)
        images=""
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --image)
              [ -n "${2:-}" ] || usage 1
              image="$2"
              case "$image" in
                /*) ;;
                *) image="$PWD/$image" ;;
              esac
              images="${images}${image}
"
              shift 2
              ;;
            *)
              break
              ;;
          esac
        done
        content="$(join_args "$@")"
        if [ -z "$content" ] && [ -z "$images" ] && [ ! -t 0 ]; then
          content="$(cat)"
        fi
        [ -n "$content" ] || [ -n "$images" ] || usage 1
        curl -fsS -X POST \
          --data-urlencode "token=$BUTTER_TEAM_TOKEN" \
          --data-urlencode "body=$content" \
          --data-urlencode "images=$images" \
          "$BUTTER_TEAM_ENDPOINT/thread/$BUTTER_SESSION_ID/reply"
        printf '\n'
        exit 0
        ;;
      *)
        usage 1
        ;;
    esac
    ;;
  routine)
    need_env BUTTER_SESSION_ID
    need_env BUTTER_TEAM_ENDPOINT
    need_env BUTTER_TEAM_TOKEN
    subcommand="${1:-}"
    [ -n "$subcommand" ] || usage 1
    shift || true
    at=""
    after=""
    title=""
    all=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --at)
          [ -n "${2:-}" ] || usage 1
          at="$2"
          shift 2
          ;;
        --in)
          [ -n "${2:-}" ] || usage 1
          after="$2"
          shift 2
          ;;
        --title)
          [ -n "${2:-}" ] || usage 1
          title="$2"
          shift 2
          ;;
        --all)
          all=1
          shift
          ;;
        *)
          break
          ;;
      esac
    done
    endpoint="$BUTTER_TEAM_ENDPOINT/routine/$BUTTER_SESSION_ID"
    case "$subcommand" in
      create)
        prompt="$(join_args "$@")"
        if [ -z "$prompt" ] && [ ! -t 0 ]; then
          prompt="$(cat)"
        fi
        [ -n "$prompt" ] || usage 1
        curl -sS --fail-with-body -X POST \
          --data-urlencode "token=$BUTTER_TEAM_TOKEN" \
          --data-urlencode "prompt=$prompt" \
          --data-urlencode "title=$title" \
          --data-urlencode "at=$at" \
          --data-urlencode "after=$after" \
          --data-urlencode "cwd=$PWD" \
          "$endpoint/create"
        ;;
      list)
        curl -sS --fail-with-body -G \
          --data-urlencode "token=$BUTTER_TEAM_TOKEN" \
          --data-urlencode "all=$all" \
          "$endpoint/list"
        ;;
      snooze)
        routine=""
        case "${1:-}" in
          ""|-*) ;;
          *)
            # A bare first word is the routine id when it looks like one.
            if printf '%s' "$1" | grep -Eq '^[0-9a-f]{8}$'; then
              routine="$1"
              shift
            fi
            ;;
        esac
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --at) [ -n "${2:-}" ] || usage 1; at="$2"; shift 2 ;;
            --in) [ -n "${2:-}" ] || usage 1; after="$2"; shift 2 ;;
            *) break ;;
          esac
        done
        prompt="$(join_args "$@")"
        curl -sS --fail-with-body -X POST \
          --data-urlencode "token=$BUTTER_TEAM_TOKEN" \
          --data-urlencode "routine=$routine" \
          --data-urlencode "at=$at" \
          --data-urlencode "after=$after" \
          --data-urlencode "prompt=$prompt" \
          "$endpoint/snooze"
        ;;
      cancel)
        [ -n "${1:-}" ] || usage 1
        curl -sS --fail-with-body -X POST \
          --data-urlencode "token=$BUTTER_TEAM_TOKEN" \
          --data-urlencode "routine=$1" \
          "$endpoint/cancel"
        ;;
      *)
        usage 1
        ;;
    esac
    printf '\n'
    exit 0
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
    case "${1:-}" in
      "")
        get_query inbox
        ;;
      --recent)
        get_query inbox --data-urlencode "include_read=true"
        ;;
      *)
        usage 1
        ;;
    esac
    ;;
  search)
    advanced=""
    if [ "${1:-}" = "--advanced" ]; then
      advanced="true"
      shift || true
    fi
    query="$(join_args "$@")"
    [ -n "$query" ] || usage 1
    if [ -n "$advanced" ]; then
      get_query search --data-urlencode "q=$query" --data-urlencode "advanced=true"
    else
      get_query search --data-urlencode "q=$query"
    fi
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

/// WKWebView's default user agent leaves off Safari's `Version/… Safari/…`
/// suffix, so sites like Gmail treat the browser pane as an unsupported,
/// outdated browser. Send the same user agent as the Mac's Safari, which runs
/// the same WebKit.
fn safari_user_agent() -> &'static str {
    static UA: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    UA.get_or_init(|| {
        let version = Command::new("defaults")
            .args([
                "read",
                "/Applications/Safari.app/Contents/Info",
                "CFBundleShortVersionString",
            ])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit() || c == '.'))
            .unwrap_or_else(|| "26.0".to_string());
        safari_user_agent_for(&version)
    })
}

fn safari_user_agent_for(version: &str) -> String {
    // Safari reports macOS 10_15_7 on every macOS version, and only major.minor.
    let short: Vec<&str> = version.split('.').take(2).collect();
    format!(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{} Safari/605.1.15",
        short.join(".")
    )
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
    let shortcut_endpoint = serde_json::to_string(&format!("{}/browser/shortcut", endpoint_base))
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
  const shortcutEndpoint = {shortcut_endpoint};
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
    async postShortcut(payload) {{
      await invokeOrFetch("browser_page_shortcut", shortcutEndpoint, payload);
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
  // Butter's own shortcuts win over the page's (Gmail binds Cmd+K too): the
  // window capture phase runs before any listener on the document. Every
  // frame gets this listener, since keys go to the focused frame's window.
  if (!globalThis.__butterShortcutsHooked) {{
    Object.defineProperty(globalThis, "__butterShortcutsHooked", {{
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    }});
    const shortcutFor = (event) => {{
      if (!event.metaKey || event.ctrlKey || event.altKey) return null;
      const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
      if (key === "k") return event.shiftKey ? "switcher" : "commands";
      if (key === "f" && event.shiftKey) return "fullscreen";
      return null;
    }};
    globalThis.addEventListener(
      "keydown",
      (event) => {{
        const action = shortcutFor(event);
        if (!action) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat) return;
        void bridge.postShortcut({{ action }});
      }},
      true,
    );
  }}
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

/// Runs `f` on the main thread with the WebKit data store of `profile_id`
/// (the same store its panes get from `data_store_identifier`) and waits for
/// it to send a result. `f` gets the store and a sender to finish with; keep
/// the store alive in any completion block. Never call on the main thread.
#[cfg(target_os = "macos")]
fn with_profile_store<R, T, F>(app: &AppHandle<R>, profile_id: &str, f: F) -> Result<T, String>
where
    R: Runtime,
    T: Send + 'static,
    F: FnOnce(objc2::rc::Retained<WKWebsiteDataStore>, mpsc::Sender<Result<T, String>>)
        + Send
        + 'static,
{
    let identifier = crate::browser_config::data_store_identifier(profile_id);
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || unsafe {
        let mtm = MainThreadMarker::new_unchecked();
        let uuid = objc2_foundation::NSUUID::from_bytes(identifier);
        let store = WKWebsiteDataStore::dataStoreForIdentifier(&uuid, mtm);
        f(store, tx);
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(CALLBACK_TIMEOUT)
        .map_err(|_| "Timed out waiting for the browser data store".to_string())?
}

#[cfg(target_os = "macos")]
fn clear_profile_data_store<R: Runtime>(
    app: &AppHandle<R>,
    profile_id: &str,
) -> Result<(), String> {
    with_profile_store(app, profile_id, |store, tx| unsafe {
        let mtm = MainThreadMarker::new_unchecked();
        let all_data_types = WKWebsiteDataStore::allWebsiteDataTypes(mtm);
        let date = NSDate::dateWithTimeIntervalSince1970(0.0);
        let keep = store.clone();
        let callback = RcBlock::new(move || {
            let _ = &keep;
            let _ = tx.send(Ok(()));
        });
        store.removeDataOfTypes_modifiedSince_completionHandler(&all_data_types, &date, &callback);
    })
}

#[cfg(target_os = "macos")]
fn fetch_profile_sites<R: Runtime>(
    app: &AppHandle<R>,
    profile_id: &str,
) -> Result<Vec<String>, String> {
    with_profile_store(app, profile_id, |store, tx| unsafe {
        let mtm = MainThreadMarker::new_unchecked();
        let all_data_types = WKWebsiteDataStore::allWebsiteDataTypes(mtm);
        let keep = store.clone();
        let callback = RcBlock::new(
            move |records: std::ptr::NonNull<
                objc2_foundation::NSArray<objc2_web_kit::WKWebsiteDataRecord>,
            >| {
                let _ = &keep;
                let mut sites: Vec<String> = records
                    .as_ref()
                    .to_vec()
                    .iter()
                    .map(|record| record.displayName().to_string())
                    .filter(|name| !name.is_empty())
                    .collect();
                sites.sort();
                sites.dedup();
                let _ = tx.send(Ok(sites));
            },
        );
        store.fetchDataRecordsOfTypes_completionHandler(&all_data_types, &callback);
    })
}

#[cfg(target_os = "macos")]
fn remove_profile_site_data<R: Runtime>(
    app: &AppHandle<R>,
    profile_id: &str,
    site: &str,
) -> Result<(), String> {
    let site = site.to_string();
    with_profile_store(app, profile_id, move |store, tx| unsafe {
        let mtm = MainThreadMarker::new_unchecked();
        let all_data_types = WKWebsiteDataStore::allWebsiteDataTypes(mtm);
        let keep = store.clone();
        let fetched = RcBlock::new(
            move |records: std::ptr::NonNull<
                objc2_foundation::NSArray<objc2_web_kit::WKWebsiteDataRecord>,
            >| {
                let matching: Vec<_> = records
                    .as_ref()
                    .to_vec()
                    .into_iter()
                    .filter(|record| record.displayName().to_string() == site)
                    .collect();
                if matching.is_empty() {
                    let _ = tx.send(Ok(()));
                    return;
                }
                let mtm = MainThreadMarker::new_unchecked();
                let types = WKWebsiteDataStore::allWebsiteDataTypes(mtm);
                let array = objc2_foundation::NSArray::from_retained_slice(&matching);
                let tx = tx.clone();
                let keep_inner = keep.clone();
                let removed = RcBlock::new(move || {
                    let _ = &keep_inner;
                    let _ = tx.send(Ok(()));
                });
                keep.removeDataOfTypes_forDataRecords_completionHandler(&types, &array, &removed);
            },
        );
        store.fetchDataRecordsOfTypes_completionHandler(&all_data_types, &fetched);
    })
}

#[cfg(not(target_os = "macos"))]
fn clear_profile_data_store<R: Runtime>(
    _app: &AppHandle<R>,
    _profile_id: &str,
) -> Result<(), String> {
    Err("Browser profile clearing is only supported on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
fn fetch_profile_sites<R: Runtime>(
    _app: &AppHandle<R>,
    _profile_id: &str,
) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

#[cfg(not(target_os = "macos"))]
fn remove_profile_site_data<R: Runtime>(
    _app: &AppHandle<R>,
    _profile_id: &str,
    _site: &str,
) -> Result<(), String> {
    Err("Browser site data is only supported on macOS".to_string())
}

/// One userscript, ready to hand to WebKit. Plain data so it can cross to the
/// main thread.
struct UserscriptInjection {
    source: String,
    at_document_start: bool,
    main_frame_only: bool,
    /// Isolated content world name; `None` means the page world.
    world: Option<String>,
}

struct Userscripts {
    injections: Vec<UserscriptInjection>,
}

impl Userscripts {
    fn load() -> Self {
        use crate::userscripts::{injection_source, load, RunAt};
        let injections = load()
            .iter()
            .map(|script| UserscriptInjection {
                source: injection_source(script),
                at_document_start: script.run_at == RunAt::DocumentStart,
                main_frame_only: script.no_frames,
                world: script.world_name(),
            })
            .collect();
        Self { injections }
    }

    fn is_empty(&self) -> bool {
        self.injections.is_empty()
    }

    fn fingerprint(&self) -> u64 {
        self.injections
            .iter()
            .fold(0xcbf29ce484222325, |hash, injection| {
                let flags = [
                    u8::from(injection.at_document_start),
                    u8::from(injection.main_frame_only),
                ];
                let hash = fnv1a64(&flags, hash);
                let hash = fnv1a64(
                    injection.world.as_deref().unwrap_or("page").as_bytes(),
                    hash,
                );
                fnv1a64(injection.source.as_bytes(), hash)
            })
    }
}

/// Swaps the webview's userscripts: keeps wry's own `WKUserScript`s (Tauri's
/// initialization scripts), drops the ones Butter added before, adds the new
/// ones. Content scripts get a named `WKContentWorld` each, an isolated world
/// where the page's CSP and Trusted Types don't apply to their DOM writes.
#[cfg(target_os = "macos")]
fn replace_userscripts<R: Runtime>(
    webview: &Webview<R>,
    injections: Vec<UserscriptInjection>,
) -> Result<(), String> {
    with_wkwebview(webview, move |view| unsafe {
        let mtm = MainThreadMarker::new_unchecked();
        let controller = view.configuration().userContentController();
        let is_ours = |script: &WKUserScript| {
            script
                .source()
                .to_string()
                .starts_with(crate::userscripts::SOURCE_PREFIX)
        };
        let existing = controller.userScripts().to_vec();
        if existing.iter().any(|script| is_ours(script)) {
            controller.removeAllUserScripts();
            for script in existing.iter().filter(|script| !is_ours(script)) {
                controller.addUserScript(script);
            }
        }
        for injection in &injections {
            let world = match &injection.world {
                Some(name) => WKContentWorld::worldWithName(&NSString::from_str(name), mtm),
                None => WKContentWorld::pageWorld(mtm),
            };
            let time = if injection.at_document_start {
                WKUserScriptInjectionTime::AtDocumentStart
            } else {
                WKUserScriptInjectionTime::AtDocumentEnd
            };
            let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly_inContentWorld(
                WKUserScript::alloc(mtm),
                &NSString::from_str(&injection.source),
                time,
                injection.main_frame_only,
                &world,
            );
            controller.addUserScript(&script);
        }
        Ok(())
    })
}

#[cfg(not(target_os = "macos"))]
fn replace_userscripts<R: Runtime>(
    _webview: &Webview<R>,
    _injections: Vec<UserscriptInjection>,
) -> Result<(), String> {
    Err("Userscripts are only supported on macOS".to_string())
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

fn capture_snapshot<R: Runtime>(
    webview: &Webview<R>,
    format: BrowserImageFormat,
) -> Result<Vec<u8>, String> {
    capture_snapshot_sized(webview, format, None, CALLBACK_TIMEOUT)
}

/// `width` is in points; `None` keeps the view's own width.
#[cfg(target_os = "macos")]
fn capture_snapshot_sized<R: Runtime>(
    webview: &Webview<R>,
    format: BrowserImageFormat,
    width: Option<f64>,
    timeout: Duration,
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
            if let Some(width) = width {
                config.setSnapshotWidth(Some(&objc2_foundation::NSNumber::new_f64(width)));
            }
            view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &callback);
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(timeout)
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
fn capture_snapshot_sized<R: Runtime>(
    _webview: &Webview<R>,
    _format: BrowserImageFormat,
    _width: Option<f64>,
    _timeout: Duration,
) -> Result<Vec<u8>, String> {
    Err("Browser image snapshots are only supported on macOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragment_navigations() {
        let inbox = "https://mail.google.com/mail/u/0/#inbox";
        assert!(is_fragment_navigation(
            inbox,
            "https://mail.google.com/mail/u/0/#search/is%3Aunread"
        ));
        assert!(is_fragment_navigation(
            "https://a.com/x",
            "https://a.com/x#top"
        ));
        // The pane may not know about in-page hash changes, so same is fine too.
        assert!(is_fragment_navigation(inbox, inbox));
        assert!(!is_fragment_navigation(
            inbox,
            "https://mail.google.com/mail/u/1/#inbox"
        ));
        assert!(!is_fragment_navigation(
            inbox,
            "https://mail.google.com/mail/u/0/"
        ));
        assert!(!is_fragment_navigation("about:blank", "about:blank#x"));
    }

    #[test]
    fn user_agent_looks_like_safari() {
        assert_eq!(
            safari_user_agent_for("26.6.2"),
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15"
        );
        assert!(safari_user_agent().contains(" Safari/605.1.15"));
    }
}
