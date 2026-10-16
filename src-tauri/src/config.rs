use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Get the config file path: ~/.config/butter/config.toml
/// (~/.config/butter-dev/config.toml in the dev flavor).
pub fn config_path() -> PathBuf {
    crate::paths::butter_config_dir()
        .expect("Could not find home directory")
        .join("config.toml")
}

/// Main configuration structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_version")]
    pub version: u32,

    #[serde(default)]
    pub general: GeneralConfig,

    #[serde(default)]
    pub appearance: AppearanceConfig,

    #[serde(default)]
    pub ui: UiConfig,

    #[serde(default)]
    pub presets: PresetsConfig,

    #[serde(default)]
    pub tags: TagsConfig,

    /// Optional TypeSafe (Jev) ranker for composer suggestions:
    /// `[typesafe]` with `api_key`, `model`, `timeout_ms`, `enabled`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typesafe: Option<TypesafeConfig>,
}

/// `[typesafe]` section. `api_key` falls back to the `TYPESAFE_API_KEY`
/// environment variable. Debug output redacts the key.
#[derive(Clone, Serialize, Deserialize)]
pub struct TypesafeConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,

    #[serde(default = "default_jev_model")]
    pub model: String,

    #[serde(default = "default_jev_timeout_ms")]
    pub timeout_ms: u64,

    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_jev_model() -> String {
    "jev-latest".to_string()
}

fn default_jev_timeout_ms() -> u64 {
    300
}

impl Default for TypesafeConfig {
    fn default() -> Self {
        Self {
            api_key: None,
            model: default_jev_model(),
            timeout_ms: default_jev_timeout_ms(),
            enabled: true,
        }
    }
}

impl std::fmt::Debug for TypesafeConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TypesafeConfig")
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("model", &self.model)
            .field("timeout_ms", &self.timeout_ms)
            .field("enabled", &self.enabled)
            .finish()
    }
}

impl TypesafeConfig {
    /// Copy without the secret, for handing config to the webview.
    pub fn redacted(&self) -> Self {
        Self {
            api_key: None,
            ..self.clone()
        }
    }
}

fn default_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneralConfig {
    #[serde(default = "default_shell")]
    pub default_shell: String,

    #[serde(default = "default_directory")]
    pub default_directory: String,

    #[serde(default = "default_true")]
    pub confirm_close_with_running_process: bool,
}

fn default_shell() -> String {
    "/bin/zsh".to_string()
}

fn default_directory() -> String {
    "~".to_string()
}

fn default_true() -> bool {
    true
}

impl Default for GeneralConfig {
    fn default() -> Self {
        Self {
            default_shell: default_shell(),
            default_directory: default_directory(),
            confirm_close_with_running_process: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppearanceConfig {
    #[serde(default = "default_font_family")]
    pub font_family: String,

    #[serde(default = "default_font_size")]
    pub font_size: u32,

    #[serde(default = "default_line_height")]
    pub line_height: f32,

    #[serde(default = "default_cursor_style")]
    pub cursor_style: String,

    #[serde(default = "default_true")]
    pub cursor_blink: bool,

    #[serde(default)]
    pub theme: ThemeConfig,
}

fn default_font_family() -> String {
    "SF Mono".to_string()
}

fn default_font_size() -> u32 {
    14
}

fn default_line_height() -> f32 {
    1.3
}

fn default_cursor_style() -> String {
    "block".to_string()
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            font_family: default_font_family(),
            font_size: default_font_size(),
            line_height: default_line_height(),
            cursor_style: default_cursor_style(),
            cursor_blink: true,
            theme: ThemeConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemeConfig {
    #[serde(default = "default_background")]
    pub background: String,

    #[serde(default = "default_foreground")]
    pub foreground: String,

    #[serde(default = "default_cursor_color")]
    pub cursor: String,

    #[serde(default = "default_selection")]
    pub selection: String,

    // ANSI colors
    #[serde(default = "default_black")]
    pub black: String,

    #[serde(default = "default_red")]
    pub red: String,

    #[serde(default = "default_green")]
    pub green: String,

    #[serde(default = "default_yellow")]
    pub yellow: String,

    #[serde(default = "default_blue")]
    pub blue: String,

    #[serde(default = "default_magenta")]
    pub magenta: String,

    #[serde(default = "default_cyan")]
    pub cyan: String,

    #[serde(default = "default_white")]
    pub white: String,
}

fn default_background() -> String {
    "#27272a".to_string()
}

fn default_foreground() -> String {
    "#d4d4d8".to_string()
}

fn default_cursor_color() -> String {
    "#F5D76E".to_string()
}

fn default_selection() -> String {
    "#3f3f46".to_string()
}

fn default_black() -> String {
    "#27272a".to_string()
}

fn default_red() -> String {
    "#ef4444".to_string()
}

fn default_green() -> String {
    "#22c55e".to_string()
}

fn default_yellow() -> String {
    "#eab308".to_string()
}

fn default_blue() -> String {
    "#3b82f6".to_string()
}

fn default_magenta() -> String {
    "#a855f7".to_string()
}

fn default_cyan() -> String {
    "#06b6d4".to_string()
}

fn default_white() -> String {
    "#e4e4e7".to_string()
}

impl Default for ThemeConfig {
    fn default() -> Self {
        Self {
            background: default_background(),
            foreground: default_foreground(),
            cursor: default_cursor_color(),
            selection: default_selection(),
            black: default_black(),
            red: default_red(),
            green: default_green(),
            yellow: default_yellow(),
            blue: default_blue(),
            magenta: default_magenta(),
            cyan: default_cyan(),
            white: default_white(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiConfig {
    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: u32,

    #[serde(default)]
    pub show_tags_by_default: bool,
}

fn default_sidebar_width() -> u32 {
    240
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            sidebar_width: default_sidebar_width(),
            show_tags_by_default: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetsConfig {
    #[serde(default)]
    pub items: Vec<Preset>,
}

impl Default for PresetsConfig {
    fn default() -> Self {
        Self { items: vec![] }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preset {
    pub id: String,
    pub name: String,

    #[serde(default)]
    pub directory: Option<String>,

    #[serde(default)]
    pub command: Option<String>,

    #[serde(default)]
    pub tags: Vec<String>,

    #[serde(default)]
    pub footer: bool,

    #[serde(default)]
    pub worktree: bool,

    /// browser.toml profile for this preset's browser pane ("default" when
    /// unset or unknown).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagsConfig {
    #[serde(default)]
    pub list: Vec<String>,
}

impl Default for TagsConfig {
    fn default() -> Self {
        Self {
            list: vec![
                "urgent".to_string(),
                "planning".to_string(),
                "random".to_string(),
            ],
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            general: GeneralConfig::default(),
            appearance: AppearanceConfig::default(),
            ui: UiConfig::default(),
            presets: PresetsConfig::default(),
            tags: TagsConfig::default(),
            typesafe: None,
        }
    }
}

/// Load config from file, or create default if it doesn't exist
pub fn load_config() -> Result<Config, String> {
    let path = config_path();

    if path.exists() {
        let content =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read config file: {}", e))?;

        let config: Config =
            toml::from_str(&content).map_err(|e| format!("Failed to parse config file: {}", e))?;

        Ok(config)
    } else {
        // Create default config and save it
        let config = Config::default();
        save_config(&config)?;
        Ok(config)
    }
}

/// Save config to file
pub fn save_config(config: &Config) -> Result<(), String> {
    let path = config_path();

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    let content =
        toml::to_string_pretty(config).map_err(|e| format!("Failed to serialize config: {}", e))?;

    // Add header comment
    let content_with_header = format!(
        "# Butter Configuration\n# Edit this file to customize your terminal experience\n# Restart the app to apply changes\n\n{}",
        content
    );

    fs::write(&path, content_with_header)
        .map_err(|e| format!("Failed to write config file: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typesafe_section_roundtrips_and_redacts() {
        let raw = "version = 1\n[typesafe]\napi_key = \"secret-value\"\ntimeout_ms = 450\n";
        let cfg: Config = toml::from_str(raw).unwrap();
        let ts = cfg.typesafe.clone().unwrap();
        assert_eq!(ts.api_key.as_deref(), Some("secret-value"));
        assert_eq!(ts.model, "jev-latest");
        assert_eq!(ts.timeout_ms, 450);
        assert!(ts.enabled);
        assert!(!format!("{:?}", cfg).contains("secret-value"));
        assert!(ts.redacted().api_key.is_none());
        let out = toml::to_string_pretty(&cfg).unwrap();
        assert!(out.contains("[typesafe]"));
        let none: Config = toml::from_str("version = 1\n").unwrap();
        assert!(none.typesafe.is_none());
        assert!(!toml::to_string_pretty(&none).unwrap().contains("typesafe"));
    }
}
