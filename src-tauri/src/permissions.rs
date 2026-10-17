//! macOS privacy permissions (TCC) for the Permissions view (Cmd+K
//! "Permissions").
//!
//! Butter's own grants (Notifications, Screen Recording, Microphone), the
//! ones macOS charges to Butter for commands run in its terminals (Full Disk
//! Access, Desktop/Documents/Downloads, Automation), and ButterRec's, read
//! from its daemon over `~/.butter/rec.sock`.
//!
//! macOS keys grants to the app's designated requirement. An ad-hoc build's
//! is its code hash, so each build looks like a new app; `scripts/sign-app.sh`
//! signs installs with a certificate so the requirement stays the same. The
//! requirement is recorded in `<butter home>/signing.json` so a launch after
//! it changes can open the view once (see `should_auto_show`).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionState {
    Granted,
    Denied,
    NotDetermined,
    /// macOS has no way to check without asking.
    Unknown,
    /// ButterRec isn't installed / its daemon isn't running.
    NotInstalled,
    NotRunning,
    /// Not used with the current settings (ButterRec Accessibility when
    /// dictation doesn't paste).
    NotNeeded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionKind {
    Notifications,
    ScreenRecording,
    Microphone,
    FullDiskAccess,
    FilesAndFolders,
    Automation,
    RecMicrophone,
    RecSystemAudio,
    RecAccessibility,
}

#[derive(Debug, Clone, Serialize)]
pub struct PermissionStatus {
    pub kind: PermissionKind,
    pub state: PermissionState,
    /// A Grant click shows a system prompt instead of opening System Settings.
    pub can_prompt: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SigningInfo {
    /// `codesign -d -r-` designated requirement; None when not in a bundle.
    pub requirement: Option<String>,
    pub ad_hoc: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PermissionsReport {
    pub bundle_id: String,
    pub signing: SigningInfo,
    pub items: Vec<PermissionStatus>,
}

const RECORD_FILE: &str = "signing.json";

#[derive(Serialize, Deserialize, Default)]
struct SigningRecord {
    designated_requirement: Option<String>,
}

// ---- Pure logic ---------------------------------------------------------------

/// `AVAuthorizationStatus`: 0 not determined, 1 restricted, 2 denied, 3 authorized.
pub fn map_av_status(status: isize) -> PermissionState {
    match status {
        0 => PermissionState::NotDetermined,
        1 | 2 => PermissionState::Denied,
        3 => PermissionState::Granted,
        _ => PermissionState::Unknown,
    }
}

/// `UNAuthorizationStatus`: 0 not determined, 1 denied, 2 authorized,
/// 3 provisional, 4 ephemeral.
pub fn map_un_status(status: isize) -> PermissionState {
    match status {
        0 => PermissionState::NotDetermined,
        1 => PermissionState::Denied,
        2..=4 => PermissionState::Granted,
        _ => PermissionState::Unknown,
    }
}

/// A value from ButterRec's `status` reply (`permissions.microphone` etc.).
pub fn map_rec_status(value: Option<&str>) -> PermissionState {
    match value {
        Some("granted") => PermissionState::Granted,
        Some("denied") | Some("not granted") => PermissionState::Denied,
        Some("not requested") | Some("not determined") => PermissionState::NotDetermined,
        _ => PermissionState::Unknown,
    }
}

/// Opening the user's TCC.db works only with Full Disk Access. The open just
/// fails without it; Full Disk Access never shows a prompt.
pub fn map_fda_probe(result: &std::io::Result<std::fs::File>) -> PermissionState {
    match result {
        Ok(_) => PermissionState::Granted,
        Err(err) if matches!(err.raw_os_error(), Some(libc::EPERM) | Some(libc::EACCES)) => {
            PermissionState::Denied
        }
        Err(_) => PermissionState::Unknown,
    }
}

/// The requirement line of `codesign -d -r- <bundle>` output (either stream).
/// Ad-hoc signatures print it as a comment: `# designated => cdhash H"…"`.
pub fn parse_designated_requirement(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let line = line.trim_start_matches('#').trim();
        line.strip_prefix("designated => ")
            .map(|req| req.trim().to_string())
            .filter(|req| !req.is_empty())
    })
}

pub fn is_ad_hoc_requirement(requirement: &str) -> bool {
    requirement.starts_with("cdhash")
}

/// Open the Permissions view at launch? Once on the first launch ever (no
/// record yet), and once after the signature changes while one of Butter's
/// own permissions isn't granted. Never when the signature can't be read
/// (a bare `cargo tauri dev` binary).
pub fn should_auto_show(previous: Option<&str>, current: Option<&str>, own_missing: bool) -> bool {
    let Some(current) = current else {
        return false;
    };
    match previous {
        None => true,
        Some(previous) => previous != current && own_missing,
    }
}

/// Does ButterRec need Accessibility? Only when dictation pastes, which is
/// its default (`[dictation] output = "paste"` in recorder.toml).
pub fn rec_wants_accessibility(recorder_toml: Option<&str>) -> bool {
    let output = recorder_toml
        .and_then(|text| text.parse::<toml::Value>().ok())
        .and_then(|value| {
            value
                .get("dictation")
                .and_then(|d| d.get("output"))
                .and_then(|o| o.as_str())
                .map(str::to_string)
        });
    output.as_deref().unwrap_or("paste") == "paste"
}

/// ButterRec's rows from its daemon's `status` reply. `reply` is None when
/// the daemon didn't answer.
pub fn rec_items(
    installed: bool,
    reply: Option<&serde_json::Value>,
    wants_accessibility: bool,
) -> Vec<PermissionStatus> {
    let kinds = [
        PermissionKind::RecMicrophone,
        PermissionKind::RecSystemAudio,
        PermissionKind::RecAccessibility,
    ];
    let fixed = |state| {
        kinds
            .iter()
            .map(|&kind| PermissionStatus {
                kind,
                state,
                can_prompt: false,
            })
            .collect()
    };
    if !installed {
        return fixed(PermissionState::NotInstalled);
    }
    let Some(reply) = reply else {
        return fixed(PermissionState::NotRunning);
    };
    let field = |key: &str| {
        reply
            .get("permissions")
            .and_then(|p| p.get(key))
            .and_then(|v| v.as_str())
    };
    kinds
        .iter()
        .map(|&kind| {
            let state = match kind {
                PermissionKind::RecMicrophone => map_rec_status(field("microphone")),
                // No public API can check this; the daemon may report it later.
                PermissionKind::RecSystemAudio => map_rec_status(field("system_audio")),
                _ if !wants_accessibility => PermissionState::NotNeeded,
                _ => map_rec_status(field("accessibility")),
            };
            PermissionStatus {
                kind,
                state,
                can_prompt: false,
            }
        })
        .collect()
}

/// The System Settings pane for a permission. Anchors checked against
/// SecurityPrivacyExtension on macOS 26 (TCCServiceList.plist and the binary);
/// `com.apple.preference.security` is that extension's legacy id.
pub fn settings_url(kind: PermissionKind, bundle_id: &str) -> String {
    let anchor = match kind {
        PermissionKind::Notifications => return format!(
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id={bundle_id}"
        ),
        PermissionKind::ScreenRecording => "Privacy_ScreenCapture",
        PermissionKind::Microphone | PermissionKind::RecMicrophone => "Privacy_Microphone",
        PermissionKind::FullDiskAccess => "Privacy_AllFiles",
        PermissionKind::FilesAndFolders => "Privacy_FilesAndFolders",
        PermissionKind::Automation => "Privacy_Automation",
        PermissionKind::RecSystemAudio => "Privacy_AudioCapture",
        PermissionKind::RecAccessibility => "Privacy_Accessibility",
    };
    format!("x-apple.systempreferences:com.apple.preference.security?{anchor}")
}

fn own_kinds_missing(items: &[PermissionStatus]) -> bool {
    items.iter().any(|item| {
        matches!(
            item.kind,
            PermissionKind::Notifications
                | PermissionKind::ScreenRecording
                | PermissionKind::Microphone
        ) && item.state != PermissionState::Granted
    })
}

// ---- Probes -------------------------------------------------------------------

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// The `.app` this binary runs from, if any.
fn app_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension().and_then(|e| e.to_str()) == Some("app")).then(|| bundle.to_path_buf())
}

fn designated_requirement(bundle: &Path) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/codesign")
        .args(["-d", "-r-"])
        .arg(bundle)
        .output()
        .ok()?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    parse_designated_requirement(&text)
}

fn signing_info() -> SigningInfo {
    let requirement = app_bundle().and_then(|b| designated_requirement(&b));
    let ad_hoc = requirement
        .as_deref()
        .map(is_ad_hoc_requirement)
        .unwrap_or(true);
    SigningInfo {
        requirement,
        ad_hoc,
    }
}

fn fda_status() -> PermissionState {
    let Some(home) = home() else {
        return PermissionState::Unknown;
    };
    let db = home.join("Library/Application Support/com.apple.TCC/TCC.db");
    map_fda_probe(&std::fs::File::open(db))
}

fn rec_status() -> Vec<PermissionStatus> {
    let Some(home) = home() else {
        return rec_items(false, None, true);
    };
    let installed = home.join(".butter/ButterRec.app").is_dir();
    let reply = if installed {
        query_rec_daemon(&home.join(".butter/rec.sock"))
    } else {
        None
    };
    let config = std::fs::read_to_string(home.join(".config/butter/recorder.toml")).ok();
    rec_items(
        installed,
        reply.as_ref(),
        rec_wants_accessibility(config.as_deref()),
    )
}

/// One `{"cmd":"status"}` exchange with ButterRec's daemon (what
/// `butter-rec status` does). The daemon closes the socket after replying.
fn query_rec_daemon(socket: &Path) -> Option<serde_json::Value> {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    let mut stream = UnixStream::connect(socket).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .ok()?;
    stream.write_all(b"{\"cmd\":\"status\"}\n").ok()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

fn butter_items() -> Vec<PermissionStatus> {
    let notifications = platform::notification_status();
    let microphone = platform::microphone_status();
    let screen = platform::screen_recording_status();
    let fda = fda_status();
    vec![
        PermissionStatus {
            kind: PermissionKind::Notifications,
            state: notifications,
            can_prompt: notifications == PermissionState::NotDetermined,
        },
        PermissionStatus {
            kind: PermissionKind::ScreenRecording,
            state: screen,
            can_prompt: screen != PermissionState::Granted && !platform::screen_prompted(),
        },
        PermissionStatus {
            kind: PermissionKind::Microphone,
            state: microphone,
            can_prompt: microphone == PermissionState::NotDetermined,
        },
        PermissionStatus {
            kind: PermissionKind::FullDiskAccess,
            state: fda,
            can_prompt: false,
        },
        PermissionStatus {
            kind: PermissionKind::FilesAndFolders,
            // Full Disk Access covers them; otherwise macOS asks the first
            // time a command touches each folder, and can't be asked first.
            state: if fda == PermissionState::Granted {
                PermissionState::Granted
            } else {
                PermissionState::Unknown
            },
            can_prompt: false,
        },
        PermissionStatus {
            kind: PermissionKind::Automation,
            state: PermissionState::Unknown,
            can_prompt: false,
        },
    ]
}

fn collect(bundle_id: String) -> PermissionsReport {
    let mut items = butter_items();
    items.extend(rec_status());
    PermissionsReport {
        bundle_id,
        signing: signing_info(),
        items,
    }
}

fn record_path() -> Option<PathBuf> {
    crate::paths::butter_home()
        .ok()
        .map(|dir| dir.join(RECORD_FILE))
}

fn open_url(url: &str) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg(url)
        .status()
        .map_err(|e| format!("open {url}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open {url} failed ({status})"))
    }
}

// ---- Commands -----------------------------------------------------------------

#[tauri::command]
pub async fn permissions_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<PermissionsReport, String> {
    let bundle_id = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || collect(bundle_id))
        .await
        .map_err(|e| format!("permissions task failed: {e}"))
}

/// Shows the system prompt where macOS has one and it hasn't been answered
/// yet; otherwise opens the permission's System Settings pane. Returns
/// "prompted" or "opened_settings".
#[tauri::command]
pub async fn permission_request<R: Runtime>(
    app: AppHandle<R>,
    kind: PermissionKind,
) -> Result<String, String> {
    let bundle_id = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let prompted = match kind {
            PermissionKind::Notifications
                if platform::notification_status() == PermissionState::NotDetermined =>
            {
                platform::request_notifications()
            }
            PermissionKind::Microphone
                if platform::microphone_status() == PermissionState::NotDetermined =>
            {
                platform::request_microphone()
            }
            PermissionKind::ScreenRecording
                if platform::screen_recording_status() != PermissionState::Granted
                    && !platform::screen_prompted() =>
            {
                platform::request_screen_recording(&app)
            }
            _ => false,
        };
        if prompted {
            return Ok("prompted".to_string());
        }
        open_url(&settings_url(kind, &bundle_id))?;
        Ok("opened_settings".to_string())
    })
    .await
    .map_err(|e| format!("permissions task failed: {e}"))?
}

/// `tccutil reset All <bundle id>`: forgets every grant for this flavor, so
/// toggles left on for an older (ad-hoc) build stop pretending to work and
/// macOS asks again.
#[tauri::command]
pub async fn permissions_reset_stale<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let bundle_id = app.config().identifier.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let out = std::process::Command::new("/usr/bin/tccutil")
            .args(["reset", "All", &bundle_id])
            .output()
            .map_err(|e| format!("tccutil: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "tccutil reset All {bundle_id} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    })
    .await
    .map_err(|e| format!("permissions task failed: {e}"))?
}

/// Called once at launch: records the current signature and says whether to
/// open the Permissions view (see `should_auto_show`).
#[tauri::command]
pub async fn permissions_launch_check() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let current = signing_info().requirement;
        let Some(path) = record_path() else {
            return false;
        };
        let previous = std::fs::read_to_string(&path).ok().map(|text| {
            serde_json::from_str::<SigningRecord>(&text)
                .unwrap_or_default()
                .designated_requirement
                .unwrap_or_default()
        });
        let changed = previous.as_deref() != current.as_deref();
        let own_missing = changed && own_kinds_missing(&butter_items());
        let show = should_auto_show(previous.as_deref(), current.as_deref(), own_missing);
        if current.is_some() && changed {
            let record = SigningRecord {
                designated_requirement: current,
            };
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Ok(text) = serde_json::to_string_pretty(&record) {
                if let Err(err) = std::fs::write(&path, text) {
                    eprintln!("[permissions] could not write {}: {err}", path.display());
                }
            }
        }
        show
    })
    .await
    .map_err(|e| format!("permissions task failed: {e}"))
}

// ---- macOS --------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod platform {
    use super::{map_av_status, map_un_status, PermissionState};
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::NSString;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::{AppHandle, Runtime};

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        static AVMediaTypeAudio: &'static NSString;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    #[link(name = "UserNotifications", kind = "framework")]
    extern "C" {}

    /// Long enough for someone to read and answer a prompt.
    const PROMPT_TIMEOUT: Duration = Duration::from_secs(300);

    /// CGRequestScreenCaptureAccess prompts only once per app; after that a
    /// Grant click opens System Settings instead.
    static SCREEN_PROMPTED: AtomicBool = AtomicBool::new(false);

    pub fn screen_prompted() -> bool {
        SCREEN_PROMPTED.load(Ordering::Relaxed)
    }

    pub fn microphone_status() -> PermissionState {
        let Some(cls) = AnyClass::get(c"AVCaptureDevice") else {
            return PermissionState::Unknown;
        };
        let status: isize =
            unsafe { msg_send![cls, authorizationStatusForMediaType: AVMediaTypeAudio] };
        map_av_status(status)
    }

    pub fn request_microphone() -> bool {
        let Some(cls) = AnyClass::get(c"AVCaptureDevice") else {
            return false;
        };
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        unsafe {
            let _: () = msg_send![
                cls,
                requestAccessForMediaType: AVMediaTypeAudio,
                completionHandler: &*block
            ];
        }
        let _ = rx.recv_timeout(PROMPT_TIMEOUT);
        true
    }

    /// No API tells "never asked" from "denied", so false is Denied.
    pub fn screen_recording_status() -> PermissionState {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            PermissionState::Granted
        } else {
            PermissionState::Denied
        }
    }

    pub fn request_screen_recording<R: Runtime>(app: &AppHandle<R>) -> bool {
        SCREEN_PROMPTED.store(true, Ordering::Relaxed);
        app.run_on_main_thread(|| unsafe {
            CGRequestScreenCaptureAccess();
        })
        .is_ok()
    }

    /// UNUserNotificationCenter throws outside an app bundle (cargo test,
    /// `cargo tauri dev`).
    fn notification_center() -> Option<Retained<AnyObject>> {
        super::app_bundle()?;
        let cls = AnyClass::get(c"UNUserNotificationCenter")?;
        unsafe { msg_send![cls, currentNotificationCenter] }
    }

    pub fn notification_status() -> PermissionState {
        let Some(center) = notification_center() else {
            return PermissionState::Unknown;
        };
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |settings: *mut AnyObject| {
            let status: isize = if settings.is_null() {
                -1
            } else {
                unsafe { msg_send![settings, authorizationStatus] }
            };
            let _ = tx.send(status);
        });
        unsafe {
            let _: () = msg_send![&*center, getNotificationSettingsWithCompletionHandler: &*block];
        }
        rx.recv_timeout(Duration::from_secs(2))
            .map(map_un_status)
            .unwrap_or(PermissionState::Unknown)
    }

    pub fn request_notifications() -> bool {
        let Some(center) = notification_center() else {
            return false;
        };
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |granted: Bool, _error: *mut AnyObject| {
            let _ = tx.send(granted.as_bool());
        });
        // UNAuthorizationOptionBadge | Sound | Alert
        let options: usize = 1 | 2 | 4;
        unsafe {
            let _: () = msg_send![
                &*center,
                requestAuthorizationWithOptions: options,
                completionHandler: &*block
            ];
        }
        let _ = rx.recv_timeout(PROMPT_TIMEOUT);
        true
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::PermissionState;
    use tauri::{AppHandle, Runtime};

    pub fn screen_prompted() -> bool {
        true
    }
    pub fn microphone_status() -> PermissionState {
        PermissionState::Unknown
    }
    pub fn request_microphone() -> bool {
        false
    }
    pub fn screen_recording_status() -> PermissionState {
        PermissionState::Unknown
    }
    pub fn request_screen_recording<R: Runtime>(_app: &AppHandle<R>) -> bool {
        false
    }
    pub fn notification_status() -> PermissionState {
        PermissionState::Unknown
    }
    pub fn request_notifications() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn av_and_un_statuses_map() {
        assert_eq!(map_av_status(0), PermissionState::NotDetermined);
        assert_eq!(map_av_status(1), PermissionState::Denied);
        assert_eq!(map_av_status(2), PermissionState::Denied);
        assert_eq!(map_av_status(3), PermissionState::Granted);
        assert_eq!(map_av_status(9), PermissionState::Unknown);
        assert_eq!(map_un_status(0), PermissionState::NotDetermined);
        assert_eq!(map_un_status(1), PermissionState::Denied);
        assert_eq!(map_un_status(2), PermissionState::Granted);
        assert_eq!(map_un_status(3), PermissionState::Granted);
        assert_eq!(map_un_status(4), PermissionState::Granted);
        assert_eq!(map_un_status(-1), PermissionState::Unknown);
    }

    #[test]
    fn rec_statuses_map() {
        assert_eq!(map_rec_status(Some("granted")), PermissionState::Granted);
        assert_eq!(map_rec_status(Some("denied")), PermissionState::Denied);
        assert_eq!(map_rec_status(Some("not granted")), PermissionState::Denied);
        assert_eq!(
            map_rec_status(Some("not requested")),
            PermissionState::NotDetermined
        );
        assert_eq!(map_rec_status(Some("???")), PermissionState::Unknown);
        assert_eq!(map_rec_status(None), PermissionState::Unknown);
    }

    #[test]
    fn fda_probe_maps_errors() {
        let eperm = Err(std::io::Error::from_raw_os_error(libc::EPERM));
        let eacces = Err(std::io::Error::from_raw_os_error(libc::EACCES));
        let enoent = Err(std::io::Error::from_raw_os_error(libc::ENOENT));
        assert_eq!(map_fda_probe(&eperm), PermissionState::Denied);
        assert_eq!(map_fda_probe(&eacces), PermissionState::Denied);
        assert_eq!(map_fda_probe(&enoent), PermissionState::Unknown);
        let file = std::fs::File::open(std::env::current_exe().unwrap());
        assert_eq!(map_fda_probe(&file), PermissionState::Granted);
    }

    #[test]
    fn rec_rows_follow_daemon_reply() {
        let states = |items: Vec<PermissionStatus>| -> Vec<PermissionState> {
            items.into_iter().map(|i| i.state).collect()
        };
        assert_eq!(
            states(rec_items(false, None, true)),
            vec![PermissionState::NotInstalled; 3]
        );
        assert_eq!(
            states(rec_items(true, None, true)),
            vec![PermissionState::NotRunning; 3]
        );
        let reply = serde_json::json!({
            "ok": true,
            "permissions": { "microphone": "granted", "accessibility": "not granted" }
        });
        assert_eq!(
            states(rec_items(true, Some(&reply), true)),
            vec![
                PermissionState::Granted,
                PermissionState::Unknown,
                PermissionState::Denied
            ]
        );
        assert_eq!(
            states(rec_items(true, Some(&reply), false))[2],
            PermissionState::NotNeeded
        );
        let reply = serde_json::json!({ "permissions": { "system_audio": "granted" } });
        assert_eq!(
            states(rec_items(true, Some(&reply), true))[1],
            PermissionState::Granted
        );
    }

    #[test]
    fn accessibility_only_when_dictation_pastes() {
        assert!(rec_wants_accessibility(None));
        assert!(rec_wants_accessibility(Some("")));
        assert!(rec_wants_accessibility(Some(
            "[dictation]\noutput = \"paste\"   # paste | clipboard | none\n"
        )));
        assert!(!rec_wants_accessibility(Some(
            "[dictation]\noutput = \"clipboard\"\n"
        )));
        assert!(!rec_wants_accessibility(Some(
            "[dictation]\noutput = \"none\"\n"
        )));
        assert!(rec_wants_accessibility(Some("not = [valid toml")));
    }

    #[test]
    fn parses_designated_requirements() {
        let adhoc = "Executable=/Applications/Butter.app/Contents/MacOS/butter\n# designated => cdhash H\"e382c00d\"\n";
        assert_eq!(
            parse_designated_requirement(adhoc).as_deref(),
            Some("cdhash H\"e382c00d\"")
        );
        assert!(is_ad_hoc_requirement(
            &parse_designated_requirement(adhoc).unwrap()
        ));
        let signed = "designated => identifier \"com.butter.app\" and anchor apple generic and certificate leaf[subject.CN] = \"Apple Development: a@b.c (QC7TVYBFM6)\" and certificate 1[field.1.2.840.113635.100.6.2.1] /* exists */\n";
        let req = parse_designated_requirement(signed).unwrap();
        assert!(req.starts_with("identifier \"com.butter.app\""));
        assert!(!is_ad_hoc_requirement(&req));
        assert_eq!(
            parse_designated_requirement("code object is not signed at all"),
            None
        );
    }

    #[test]
    fn auto_show_decision() {
        let a = Some("identifier \"com.butter.app\" and anchor apple generic");
        let b = Some("cdhash H\"1234\"");
        // First launch ever: show, whatever is granted.
        assert!(should_auto_show(None, a, false));
        assert!(should_auto_show(None, a, true));
        // Same signature: never.
        assert!(!should_auto_show(a, a, true));
        // Changed: only if one of Butter's own permissions is missing.
        assert!(should_auto_show(b, a, true));
        assert!(!should_auto_show(b, a, false));
        // Unbundled dev binary: never.
        assert!(!should_auto_show(None, None, true));
        assert!(!should_auto_show(a, None, true));
    }

    #[test]
    fn settings_urls() {
        assert_eq!(
            settings_url(PermissionKind::FullDiskAccess, "com.butter.app"),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
        );
        assert_eq!(
            settings_url(PermissionKind::RecSystemAudio, "com.butter.app"),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture"
        );
        assert_eq!(
            settings_url(PermissionKind::Notifications, "com.butter.app.dev"),
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.butter.app.dev"
        );
    }

    /// Runs the real probes (none of them prompt). Outside a bundle the
    /// notification state is Unknown and there's no signature.
    /// `cargo test --lib permissions::tests::live_probes -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_probes() {
        let report = collect("com.butter.app".to_string());
        for item in &report.items {
            println!(
                "{:?}: {:?} (prompt: {})",
                item.kind, item.state, item.can_prompt
            );
        }
        println!("signing: {:?}", report.signing);
        assert_eq!(report.items.len(), 9);
        // Already answered, so this calls back at once without a prompt.
        if platform::microphone_status() == PermissionState::Granted {
            assert!(platform::request_microphone());
        }
    }

    #[test]
    fn own_permissions_missing() {
        let item = |kind, state| PermissionStatus {
            kind,
            state,
            can_prompt: false,
        };
        let mut items = vec![
            item(PermissionKind::Notifications, PermissionState::Granted),
            item(PermissionKind::ScreenRecording, PermissionState::Granted),
            item(PermissionKind::Microphone, PermissionState::Granted),
            item(PermissionKind::FullDiskAccess, PermissionState::Denied),
            item(PermissionKind::RecMicrophone, PermissionState::NotRunning),
        ];
        assert!(!own_kinds_missing(&items));
        items[2].state = PermissionState::NotDetermined;
        assert!(own_kinds_missing(&items));
    }
}
