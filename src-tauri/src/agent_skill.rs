//! Installs the `butter-cli` agent skill (.claude/skills/butter-cli in this
//! repo) into the user's Claude Code and Codex skill folders on every launch,
//! so agents anywhere, not just in this repo, know about routines, 1thread
//! replies and Team Mode. Like the `butter-cli` shim, it's rewritten each
//! launch so it tracks the installed Butter.

use std::fs;
use std::path::{Path, PathBuf};

const SKILL_NAME: &str = "butter-cli";
const SKILL_MD: &str = include_str!("../../.claude/skills/butter-cli/SKILL.md");
const OPENAI_YAML: &str = include_str!("../../.claude/skills/butter-cli/agents/openai.yaml");

/// Appended to the installed SKILL.md. A copy without it is the user's own,
/// and Butter leaves it alone.
const MARKER: &str =
    "<!-- Installed by Butter, which rewrites this file on every launch. Delete this line to keep your own version. -->";

/// Skill folders for the agent CLIs this machine has: `~/.claude/skills`
/// (or `$CLAUDE_CONFIG_DIR/skills`) and `~/.codex/skills` (or `$CODEX_HOME`).
/// A tool whose config folder doesn't exist is skipped.
fn skill_roots() -> Vec<PathBuf> {
    let home = dirs::home_dir();
    let from_env = |var: &str| std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from);
    [
        from_env("CLAUDE_CONFIG_DIR").or_else(|| home.as_ref().map(|h| h.join(".claude"))),
        from_env("CODEX_HOME").or_else(|| home.as_ref().map(|h| h.join(".codex"))),
    ]
    .into_iter()
    .flatten()
    .filter(|dir| dir.is_dir())
    .map(|dir| dir.join("skills"))
    .collect()
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if fs::read_to_string(path).is_ok_and(|existing| existing == content) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    fs::write(path, content).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

/// Writes the skill under `root`. Returns false when the user has their own
/// copy there (a SKILL.md without Butter's marker).
fn install_into(root: &Path) -> Result<bool, String> {
    let dir = root.join(SKILL_NAME);
    let skill_path = dir.join("SKILL.md");
    if let Ok(existing) = fs::read_to_string(&skill_path) {
        if !existing.contains(MARKER) {
            return Ok(false);
        }
    }
    write_if_changed(&skill_path, &format!("{}\n{MARKER}\n", SKILL_MD.trim_end()))?;
    write_if_changed(&dir.join("agents").join("openai.yaml"), OPENAI_YAML)?;
    Ok(true)
}

pub fn install_agent_skill() {
    for root in skill_roots() {
        match install_into(&root) {
            Ok(true) => {}
            Ok(false) => eprintln!(
                "[skill] keeping the user's own {} skill in {}",
                SKILL_NAME,
                root.display()
            ),
            Err(err) => eprintln!("[skill] could not install the {SKILL_NAME} skill: {err}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_updates_and_respects_a_users_own_copy() {
        let root = std::env::temp_dir().join(format!("butter-skill-test-{}", uuid::Uuid::new_v4()));
        let skill = root.join(SKILL_NAME).join("SKILL.md");

        assert!(install_into(&root).unwrap());
        let installed = fs::read_to_string(&skill).unwrap();
        assert!(installed.starts_with("---\nname: butter-cli\n"));
        assert!(installed.contains("butter-cli routine create"));
        assert!(installed.trim_end().ends_with(MARKER));
        assert!(root.join(SKILL_NAME).join("agents/openai.yaml").is_file());

        // An older Butter's copy is replaced.
        fs::write(&skill, format!("old\n{MARKER}\n")).unwrap();
        assert!(install_into(&root).unwrap());
        assert_eq!(fs::read_to_string(&skill).unwrap(), installed);

        // The user's own copy (no marker) is kept.
        fs::write(&skill, "my version").unwrap();
        assert!(!install_into(&root).unwrap());
        assert_eq!(fs::read_to_string(&skill).unwrap(), "my version");

        let _ = fs::remove_dir_all(&root);
    }
}
