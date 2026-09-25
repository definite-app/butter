//! Central place for every Butter-owned path under the home directory.
//!
//! Butter ships in two build flavors:
//! - release (default): `~/.butter`, `~/.config/butter`, `/tmp/butter-*`
//! - dev (`--features dev-flavor`, see `tauri.dev.conf.json`):
//!   `~/.butter-dev`, `~/.config/butter-dev`, `/tmp/butter-dev-*`
//!
//! The dev flavor ("Butter Dev", bundle id `com.butter.app.dev`) runs side by
//! side with the installed Butter.app, so it must never write to the release
//! locations. Data owned by other tools (`~/.claude`, `~/.codex`, ...) is NOT
//! routed through here and stays shared on purpose.

use std::path::{Path, PathBuf};

/// True when this binary was built as the "Butter Dev" flavor.
pub const IS_DEV_FLAVOR: bool = cfg!(feature = "dev-flavor");

/// Flavor name exposed to the frontend ("dev" or "release").
pub fn flavor() -> &'static str {
    if IS_DEV_FLAVOR {
        "dev"
    } else {
        "release"
    }
}

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())
}

/// `<home>/.butter` (release) or `<home>/.butter-dev` (dev).
pub fn butter_home_in(home: &Path, dev: bool) -> PathBuf {
    home.join(if dev { ".butter-dev" } else { ".butter" })
}

/// `<home>/.config/butter` (release) or `<home>/.config/butter-dev` (dev).
pub fn butter_config_dir_in(home: &Path, dev: bool) -> PathBuf {
    home.join(".config")
        .join(if dev { "butter-dev" } else { "butter" })
}

/// Butter's data dir for this flavor (agent.db, CLI shims).
pub fn butter_home() -> Result<PathBuf, String> {
    Ok(butter_home_in(&home()?, IS_DEV_FLAVOR))
}

/// Butter's config dir for this flavor (config.toml, notes, paste images, ...).
pub fn butter_config_dir() -> Result<PathBuf, String> {
    Ok(butter_config_dir_in(&home()?, IS_DEV_FLAVOR))
}

/// Namespace a temp/log file name that starts with `butter` so the two flavors
/// never share it: `butter-activity.log` -> `butter-dev-activity.log` in dev.
pub fn flavored_name_for(name: &str, dev: bool) -> String {
    if dev {
        if let Some(rest) = name.strip_prefix("butter") {
            return format!("butter-dev{rest}");
        }
    }
    name.to_string()
}

pub fn flavored_name(name: &str) -> String {
    flavored_name_for(name, IS_DEV_FLAVOR)
}

/// Guard for deleting files whose paths come from the database. In the dev
/// flavor the database is seeded from the release one, so it can reference
/// files that belong to the release app; only delete inside dev-owned dirs.
/// Always true in the release flavor (unchanged behavior).
pub fn may_delete(path: &Path) -> bool {
    if !IS_DEV_FLAVOR {
        return true;
    }
    let Ok(home) = home() else {
        return false;
    };
    path_is_dev_owned(path, &home)
}

fn path_is_dev_owned(path: &Path, home: &Path) -> bool {
    path.starts_with(butter_home_in(home, true))
        || path.starts_with(butter_config_dir_in(home, true))
}

/// Dev flavor only: on first launch, seed `~/.butter-dev/agent.db` and
/// `~/.config/butter-dev/config.toml` from the release app's files so real
/// sessions can be tested. Never writes to the release files. No-op in the
/// release flavor or once the dev files exist.
pub fn seed_dev_flavor_data() {
    if !IS_DEV_FLAVOR {
        return;
    }
    let Ok(home) = home() else {
        return;
    };
    let real_db = butter_home_in(&home, false).join("agent.db");
    let dev_db = butter_home_in(&home, true).join("agent.db");
    match seed_sqlite_copy(&real_db, &dev_db) {
        Ok(true) => eprintln!(
            "[butter-dev] seeded {} from {}",
            dev_db.display(),
            real_db.display()
        ),
        Ok(false) => {}
        Err(err) => eprintln!("[butter-dev] could not seed agent.db: {err}"),
    }

    let real_cfg = butter_config_dir_in(&home, false).join("config.toml");
    let dev_cfg = butter_config_dir_in(&home, true).join("config.toml");
    if real_cfg.is_file() && !dev_cfg.exists() {
        let result = dev_cfg
            .parent()
            .map(std::fs::create_dir_all)
            .unwrap_or(Ok(()))
            .and_then(|_| std::fs::copy(&real_cfg, &dev_cfg).map(|_| ()));
        if let Err(err) = result {
            eprintln!("[butter-dev] could not seed config.toml: {err}");
        }
    }
}

/// Copy a live SQLite database consistently without writing to it.
///
/// Opens `src` read-only, takes a SHARED lock with a read transaction (so no
/// writer can commit and no hot journal exists), clones the file (APFS
/// clonefile, near-instant), then releases the lock. The copy is written to a
/// temp name and renamed into place. Returns Ok(false) when there is nothing
/// to do (`dst` exists or `src` is missing).
pub fn seed_sqlite_copy(src: &Path, dst: &Path) -> Result<bool, String> {
    use rusqlite::{Connection, OpenFlags};

    if dst.exists() || !src.is_file() {
        return Ok(false);
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let tmp = dst.with_extension("db.seeding");
    let _ = std::fs::remove_file(&tmp);

    let conn = Connection::open_with_flags(
        src,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("open {} read-only: {e}", src.display()))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("busy_timeout: {e}"))?;
    conn.execute_batch("BEGIN DEFERRED")
        .map_err(|e| format!("begin: {e}"))?;
    let copy_result = conn
        .query_row("SELECT count(*) FROM sqlite_master", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|e| format!("read lock: {e}"))
        .and_then(|_| {
            std::fs::copy(src, &tmp).map_err(|e| format!("copy to {}: {e}", tmp.display()))
        });
    let _ = conn.execute_batch("COMMIT");
    drop(conn);
    if let Err(err) = copy_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }

    // Sanity check the copy before putting it in place.
    let check = Connection::open(&tmp)
        .and_then(|c| c.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)));
    match check {
        Ok(ref s) if s == "ok" => {}
        other => {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("seeded copy failed quick_check: {other:?}"));
        }
    }
    std::fs::rename(&tmp, dst).map_err(|e| format!("rename into {}: {e}", dst.display()))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_paths() {
        let home = Path::new("/Users/me");
        assert_eq!(
            butter_home_in(home, false),
            PathBuf::from("/Users/me/.butter")
        );
        assert_eq!(
            butter_config_dir_in(home, false),
            PathBuf::from("/Users/me/.config/butter")
        );
        assert_eq!(
            flavored_name_for("butter-activity.log", false),
            "butter-activity.log"
        );
    }

    #[test]
    fn dev_paths() {
        let home = Path::new("/Users/me");
        assert_eq!(
            butter_home_in(home, true),
            PathBuf::from("/Users/me/.butter-dev")
        );
        assert_eq!(
            butter_config_dir_in(home, true),
            PathBuf::from("/Users/me/.config/butter-dev")
        );
        assert_eq!(
            flavored_name_for("butter-activity.log", true),
            "butter-dev-activity.log"
        );
        assert_eq!(
            flavored_name_for("butter_cc_search.py", true),
            "butter-dev_cc_search.py"
        );
        assert_eq!(flavored_name_for("other.log", true), "other.log");
    }

    #[test]
    fn dev_delete_guard_only_allows_dev_dirs() {
        let home = Path::new("/Users/me");
        assert!(path_is_dev_owned(
            Path::new("/Users/me/.config/butter-dev/clipboard-history/a.png"),
            home
        ));
        assert!(path_is_dev_owned(
            Path::new("/Users/me/.butter-dev/bin/x"),
            home
        ));
        assert!(!path_is_dev_owned(
            Path::new("/Users/me/.config/butter/clipboard-history/a.png"),
            home
        ));
        assert!(!path_is_dev_owned(
            Path::new("/Users/me/.butter/agent.db"),
            home
        ));
    }

    #[test]
    fn this_build_matches_flavor() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(butter_home().unwrap(), butter_home_in(&home, IS_DEV_FLAVOR));
        assert_eq!(
            butter_config_dir().unwrap(),
            butter_config_dir_in(&home, IS_DEV_FLAVOR)
        );
    }

    #[test]
    fn seed_copy_is_consistent_and_leaves_source_untouched() {
        let dir = std::env::temp_dir().join(format!("butter-paths-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("real.db");
        let dst = dir.join("dev").join("agent.db");
        {
            let c = rusqlite::Connection::open(&src).unwrap();
            c.execute_batch("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1), (2);")
                .unwrap();
        }
        let before = std::fs::read(&src).unwrap();
        assert!(seed_sqlite_copy(&src, &dst).unwrap());
        let n: i64 = rusqlite::Connection::open(&dst)
            .unwrap()
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
        assert_eq!(std::fs::read(&src).unwrap(), before);
        // Second call is a no-op because the destination exists.
        assert!(!seed_sqlite_copy(&src, &dst).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
