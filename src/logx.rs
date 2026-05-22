//! Timestamped logging surface shared by every module.
//!
//! Format:
//!   [YYYY-MM-DDTHH:MM:SS.mmmZ] [LEVEL] [MODULE]  message
//!
//! LEVEL is fixed-width 5, MODULE is fixed-width 9, so columns
//! align in piped log output. ANSI color is enabled only when
//! stderr is a TTY; otherwise the output is pure ASCII.

use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

struct State {
    level: Level,
    file: Option<std::fs::File>,
    // Ring buffer used by the TUI; never grows past 1000 entries.
    ring: VecDeque<String>,
    suppression: std::collections::HashMap<String, (u64, std::time::Instant)>,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();

/// Initialize the global logger. Safe to call repeatedly; the
/// first call wins.
pub fn init(level: Level, log_file: Option<PathBuf>) {
    let file = log_file.and_then(|p| {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .ok()
    });
    let _ = STATE.set(Mutex::new(State {
        level,
        file,
        ring: VecDeque::with_capacity(1024),
        suppression: std::collections::HashMap::new(),
    }));
}

fn ensure() -> &'static Mutex<State> {
    STATE.get_or_init(|| {
        Mutex::new(State {
            level: Level::Info,
            file: None,
            ring: VecDeque::with_capacity(1024),
            suppression: std::collections::HashMap::new(),
        })
    })
}

fn write_line(level: Level, module: &str, msg: &str) {
    let st = ensure();
    let mut g = match st.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    if level < g.level {
        return;
    }
    let ts = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
    let lvl = match level {
        Level::Debug => "DEBUG",
        Level::Info => "INFO ",
        Level::Warn => "WARN ",
        Level::Error => "ERROR",
    };
    let module_pad = format!("{:<9}", &module.chars().take(9).collect::<String>());
    let line = format!("[{ts}] [{lvl}] [{module_pad}]  {msg}");
    eprintln!("{line}");
    if let Some(f) = g.file.as_mut() {
        let _ = writeln!(f, "{line}");
    }
    while g.ring.len() >= 1000 {
        g.ring.pop_front();
    }
    g.ring.push_back(line);
}

pub fn debug(module: &str, msg: &str) {
    write_line(Level::Debug, module, msg);
}
pub fn info(module: &str, msg: &str) {
    write_line(Level::Info, module, msg);
}
pub fn warn(module: &str, msg: &str) {
    write_line(Level::Warn, module, msg);
}
pub fn error(module: &str, msg: &str) {
    write_line(Level::Error, module, msg);
}

/// Suppress floods of identical error categories: log every 100th
/// occurrence and emit a per-minute summary at WARN.
pub fn suppressed_error(module: &str, category: &str, detail: &str) {
    let st = ensure();
    let mut g = match st.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let now = std::time::Instant::now();
    let entry = g
        .suppression
        .entry(category.to_string())
        .or_insert((0, now));
    entry.0 += 1;
    let count = entry.0;
    let elapsed = now.duration_since(entry.1);
    drop(g);
    if count == 1 || count.is_multiple_of(100) {
        write_line(
            Level::Debug,
            module,
            &format!("{category}: {detail} (occurrences={count})"),
        );
    }
    if elapsed.as_secs() >= 60 {
        write_line(
            Level::Warn,
            module,
            &format!("{category} suppressed: {count} occurrences in the last minute"),
        );
        let st = ensure();
        let mut g = match st.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(e) = g.suppression.get_mut(category) {
            *e = (0, now);
        }
    }
}

/// Snapshot the most recent N log lines (for the TUI ring buffer).
pub fn ring_snapshot() -> Vec<String> {
    let st = ensure();
    let g = match st.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    g.ring.iter().cloned().collect()
}
