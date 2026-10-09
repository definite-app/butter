//! Map a running Codex CLI to the conversation (thread) it is writing.
//!
//! Codex keeps one writer lock per open thread at
//! `~/.codex/thread-writer-locks/<thread-id>.lock`, held open by the process
//! that writes that thread. So `lsof` on the processes under a terminal's shell
//! tells us exactly which conversation that terminal runs, even when several
//! terminals run Codex in the same directory. (Matching rollouts by cwd, the
//! old approach, gave every such terminal the same "latest" conversation.)

use std::collections::{HashMap, HashSet};
use std::process::Command;

const THREAD_LOCK_DIR: &str = "/.codex/thread-writer-locks/";

/// The Codex conversation a terminal is running.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexThread {
    pub thread_id: String,
    /// Working directory of the Codex process that holds the thread.
    pub cwd: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct ProcFiles {
    cwd: Option<String>,
    /// (fd number, thread id) for every thread writer lock the process holds.
    thread_locks: Vec<(u32, String)>,
}

/// Parse `lsof -F pfn` output into per-pid cwd + held thread locks.
fn parse_lsof(output: &str) -> HashMap<u32, ProcFiles> {
    let mut out: HashMap<u32, ProcFiles> = HashMap::new();
    let mut pid: Option<u32> = None;
    let mut fd: Option<String> = None;
    for line in output.lines() {
        let Some(tag) = line.chars().next() else {
            continue;
        };
        let value = &line[tag.len_utf8()..];
        match tag {
            'p' => {
                pid = value.parse().ok();
                fd = None;
                if let Some(p) = pid {
                    out.entry(p).or_default();
                }
            }
            'f' => fd = Some(value.to_string()),
            'n' => {
                let (Some(p), Some(f)) = (pid, fd.as_deref()) else {
                    continue;
                };
                let entry = out.entry(p).or_default();
                if f == "cwd" {
                    entry.cwd = Some(value.to_string());
                } else if let Some(id) = thread_id_from_lock_path(value) {
                    let fd_num = f
                        .trim_end_matches(|c: char| !c.is_ascii_digit())
                        .parse()
                        .unwrap_or(u32::MAX);
                    entry.thread_locks.push((fd_num, id));
                }
            }
            _ => {}
        }
    }
    out
}

fn thread_id_from_lock_path(path: &str) -> Option<String> {
    let idx = path.find(THREAD_LOCK_DIR)?;
    let name = &path[idx + THREAD_LOCK_DIR.len()..];
    let id = name.strip_suffix(".lock")?;
    // Skip `.coordination.lock` and anything that isn't a plain id.
    if id.is_empty() || id.starts_with('.') || id.contains('/') {
        return None;
    }
    Some(id.to_string())
}

fn is_uuid_v7(id: &str) -> bool {
    id.len() == 36 && id.as_bytes().get(14) == Some(&b'7')
}

/// Pick the top-level conversation when one process holds several thread
/// locks (multi-agent Codex also writes its sub-agent threads). Sub-agents are
/// always spawned after their parent, so with time-ordered UUIDv7 ids the
/// smallest id is the root; otherwise fall back to the earliest-opened fd.
fn pick_root_thread(locks: &[(u32, String)]) -> Option<String> {
    if locks.is_empty() {
        return None;
    }
    if locks.iter().all(|(_, id)| is_uuid_v7(id)) {
        return locks.iter().map(|(_, id)| id.clone()).min();
    }
    locks
        .iter()
        .min_by_key(|(fd, _)| *fd)
        .map(|(_, id)| id.clone())
}

/// All descendants of `root` (not including `root`), given (pid, ppid) pairs.
fn descendants(root: u32, table: &[(u32, u32)]) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(pid, ppid) in table {
        children.entry(ppid).or_default().push(pid);
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut stack = vec![root];
    while let Some(p) = stack.pop() {
        if let Some(kids) = children.get(&p) {
            for &k in kids {
                if seen.insert(k) {
                    out.push(k);
                    stack.push(k);
                }
            }
        }
    }
    out
}

fn parse_ps(output: &str) -> Vec<(u32, u32)> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let ppid = parts.next()?.parse().ok()?;
            Some((pid, ppid))
        })
        .collect()
}

/// Given descendants per shell and lsof data, choose each shell's thread.
fn threads_for_shells(
    shell_descendants: &HashMap<u32, Vec<u32>>,
    files: &HashMap<u32, ProcFiles>,
) -> HashMap<u32, CodexThread> {
    let mut out = HashMap::new();
    for (&shell, pids) in shell_descendants {
        let mut locks: Vec<(u32, String)> = Vec::new();
        let mut cwd_by_thread: HashMap<String, Option<String>> = HashMap::new();
        for pid in pids {
            let Some(pf) = files.get(pid) else { continue };
            for (fd, id) in &pf.thread_locks {
                locks.push((*fd, id.clone()));
                cwd_by_thread
                    .entry(id.clone())
                    .or_insert_with(|| pf.cwd.clone());
            }
        }
        if let Some(thread_id) = pick_root_thread(&locks) {
            let cwd = cwd_by_thread.get(&thread_id).cloned().flatten();
            out.insert(shell, CodexThread { thread_id, cwd });
        }
    }
    out
}

/// Resolve the Codex conversation running under each shell pid. Shells with no
/// Codex thread lock (no codex running, or an older Codex without writer
/// locks) are absent from the result.
pub fn resolve_codex_threads(shell_pids: &[u32]) -> HashMap<u32, CodexThread> {
    if shell_pids.is_empty() {
        return HashMap::new();
    }
    let Ok(ps) = Command::new("ps").args(["-axo", "pid=,ppid="]).output() else {
        return HashMap::new();
    };
    let table = parse_ps(&String::from_utf8_lossy(&ps.stdout));
    let mut shell_descendants: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut all: Vec<u32> = Vec::new();
    for &shell in shell_pids {
        let kids = descendants(shell, &table);
        all.extend(kids.iter().copied());
        shell_descendants.insert(shell, kids);
    }
    if all.is_empty() {
        return HashMap::new();
    }
    let pid_list = all
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(",");
    // lsof exits non-zero when some pids vanished mid-scan; its stdout is still
    // valid for the rest, so ignore the status.
    let Ok(lsof) = Command::new("lsof")
        .args(["-n", "-P", "-w", "-F", "pfn", "-p", &pid_list])
        .output()
    else {
        return HashMap::new();
    };
    let files = parse_lsof(&String::from_utf8_lossy(&lsof.stdout));
    threads_for_shells(&shell_descendants, &files)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LSOF: &str = "p100\nfcwd\nn/Users/me/proj\nf3u\nn/Users/me/.codex/tmp/arg0/x/.lock\nf45u\nn/Users/me/.codex/thread-writer-locks/01a0d2e2-5cb0-7710-a3cf-f59afdca75a6.lock\nf46u\nn/Users/me/.codex/thread-writer-locks/.coordination.lock\np200\nfcwd\nn/Users/me/other\nf44u\nn/Users/me/.codex/thread-writer-locks/01a0900e-562f-7ec1-a1e2-c93d107f0476.lock\n";

    #[test]
    fn parses_thread_locks_and_cwd_per_pid() {
        let files = parse_lsof(LSOF);
        let a = files.get(&100).unwrap();
        assert_eq!(a.cwd.as_deref(), Some("/Users/me/proj"));
        assert_eq!(
            a.thread_locks,
            vec![(45, "01a0d2e2-5cb0-7710-a3cf-f59afdca75a6".to_string())]
        );
        let b = files.get(&200).unwrap();
        assert_eq!(b.cwd.as_deref(), Some("/Users/me/other"));
        assert_eq!(b.thread_locks.len(), 1);
    }

    #[test]
    fn two_terminals_in_same_cwd_get_distinct_threads() {
        // Shell 10 -> node 11 -> codex 100; shell 20 -> node 21 -> codex 200.
        let table = parse_ps("10 1\n11 10\n100 11\n20 1\n21 20\n200 21\n300 100\n");
        let mut per_shell = HashMap::new();
        per_shell.insert(10, descendants(10, &table));
        per_shell.insert(20, descendants(20, &table));
        let mut files = parse_lsof(LSOF);
        // Same cwd for both, like several codex tabs in one repo.
        files.get_mut(&200).unwrap().cwd = Some("/Users/me/proj".into());
        let threads = threads_for_shells(&per_shell, &files);
        assert_eq!(
            threads.get(&10).unwrap().thread_id,
            "01a0d2e2-5cb0-7710-a3cf-f59afdca75a6"
        );
        assert_eq!(
            threads.get(&20).unwrap().thread_id,
            "01a0900e-562f-7ec1-a1e2-c93d107f0476"
        );
        assert_eq!(threads.get(&10).unwrap().cwd.as_deref(), Some("/Users/me/proj"));
    }

    #[test]
    fn shell_without_codex_has_no_thread() {
        let table = parse_ps("10 1\n11 10\n");
        let mut per_shell = HashMap::new();
        per_shell.insert(10, descendants(10, &table));
        let threads = threads_for_shells(&per_shell, &parse_lsof(LSOF));
        assert!(threads.is_empty());
    }

    #[test]
    fn root_thread_wins_over_subagent_threads() {
        // Sub-agent (newer v7 id) opened on a lower fd after a reuse.
        let locks = vec![
            (40, "01a0d332-1c99-73a0-a570-4161d654d388".to_string()),
            (44, "01a0d2e2-5cb0-7710-a3cf-f59afdca75a6".to_string()),
        ];
        assert_eq!(
            pick_root_thread(&locks).as_deref(),
            Some("01a0d2e2-5cb0-7710-a3cf-f59afdca75a6")
        );
        // Non-v7 ids fall back to the earliest-opened fd.
        let v4 = vec![
            (50, "f47ac10b-58cc-4372-a567-0e02b2c3d479".to_string()),
            (41, "a47ac10b-58cc-4372-a567-0e02b2c3d479".to_string()),
        ];
        assert_eq!(
            pick_root_thread(&v4).as_deref(),
            Some("a47ac10b-58cc-4372-a567-0e02b2c3d479")
        );
    }

    #[test]
    fn ignores_non_thread_lock_files() {
        assert_eq!(thread_id_from_lock_path("/x/.codex/thread-writer-locks/.coordination.lock"), None);
        assert_eq!(thread_id_from_lock_path("/x/.codex/logs_2.sqlite"), None);
        assert_eq!(
            thread_id_from_lock_path("/x/.codex/thread-writer-locks/abc.lock").as_deref(),
            Some("abc")
        );
    }
}

