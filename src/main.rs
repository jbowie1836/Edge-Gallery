//! ecm-loadtest binary entry point.
//!
//! Parses the CLI, loads the YAML config, and dispatches into the
//! appropriate subcommand module. Every subcommand routes through
//! a single shared logging surface and a single shared Ctrl+C
//! cancellation flag.
//!
//! Modules:
//!   loadtest   online HTTP request load (TTFB-aware)
//!   batch      file-drop pipeline load (local + SFTP)
//!   templates  service template inheritance + manifest CSV loader
//!   report     HTML + inline SVG report generation
//!   archive    pre-run archive rotation
//!   serve      embedded loopback HTTP server
//!   tui        interactive terminal UI mode

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

mod archive;
mod batch;
mod loadtest;
mod logx;
mod report;
mod serve;
mod templates;
mod tui;

// ============================================================
// CLI surface
// ============================================================

#[derive(Parser, Debug)]
#[command(name = "ecm-loadtest", version = "1.0.0", about = "ECM Image Viewer Service load test CLI", long_about = None)]
struct Cli {
    /// Enable DEBUG log level.
    #[arg(long, global = true)]
    verbose: bool,

    /// Suppress INFO; only WARN and ERROR.
    #[arg(long, global = true)]
    quiet: bool,

    /// Tee log output to this file in addition to stderr.
    #[arg(long, global = true)]
    log_file: Option<PathBuf>,

    #[command(subcommand)]
    cmd: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Execute a load test driven by the YAML config.
    Run {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        out_dir: Option<PathBuf>,
        #[arg(long)]
        no_archive: bool,
        #[arg(long)]
        no_serve: bool,
        #[arg(long)]
        no_launch: bool,
        #[arg(long, default_value_t = 8765)]
        port: u16,
        #[arg(long)]
        vscode: bool,
        #[arg(long)]
        env: Option<String>,
        #[arg(long)]
        no_report: bool,
        #[arg(long)]
        stop_at_error_pct: Option<f32>,
        #[arg(long)]
        target_rps: Option<u32>,
        #[arg(long)]
        launch_only_compare: bool,
        #[arg(long)]
        skip_post_validation: bool,
    },
    /// Rebuild HTML reports from a prior run's artifacts.
    Report {
        #[arg(long)]
        run_id: String,
        #[arg(long, default_value = "results")]
        out_dir: PathBuf,
    },
    /// Start the embedded HTTP server without running a test.
    Serve {
        #[arg(long, default_value = "results")]
        out_dir: PathBuf,
        #[arg(long, default_value_t = 8765)]
        port: u16,
    },
    /// Launch the interactive terminal UI.
    Tui {
        #[arg(long)]
        config: Option<PathBuf>,
        #[arg(long, default_value = "results")]
        out_dir: PathBuf,
    },
    /// (Re)generate the developer playbook at docs/playbook.html.
    Docs {
        #[arg(long, default_value = "docs/playbook.html")]
        out_path: PathBuf,
    },
    /// Print an annotated example YAML config to stdout.
    ExampleConfig,
}

// ============================================================
// Entry point
// ============================================================

fn main() -> Result<()> {
    let cli = Cli::parse();
    let level = if cli.verbose {
        logx::Level::Debug
    } else if cli.quiet {
        logx::Level::Warn
    } else {
        logx::Level::Info
    };
    logx::init(level, cli.log_file.clone());

    // Single shared stop flag, also wired into the Ctrl+C handler.
    let stop = Arc::new(AtomicBool::new(false));
    {
        let s = stop.clone();
        // We tolerate a duplicate install when invoked from tests.
        let _ = ctrlc::set_handler(move || s.store(true, Ordering::SeqCst));
    }

    // Build the tokio runtime explicitly so panics in workers
    // surface as JoinErrors rather than silent task drops.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("building tokio runtime")?;

    let result = rt.block_on(dispatch(cli.cmd, stop));

    // Convert escaped panics or anyhow errors into the appropriate
    // documented exit code.
    match result {
        Ok(()) => Ok(()),
        Err(e) => {
            logx::error("main", &format!("{e:#}"));
            let code = e
                .downcast_ref::<ExitCode>()
                .map(|c| c.0)
                .unwrap_or(70);
            std::process::exit(code);
        }
    }
}

/// Wrap an i32 in a downcastable error so subcommand code can
/// request a specific exit code without losing the anyhow context.
#[derive(Debug)]
pub struct ExitCode(pub i32);

impl std::fmt::Display for ExitCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "exit code {}", self.0)
    }
}

impl std::error::Error for ExitCode {}

async fn dispatch(cmd: Command, stop: Arc<AtomicBool>) -> Result<()> {
    match cmd {
        Command::Run {
            config,
            out_dir,
            no_archive,
            no_serve,
            no_launch,
            port,
            vscode,
            env,
            no_report,
            stop_at_error_pct,
            target_rps,
            launch_only_compare,
            skip_post_validation,
        } => {
            let opts = RunOptions {
                config,
                out_dir,
                no_archive,
                no_serve,
                no_launch,
                port,
                vscode,
                env,
                no_report,
                stop_at_error_pct,
                target_rps,
                launch_only_compare,
                skip_post_validation,
            };
            run_command(opts, stop).await
        }
        Command::Report { run_id, out_dir } => report::rebuild(&out_dir, &run_id),
        Command::Serve { out_dir, port } => serve::serve_blocking(&out_dir, port, stop).await,
        Command::Tui { config, out_dir } => tui::run(config.as_deref(), &out_dir).await,
        Command::Docs { out_path } => docs::generate(&out_path),
        Command::ExampleConfig => {
            print!("{}", templates::EXAMPLE_CONFIG);
            Ok(())
        }
    }
}

// ============================================================
// run subcommand orchestration
// ============================================================

pub struct RunOptions {
    pub config: PathBuf,
    pub out_dir: Option<PathBuf>,
    pub no_archive: bool,
    pub no_serve: bool,
    pub no_launch: bool,
    pub port: u16,
    pub vscode: bool,
    pub env: Option<String>,
    pub no_report: bool,
    pub stop_at_error_pct: Option<f32>,
    pub target_rps: Option<u32>,
    pub launch_only_compare: bool,
    pub skip_post_validation: bool,
}

async fn run_command(opts: RunOptions, stop: Arc<AtomicBool>) -> Result<()> {
    // Step 1: load and validate config + templates + manifests.
    let mut cfg = templates::load_config(&opts.config)
        .with_context(|| format!("loading config {}", opts.config.display()))?;

    if let Some(env) = &opts.env {
        for svc in &mut cfg.services {
            svc.environment = env.clone();
        }
    }
    if let Some(pct) = opts.stop_at_error_pct {
        cfg.stop_at_error_pct = pct;
    }
    if let Some(rps) = opts.target_rps {
        cfg.pattern = templates::Pattern::RateLevels;
        cfg.rate_levels.rates = vec![rps];
        cfg.rate_levels.runs_per_rate = cfg.rate_levels.runs_per_rate.max(1);
    }

    let out_dir = opts
        .out_dir
        .unwrap_or_else(|| cfg.output.dir.clone());
    std::fs::create_dir_all(&out_dir)
        .with_context(|| format!("creating output dir {}", out_dir.display()))?;

    // Step 2: archive rotation BEFORE any new file is written.
    if !opts.no_archive {
        archive::rotate(&out_dir).context("archive rotation")?;
    } else {
        logx::info("archive", "--no-archive set; skipping rotation");
    }

    // Step 3: shared run timestamp.
    let run_ts = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
    logx::info("main", &format!("run_id={run_ts}  out_dir={}", out_dir.display()));

    // Step 4: split services by mode and run them concurrently.
    let online: Vec<_> = cfg
        .services
        .iter()
        .filter(|s| s.enabled && s.mode == templates::Mode::Online)
        .cloned()
        .collect();
    let batches: Vec<_> = cfg
        .services
        .iter()
        .filter(|s| s.enabled && s.mode == templates::Mode::Batch)
        .cloned()
        .collect();

    let mut online_handles = Vec::new();
    for (idx, svc) in online.iter().cloned().enumerate() {
        let cfg2 = cfg.clone();
        let stop2 = stop.clone();
        let out2 = out_dir.clone();
        let ts2 = run_ts.clone();
        online_handles.push(tokio::spawn(async move {
            loadtest::run_service(idx, svc, cfg2, &out2, &ts2, stop2).await
        }));
    }

    let mut batch_handles = Vec::new();
    for (idx, svc) in batches.iter().cloned().enumerate() {
        let cfg2 = cfg.clone();
        let stop2 = stop.clone();
        let out2 = out_dir.clone();
        let ts2 = run_ts.clone();
        batch_handles.push(tokio::spawn(async move {
            batch::run_service(idx, svc, cfg2, &out2, &ts2, stop2).await
        }));
    }

    let mut all_summaries: Vec<report::ServiceSummary> = Vec::new();
    for h in online_handles {
        match h.await {
            Ok(Ok(s)) => all_summaries.extend(s),
            Ok(Err(e)) => logx::error("loadtest", &format!("service failed: {e:#}")),
            Err(e) => logx::error("loadtest", &format!("task join error: {e:#}")),
        }
    }
    for h in batch_handles {
        match h.await {
            Ok(Ok(s)) => all_summaries.extend(s),
            Ok(Err(e)) => logx::error("batch", &format!("service failed: {e:#}")),
            Err(e) => logx::error("batch", &format!("task join error: {e:#}")),
        }
    }

    // Step 5: HTML reports.
    if !opts.no_report {
        for s in &all_summaries {
            if let Err(e) = report::render_service(s, &out_dir) {
                logx::error("report", &format!("render {}: {e:#}", s.name));
            }
        }
    }

    let compare_path = if cfg.services.iter().filter(|s| s.enabled).count() > 1 {
        match report::render_compare(&all_summaries, &cfg, &out_dir, &run_ts) {
            Ok(p) => Some(p),
            Err(e) => {
                logx::error("report", &format!("compare: {e:#}"));
                None
            }
        }
    } else {
        None
    };

    // Step 6: post-run validation.
    let validation_ok = if !opts.skip_post_validation {
        match report::post_validate(&out_dir, &run_ts, &all_summaries) {
            Ok(ok) => ok,
            Err(e) => {
                logx::error("report", &format!("post-validation failed to run: {e:#}"));
                false
            }
        }
    } else {
        logx::info("report", "--skip-post-validation set");
        true
    };

    // Step 7: server + auto-launch.
    if !opts.no_serve {
        let urls = serve::collect_launch_urls(
            &out_dir,
            opts.port,
            compare_path.as_deref(),
            &all_summaries,
            opts.launch_only_compare,
        );
        let port = serve::start_background(&out_dir, opts.port, stop.clone())
            .context("starting embedded server")?;
        if !opts.no_launch && validation_ok {
            serve::auto_launch(&urls, opts.vscode, port);
        } else if !validation_ok {
            logx::error(
                "serve",
                "post-run validation failed; auto-launch suppressed",
            );
        }
        // Block until Ctrl+C.
        while !stop.load(Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        logx::info("serve", "server stopped");
    }

    Ok(())
}

// ============================================================
// docs subcommand: regenerate the playbook
// ============================================================

mod docs {
    use anyhow::{Context, Result};
    use std::path::Path;

    /// Re-emit docs/playbook.html. The bundled playbook lives in
    /// the binary; this writes a fresh copy to disk.
    pub fn generate(path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(path, crate::report::PLAYBOOK_HTML)
            .with_context(|| format!("writing {}", path.display()))?;
        crate::logx::info("main", &format!("wrote {}", path.display()));
        Ok(())
    }
}
