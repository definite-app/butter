//! Read a running process's argv, so resume can keep the flags an agent was
//! really started with (an alias such as `cc` hides them from the launch
//! command).
//!
//! macOS: `sysctl(KERN_PROCARGS2)` returns the exact argv words, unlike
//! `ps -o args=`, which joins them with spaces and loses quoting. It works for
//! processes of the same user, which is all Butter's terminals run.

/// Parse a `KERN_PROCARGS2` buffer: a native-endian `int argc`, the exec path
/// (NUL-terminated, then NUL padding), then `argc` NUL-terminated argv words,
/// then the environment (ignored).
pub fn parse_procargs2(buf: &[u8]) -> Option<Vec<String>> {
    if buf.len() < 4 {
        return None;
    }
    let argc = i32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]);
    if argc <= 0 {
        return None;
    }
    let mut pos = 4;
    // Skip the exec path.
    while pos < buf.len() && buf[pos] != 0 {
        pos += 1;
    }
    // Skip the NUL padding after it.
    while pos < buf.len() && buf[pos] == 0 {
        pos += 1;
    }
    let mut argv = Vec::with_capacity(argc as usize);
    for _ in 0..argc {
        if pos >= buf.len() {
            return None;
        }
        let end = buf[pos..]
            .iter()
            .position(|&b| b == 0)
            .map_or(buf.len(), |i| pos + i);
        argv.push(String::from_utf8_lossy(&buf[pos..end]).into_owned());
        pos = end + 1;
    }
    Some(argv)
}

/// The argv of process `pid`, or None if it can't be read (gone, or not ours).
#[cfg(target_os = "macos")]
pub fn process_argv(pid: u32) -> Option<Vec<String>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    let mut size: libc::size_t = 0;
    // First call asks for the buffer size.
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || size == 0 {
        return None;
    }
    let mut buf = vec![0u8; size];
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            buf.as_mut_ptr() as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return None;
    }
    buf.truncate(size);
    parse_procargs2(&buf)
}

#[cfg(not(target_os = "macos"))]
pub fn process_argv(_pid: u32) -> Option<Vec<String>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn procargs(exec_path: &str, argv: &[&str], env: &[&str]) -> Vec<u8> {
        let mut buf = (argv.len() as i32).to_ne_bytes().to_vec();
        buf.extend_from_slice(exec_path.as_bytes());
        buf.extend_from_slice(&[0, 0, 0, 0]); // terminator + padding
        for word in argv.iter().chain(env) {
            buf.extend_from_slice(word.as_bytes());
            buf.push(0);
        }
        buf
    }

    #[test]
    fn parses_argv_words_exactly() {
        let buf = procargs(
            "/Users/me/.local/share/claude/versions/2.1.0",
            &["claude", "--model", "opus", "fix the bug"],
            &["HOME=/Users/me"],
        );
        assert_eq!(
            parse_procargs2(&buf).unwrap(),
            vec!["claude", "--model", "opus", "fix the bug"]
        );
    }

    #[test]
    fn keeps_empty_words_and_stops_at_argc() {
        let buf = procargs("/usr/bin/node", &["node", "/x/cli.js", ""], &["A=1", "B=2"]);
        assert_eq!(
            parse_procargs2(&buf).unwrap(),
            vec!["node", "/x/cli.js", ""]
        );
    }

    #[test]
    fn rejects_truncated_buffers() {
        assert_eq!(parse_procargs2(&[]), None);
        assert_eq!(parse_procargs2(&0i32.to_ne_bytes()), None);
        let mut buf = 3i32.to_ne_bytes().to_vec();
        buf.extend_from_slice(b"/bin/x\0x\0");
        assert_eq!(parse_procargs2(&buf), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_own_argv() {
        let argv = process_argv(std::process::id()).expect("own argv");
        let expected: Vec<String> = std::env::args().collect();
        assert_eq!(argv, expected);
    }
}
