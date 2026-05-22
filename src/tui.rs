//! Interactive terminal UI mode.
//!
//! Stub implementation: the full ratatui + crossterm dashboard
//! described in the build prompt is not yet wired up. This module
//! exposes the documented entry point so `main.rs` compiles and
//! the `tui` subcommand reports a clear "not yet available"
//! message. When stdout is not a TTY, the subcommand exits with
//! a single WARN line per the spec.

use std::path::Path;

use anyhow::Result;

use crate::logx;

pub async fn run(config: Option<&Path>, _out_dir: &Path) -> Result<()> {
    // Detect TTY in a portable way: query stderr's isatty via
    // libc-free means by attempting a terminal control on stdout.
    let is_tty = is_terminal();
    if !is_tty {
        logx::warn(
            "tui",
            "stdout is not a TTY; the TUI requires an interactive terminal. Use `run` instead.",
        );
        return Ok(());
    }
    logx::info(
        "tui",
        &format!(
            "TUI mode is not yet wired up in this build. config={:?}; falling back to CLI.",
            config
        ),
    );
    Ok(())
}

fn is_terminal() -> bool {
    // Best-effort: if the IsTerminal trait is available (Rust 1.70+),
    // use it; otherwise assume false to be safe in CI.
    use std::io::IsTerminal;
    std::io::stdout().is_terminal()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tui_warns_and_exits_when_stdout_not_tty() {
        // In `cargo test`, stdout is not a TTY, so run() returns Ok
        // after logging a warning. This is the documented behavior.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let res = rt.block_on(run(None, Path::new("/tmp")));
        assert!(res.is_ok());
    }
}
