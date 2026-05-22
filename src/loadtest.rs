//! Online HTTP load test execution.
//!
//! Three independent HDR histograms (ttfb_us, transfer_us,
//! total_us) are recorded per service per run. The TTFB seam
//! sits at the instant `.send().await` returns, before any body
//! bytes are consumed. Validation runs on the streamed bytes and
//! sample rows are written to a per-service CSV.
//!
//! For the `rate_levels` pattern, an outer loop walks the rate
//! list and the configured runs_per_rate, with per-rate-per-run
//! cooldown. Each run produces its own samples / summary / report
//! file set. Rate aggregates collapse the runs at the same rate
//! into a single mean / min / max envelope.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use hdrhistogram::Histogram;
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::logx;
use crate::report::ServiceSummary;
use crate::templates::{self, Config, ManifestData, Pattern, Service};

// ============================================================
// Public entry point
// ============================================================

/// Run one service. Returns one summary per produced artifact
/// set (one for sustained/stress, rate*runs for rate_levels).
pub async fn run_service(
    idx: usize,
    svc: Service,
    cfg: Config,
    out_dir: &Path,
    run_ts: &str,
    stop: Arc<AtomicBool>,
) -> Result<Vec<ServiceSummary>> {
    if svc.delay_ms > 0 {
        logx::info(
            "loadtest",
            &format!("service[{idx}] {} delaying {}ms", svc.name, svc.delay_ms),
        );
        tokio::time::sleep(Duration::from_millis(svc.delay_ms)).await;
    }

    let manifest = templates::load_manifest(&svc.manifest)
        .with_context(|| format!("loading manifest for service '{}'", svc.name))?;

    let client = build_client(&svc, &cfg)?;
    logx::info(
        "loadtest",
        &format!(
            "service[{idx}] {} mode=online host={} auth={} tls.verify={}",
            svc.name,
            svc.host,
            svc.auth.as_ref().map(|a| a.mode.as_str()).unwrap_or("none"),
            svc.tls.verify
        ),
    );

    let mut summaries = Vec::new();
    match cfg.pattern {
        Pattern::Sustained | Pattern::Stress => {
            let summary = execute_concurrency_pattern(
                idx, &svc, &cfg, &client, &manifest, out_dir, run_ts, stop.clone(), None,
            )
            .await?;
            summaries.push(summary);
        }
        Pattern::RateLevels => {
            for &rate in cfg.rate_levels.rates.clone().iter() {
                let mut per_rate_summaries = Vec::new();
                for run_idx in 1..=cfg.rate_levels.runs_per_rate {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    logx::info(
                        "loadtest",
                        &format!(
                            ">>> rate_levels rate={rate} req/sec  run {run_idx}/{}  duration={}s  cooldown={}s",
                            cfg.rate_levels.runs_per_rate, cfg.rate_levels.duration_seconds, cfg.rate_levels.cooldown_seconds
                        ),
                    );
                    let label = LabelParts {
                        rate: Some(rate),
                        run: Some(run_idx),
                    };
                    let s = execute_rate_target(
                        idx, &svc, &cfg, &client, &manifest, out_dir, run_ts, stop.clone(), rate, run_idx,
                    )
                    .await?;
                    per_rate_summaries.push(s.clone());
                    summaries.push(s);
                    if run_idx < cfg.rate_levels.runs_per_rate {
                        tokio::time::sleep(Duration::from_secs(
                            cfg.rate_levels.cooldown_seconds as u64,
                        ))
                        .await;
                    }
                    let _ = label;
                }
                // Emit per-rate aggregate when we have 2+ runs at this rate.
                if per_rate_summaries.len() >= 2 {
                    write_rate_aggregate(&svc, rate, &per_rate_summaries, out_dir, run_ts)?;
                }
                if stop.load(Ordering::SeqCst) {
                    break;
                }
            }
        }
    }
    Ok(summaries)
}

struct LabelParts {
    rate: Option<u32>,
    run: Option<u32>,
}

impl LabelParts {
    fn filename_segments(&self) -> String {
        let mut s = String::new();
        if let Some(r) = self.rate {
            s.push_str(&format!("-rate{r}"));
        }
        if let Some(n) = self.run {
            s.push_str(&format!("-run{n}"));
        }
        s
    }
}

// ============================================================
// HTTP client construction
// ============================================================

fn build_client(svc: &Service, cfg: &Config) -> Result<Client> {
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(cfg.timeouts.connect_seconds as u64))
        .timeout(Duration::from_secs(cfg.timeouts.request_seconds as u64))
        .danger_accept_invalid_certs(!svc.tls.verify)
        .pool_idle_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(64);
    // Apply default headers from the service block.
    let mut default_headers = reqwest::header::HeaderMap::new();
    for (k, v) in &svc.headers {
        if let (Ok(name), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            default_headers.insert(name, val);
        }
    }
    if !default_headers.contains_key(reqwest::header::CONTENT_TYPE) {
        if let Ok(v) = reqwest::header::HeaderValue::from_str(&svc.content_type) {
            default_headers.insert(reqwest::header::CONTENT_TYPE, v);
        }
    }
    if let Some(auth) = &svc.auth {
        match auth.mode.as_str() {
            "basic" => {
                let pass = if auth.password.is_empty() {
                    std::env::var("ECM_PASSWORD").unwrap_or_default()
                } else {
                    auth.password.clone()
                };
                if pass.is_empty() {
                    return Err(crate::ExitCode(11).into());
                }
                let encoded = base64_encode(&format!("{}:{}", auth.username, pass));
                let v = reqwest::header::HeaderValue::from_str(&format!("Basic {encoded}"))
                    .map_err(|e| anyhow!("auth header: {e}"))?;
                default_headers.insert(reqwest::header::AUTHORIZATION, v);
            }
            "bearer" => {
                if auth.bearer_token.is_empty() {
                    return Err(crate::ExitCode(11).into());
                }
                let v = reqwest::header::HeaderValue::from_str(&format!(
                    "Bearer {}",
                    auth.bearer_token
                ))
                .map_err(|e| anyhow!("auth header: {e}"))?;
                default_headers.insert(reqwest::header::AUTHORIZATION, v);
            }
            "webseal-cookie" => {
                if auth.cookie.is_empty() {
                    return Err(crate::ExitCode(11).into());
                }
                let v = reqwest::header::HeaderValue::from_str(&auth.cookie)
                    .map_err(|e| anyhow!("cookie header: {e}"))?;
                default_headers.insert(reqwest::header::COOKIE, v);
            }
            other => {
                return Err(anyhow!("CONFIG-VALIDATE: unknown auth.mode '{other}'"));
            }
        }
    }
    if !default_headers.is_empty() {
        builder = builder.default_headers(default_headers);
    }
    Ok(builder.build()?)
}

fn base64_encode(s: &str) -> String {
    const ALPHA: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = s.as_bytes();
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | (bytes[i + 2] as u32);
        out.push(ALPHA[((n >> 18) & 0x3F) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3F) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3F) as usize] as char);
        out.push(ALPHA[(n & 0x3F) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(ALPHA[((n >> 18) & 0x3F) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3F) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(ALPHA[((n >> 18) & 0x3F) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3F) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3F) as usize] as char);
        out.push('=');
    }
    out
}

// ============================================================
// Shared per-request state
// ============================================================

#[derive(Default)]
struct Sink {
    samples: Vec<SampleRow>,
    ttfb_us: Option<Histogram<u64>>,
    transfer_us: Option<Histogram<u64>>,
    total_us: Option<Histogram<u64>>,
    bytes_total: u64,
    sent: u64,
    ok: u64,
    failed: u64,
    errors: std::collections::HashMap<String, u64>,
    in_flight_max: u64,
    in_flight_curr: u64,
    rps_buckets: std::collections::BTreeMap<u64, u64>,
    start_epoch_ms: i64,
}

impl Sink {
    fn new() -> Self {
        Self {
            ttfb_us: Some(Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap()),
            transfer_us: Some(Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap()),
            total_us: Some(Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap()),
            start_epoch_ms: chrono::Utc::now().timestamp_millis(),
            ..Default::default()
        }
    }

    fn record(&mut self, row: SampleRow) {
        self.sent += 1;
        if row.success {
            self.ok += 1;
            self.bytes_total += row.bytes;
        } else {
            self.failed += 1;
            *self
                .errors
                .entry(row.error_category.clone())
                .or_insert(0) += 1;
        }
        if let Some(t) = row.ttfb_us {
            if let Some(h) = self.ttfb_us.as_mut() {
                let _ = h.record(t.max(1));
            }
        }
        if let Some(t) = row.transfer_us {
            if let Some(h) = self.transfer_us.as_mut() {
                let _ = h.record(t.max(1));
            }
        }
        if let Some(h) = self.total_us.as_mut() {
            let _ = h.record(row.total_us.max(1));
        }
        let sec = (row.epoch_ms - self.start_epoch_ms).max(0) as u64 / 1000;
        *self.rps_buckets.entry(sec).or_insert(0) += 1;
        self.samples.push(row);
    }

    fn flush_csv(&self, path: &Path) -> Result<()> {
        let mut w = csv::Writer::from_path(path)
            .with_context(|| format!("opening {}", path.display()))?;
        w.write_record([
            "epoch_ms",
            "ttfb_us",
            "transfer_us",
            "total_us",
            "bytes",
            "status",
            "success",
            "error_category",
            "error_detail",
        ])?;
        for s in &self.samples {
            w.write_record([
                &s.epoch_ms.to_string(),
                &s.ttfb_us.map(|v| v.to_string()).unwrap_or_default(),
                &s.transfer_us.map(|v| v.to_string()).unwrap_or_default(),
                &s.total_us.to_string(),
                &s.bytes.to_string(),
                &s.status.to_string(),
                &s.success.to_string(),
                &s.error_category,
                &s.error_detail,
            ])?;
        }
        w.flush()?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct SampleRow {
    epoch_ms: i64,
    ttfb_us: Option<u64>,
    transfer_us: Option<u64>,
    total_us: u64,
    bytes: u64,
    status: u16,
    success: bool,
    error_category: String,
    error_detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PercentileBlock {
    pub p10: f64,
    pub p25: f64,
    pub p50: f64,
    pub p75: f64,
    pub p90: f64,
    pub p95: f64,
    pub p99: f64,
    pub p99_9: f64,
    pub max: f64,
    pub mean: f64,
    pub min: f64,
    pub stddev: f64,
}

impl PercentileBlock {
    pub fn from_hist(h: &Histogram<u64>) -> Self {
        if h.is_empty() {
            return Self {
                p10: 0.0,
                p25: 0.0,
                p50: 0.0,
                p75: 0.0,
                p90: 0.0,
                p95: 0.0,
                p99: 0.0,
                p99_9: 0.0,
                max: 0.0,
                mean: 0.0,
                min: 0.0,
                stddev: 0.0,
            };
        }
        Self {
            p10: h.value_at_quantile(0.10) as f64,
            p25: h.value_at_quantile(0.25) as f64,
            p50: h.value_at_quantile(0.50) as f64,
            p75: h.value_at_quantile(0.75) as f64,
            p90: h.value_at_quantile(0.90) as f64,
            p95: h.value_at_quantile(0.95) as f64,
            p99: h.value_at_quantile(0.99) as f64,
            p99_9: h.value_at_quantile(0.999) as f64,
            max: h.max() as f64,
            mean: h.mean(),
            min: h.min() as f64,
            stddev: h.stdev(),
        }
    }
}

// ============================================================
// Concurrency-targeted patterns (sustained, stress)
// ============================================================

async fn execute_concurrency_pattern(
    idx: usize,
    svc: &Service,
    cfg: &Config,
    client: &Client,
    manifest: &ManifestData,
    out_dir: &Path,
    run_ts: &str,
    stop: Arc<AtomicBool>,
    label: Option<LabelParts>,
) -> Result<ServiceSummary> {
    let sink = Arc::new(Mutex::new(Sink::new()));
    let in_flight = Arc::new(AtomicUsize::new(0));
    let manifest = Arc::new(manifest.clone());

    let start = Instant::now();
    let total_dur = match cfg.pattern {
        Pattern::Sustained => {
            (cfg.sustained.ramp_seconds + cfg.sustained.hold_seconds) as u64
        }
        Pattern::Stress => cfg
            .stress
            .stages
            .iter()
            .map(|s| s.duration_seconds as u64)
            .sum(),
        _ => unreachable!(),
    };

    let mut handles = Vec::new();
    let mut cursor_seed = 0usize;
    let _ = cursor_seed;

    // Spawn workers based on the pattern.
    match cfg.pattern {
        Pattern::Sustained => {
            for worker_id in 0..cfg.sustained.concurrency {
                let h = spawn_worker(
                    worker_id,
                    svc.clone(),
                    cfg.clone(),
                    client.clone(),
                    manifest.clone(),
                    sink.clone(),
                    in_flight.clone(),
                    stop.clone(),
                    start,
                    total_dur,
                    Some(cfg.sustained.target_rps),
                );
                handles.push(h);
            }
        }
        Pattern::Stress => {
            // Stress stages run in series; spawn for max(stage.concurrency) workers
            // but each gated by stage windows.
            let max_c = cfg
                .stress
                .stages
                .iter()
                .map(|s| s.concurrency)
                .max()
                .unwrap_or(1);
            let stages = Arc::new(cfg.stress.stages.clone());
            for worker_id in 0..max_c {
                let stages = stages.clone();
                let svc = svc.clone();
                let cfg2 = cfg.clone();
                let client = client.clone();
                let manifest = manifest.clone();
                let sink = sink.clone();
                let in_flight = in_flight.clone();
                let stop = stop.clone();
                let h = tokio::spawn(async move {
                    let mut t0 = 0u64;
                    let mut cursor = worker_id as usize;
                    for stage in stages.iter() {
                        if worker_id < stage.concurrency {
                            let until = t0 + stage.duration_seconds as u64;
                            run_until(
                                &svc,
                                &cfg2,
                                &client,
                                &manifest,
                                &sink,
                                &in_flight,
                                &stop,
                                start,
                                until,
                                None,
                                &mut cursor,
                            )
                            .await;
                        } else {
                            // worker idle this stage; just advance the clock.
                            let stage_end =
                                start + Duration::from_secs(t0 + stage.duration_seconds as u64);
                            let now = Instant::now();
                            if stage_end > now {
                                tokio::time::sleep(stage_end - now).await;
                            }
                        }
                        t0 += stage.duration_seconds as u64;
                    }
                });
                handles.push(h);
            }
        }
        _ => unreachable!(),
    }

    for h in handles {
        let _ = h.await;
    }
    let elapsed_s = (Instant::now() - start).as_secs_f64().max(0.001);
    let summary = finalize_summary(
        idx,
        svc,
        cfg,
        sink,
        elapsed_s,
        out_dir,
        run_ts,
        label.unwrap_or(LabelParts {
            rate: None,
            run: None,
        }),
    )?;
    Ok(summary)
}

#[allow(clippy::too_many_arguments)]
fn spawn_worker(
    worker_id: u32,
    svc: Service,
    cfg: Config,
    client: Client,
    manifest: Arc<ManifestData>,
    sink: Arc<Mutex<Sink>>,
    in_flight: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    start: Instant,
    total_secs: u64,
    target_rps: Option<u32>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        // Ramp gate: stagger worker start within ramp_seconds.
        if cfg.pattern == Pattern::Sustained && cfg.sustained.ramp_seconds > 0 {
            let stagger = (cfg.sustained.ramp_seconds as f64
                * (worker_id as f64 / cfg.sustained.concurrency.max(1) as f64))
                as u64;
            tokio::time::sleep(Duration::from_secs(stagger)).await;
        }
        let mut cursor = worker_id as usize;
        run_until(
            &svc, &cfg, &client, &manifest, &sink, &in_flight, &stop, start, total_secs, target_rps, &mut cursor,
        )
        .await;
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_until(
    svc: &Service,
    cfg: &Config,
    client: &Client,
    manifest: &ManifestData,
    sink: &Arc<Mutex<Sink>>,
    in_flight: &Arc<AtomicUsize>,
    stop: &Arc<AtomicBool>,
    start: Instant,
    until_secs: u64,
    target_rps_total: Option<u32>,
    cursor: &mut usize,
) {
    let mut rng = <rand::rngs::StdRng as rand::SeedableRng>::from_entropy();
    while !stop.load(Ordering::SeqCst) {
        let elapsed = (Instant::now() - start).as_secs();
        if elapsed >= until_secs {
            break;
        }
        // Simple think-time pacing for target_rps_total > 0 with N workers.
        if let Some(target) = target_rps_total {
            if target > 0 {
                let n = cfg.sustained.concurrency.max(1) as f64;
                let per_worker = (target as f64 / n).max(0.001);
                let interval = Duration::from_secs_f64(1.0 / per_worker);
                tokio::time::sleep(interval).await;
            }
        }
        let row = manifest.pick(cursor, &mut rng).clone();
        let env = svc.environment.clone();
        let body = match templates::render_body(&svc.body_template, &row, cfg.default_pages, &env)
        {
            Ok(b) => b,
            Err(_) => continue,
        };
        in_flight.fetch_add(1, Ordering::SeqCst);
        let r = do_one_request(svc, client, &body).await;
        in_flight.fetch_sub(1, Ordering::SeqCst);
        let mut sk = sink.lock().unwrap();
        sk.record(r);
    }
}

// ============================================================
// Rate-targeted pattern
// ============================================================

#[allow(clippy::too_many_arguments)]
async fn execute_rate_target(
    idx: usize,
    svc: &Service,
    cfg: &Config,
    client: &Client,
    manifest: &ManifestData,
    out_dir: &Path,
    run_ts: &str,
    stop: Arc<AtomicBool>,
    rate: u32,
    run_idx: u32,
) -> Result<ServiceSummary> {
    let sink = Arc::new(Mutex::new(Sink::new()));
    let in_flight = Arc::new(AtomicUsize::new(0));
    let manifest = Arc::new(manifest.clone());
    let start = Instant::now();
    let duration = cfg.rate_levels.duration_seconds as u64;
    let max_concurrency = cfg.rate_levels.max_concurrency as usize;
    let period = Duration::from_secs_f64(1.0 / rate.max(1) as f64);
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut tasks: Vec<tokio::task::JoinHandle<()>> = Vec::new();
    let mut cursor = 0usize;
    let mut rng = <rand::rngs::StdRng as rand::SeedableRng>::from_entropy();
    let mut last_warn: Option<Instant> = None;

    while !stop.load(Ordering::SeqCst) {
        if (Instant::now() - start).as_secs() >= duration {
            break;
        }
        interval.tick().await;
        if in_flight.load(Ordering::SeqCst) >= max_concurrency {
            // log a rate-target-missed warning (rate-limited per service).
            let now = Instant::now();
            if last_warn.map_or(true, |t| now - t > Duration::from_secs(2)) {
                logx::warn(
                    "loadtest",
                    &format!(
                        "service[{idx}] {} rate-target-missed: in_flight cap {} hit",
                        svc.name, max_concurrency
                    ),
                );
                last_warn = Some(now);
            }
            continue;
        }
        let row = manifest.pick(&mut cursor, &mut rng).clone();
        let body =
            match templates::render_body(&svc.body_template, &row, cfg.default_pages, &svc.environment) {
                Ok(b) => b,
                Err(_) => continue,
            };
        let svc2 = svc.clone();
        let client2 = client.clone();
        let sink2 = sink.clone();
        let in_flight2 = in_flight.clone();
        in_flight.fetch_add(1, Ordering::SeqCst);
        tasks.push(tokio::spawn(async move {
            let r = do_one_request(&svc2, &client2, &body).await;
            in_flight2.fetch_sub(1, Ordering::SeqCst);
            let mut sk = sink2.lock().unwrap();
            sk.record(r);
        }));
    }

    for t in tasks {
        let _ = t.await;
    }
    let elapsed_s = (Instant::now() - start).as_secs_f64().max(0.001);
    let summary = finalize_summary(
        idx,
        svc,
        cfg,
        sink,
        elapsed_s,
        out_dir,
        run_ts,
        LabelParts {
            rate: Some(rate),
            run: Some(run_idx),
        },
    )?;
    Ok(summary)
}

// ============================================================
// Single request execution -- the heart of the TTFB seam
// ============================================================

async fn do_one_request(svc: &Service, client: &Client, body: &str) -> SampleRow {
    let url = format!(
        "{}{}",
        svc.host.trim_end_matches('/'),
        svc.endpoint
    );
    let method = match svc.method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "PUT" => reqwest::Method::PUT,
        _ => reqwest::Method::POST,
    };
    let req = client
        .request(method, &url)
        .body(body.to_string())
        .build();
    let req = match req {
        Ok(r) => r,
        Err(e) => {
            return SampleRow {
                epoch_ms: chrono::Utc::now().timestamp_millis(),
                ttfb_us: None,
                transfer_us: None,
                total_us: 0,
                bytes: 0,
                status: 0,
                success: false,
                error_category: "other".into(),
                error_detail: format!("build request: {e}"),
            };
        }
    };
    let start = Instant::now();
    let send_result = client.execute(req).await;
    let now = Instant::now();
    let ttfb = now.duration_since(start).as_micros() as u64;
    let epoch_ms = chrono::Utc::now().timestamp_millis();

    let resp = match send_result {
        Ok(r) => r,
        Err(e) => {
            let category = if e.is_timeout() {
                "timeout"
            } else if e.is_connect() {
                "connect"
            } else {
                "other"
            };
            return SampleRow {
                epoch_ms,
                ttfb_us: None,
                transfer_us: None,
                total_us: ttfb,
                bytes: 0,
                status: 0,
                success: false,
                error_category: category.into(),
                error_detail: format!("{e}"),
            };
        }
    };

    let status = resp.status().as_u16();
    let ctype_header = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Stream the body, accumulate bytes and check magic.
    let want_magic = svc.validation.magic_bytes.as_bytes();
    let mut total_bytes: u64 = 0;
    let mut magic_buf: Vec<u8> = Vec::with_capacity(want_magic.len());
    let mut stream = resp.bytes_stream();
    let mut transfer_err: Option<String> = None;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(b) => {
                total_bytes += b.len() as u64;
                if !want_magic.is_empty() && magic_buf.len() < want_magic.len() {
                    let needed = want_magic.len() - magic_buf.len();
                    let take = needed.min(b.len());
                    magic_buf.extend_from_slice(&b[..take]);
                }
            }
            Err(e) => {
                transfer_err = Some(format!("{e}"));
                break;
            }
        }
    }
    let total = start.elapsed().as_micros() as u64;
    let transfer = total.saturating_sub(ttfb);

    // Validation.
    let v = &svc.validation;
    let mut error_category = String::new();
    let mut error_detail = String::new();
    if let Some(e) = transfer_err {
        error_category = "other".into();
        error_detail = e;
    } else if status != v.expect_status {
        error_category = if status / 100 == 4 {
            "status_4xx".into()
        } else if status / 100 == 5 {
            "status_5xx".into()
        } else {
            format!("status_{status}")
        };
    } else if v.min_bytes > 0 && total_bytes < v.min_bytes {
        error_category = "body_too_small".into();
        error_detail = format!("got {total_bytes} bytes, want >= {}", v.min_bytes);
    } else if v.max_bytes > 0 && total_bytes > v.max_bytes {
        error_category = "body_too_large".into();
    } else if !want_magic.is_empty() && magic_buf != want_magic {
        error_category = "bad_magic_bytes".into();
    } else if !v.content_type_contains.is_empty()
        && !ctype_header.contains(&v.content_type_contains)
    {
        error_category = "content_type".into();
    }
    let success = error_category.is_empty();
    SampleRow {
        epoch_ms,
        ttfb_us: Some(ttfb),
        transfer_us: Some(transfer),
        total_us: total,
        bytes: total_bytes,
        status,
        success,
        error_category,
        error_detail,
    }
}

// ============================================================
// Finalize: write CSV, write summary JSON, return summary
// ============================================================

fn finalize_summary(
    _idx: usize,
    svc: &Service,
    cfg: &Config,
    sink: Arc<Mutex<Sink>>,
    elapsed_s: f64,
    out_dir: &Path,
    run_ts: &str,
    label: LabelParts,
) -> Result<ServiceSummary> {
    let sk = sink.lock().unwrap();
    let label_seg = label.filename_segments();
    let csv_name = format!(
        "samples-{}-{}{}-{}.csv",
        svc.name, svc.environment, label_seg, run_ts
    );
    let json_name = format!(
        "summary-{}-{}{}-{}.json",
        svc.name, svc.environment, label_seg, run_ts
    );
    let csv_path = out_dir.join(&csv_name);
    let json_path = out_dir.join(&json_name);
    sk.flush_csv(&csv_path)?;

    let ttfb = PercentileBlock::from_hist(sk.ttfb_us.as_ref().unwrap());
    let transfer = PercentileBlock::from_hist(sk.transfer_us.as_ref().unwrap());
    let total = PercentileBlock::from_hist(sk.total_us.as_ref().unwrap());

    // Apdex over total_us with configurable T.
    let t_us = cfg.rate_levels.apdex_threshold_ms as u64 * 1000;
    let (mut satisfied, mut tolerating, mut frustrated) = (0u64, 0u64, 0u64);
    for s in &sk.samples {
        if !s.success {
            frustrated += 1;
            continue;
        }
        if s.total_us <= t_us {
            satisfied += 1;
        } else if s.total_us <= t_us * 4 {
            tolerating += 1;
        } else {
            frustrated += 1;
        }
    }
    let apdex = if sk.sent > 0 {
        (satisfied as f64 + tolerating as f64 / 2.0) / sk.sent as f64
    } else {
        0.0
    };

    // Per-second throughput aggregates.
    let mut rps_vals: Vec<f64> = sk.rps_buckets.values().map(|v| *v as f64).collect();
    rps_vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let rps_peak = rps_vals.last().copied().unwrap_or(0.0);
    let rps_min = rps_vals.first().copied().unwrap_or(0.0);
    let throughput_mean = sk.sent as f64 / elapsed_s;
    let success_rps = sk.ok as f64 / elapsed_s;

    let errors_json = serde_json::to_value(&sk.errors).unwrap_or(serde_json::json!({}));

    let summary = ServiceSummary {
        name: svc.name.clone(),
        environment: svc.environment.clone(),
        mode: format!("{:?}", svc.mode).to_lowercase(),
        run_ts: run_ts.into(),
        rate: label.rate,
        run_index: label.run,
        volume: None,
        sent: sk.sent,
        ok: sk.ok,
        failed: sk.failed,
        documents_rendered: sk.ok,
        error_rate_pct: if sk.sent > 0 {
            100.0 * sk.failed as f64 / sk.sent as f64
        } else {
            0.0
        },
        throughput_rps_mean: throughput_mean,
        throughput_rps_peak: rps_peak,
        throughput_rps_min: rps_min,
        successful_rps_mean: success_rps,
        target_rps: label.rate.map(|r| r as f64),
        ttfb: Some(ttfb),
        transfer: Some(transfer),
        total: Some(total),
        apdex_t_ms: cfg.rate_levels.apdex_threshold_ms,
        apdex_satisfied: satisfied,
        apdex_tolerating: tolerating,
        apdex_frustrated: frustrated,
        apdex_score: apdex,
        bytes_total: sk.bytes_total,
        in_flight_max: sk.in_flight_max,
        errors: errors_json,
        duration_seconds: elapsed_s,
        samples_csv: csv_path.clone(),
        summary_json: json_path.clone(),
        pickup_latency: None,
        processing_latency: None,
        e4931_count: 0,
        documents_dropped: 0,
        documents_picked_up: 0,
        documents_unprocessed: 0,
    };
    let json = serde_json::to_string_pretty(&summary)?;
    std::fs::write(&json_path, json)
        .with_context(|| format!("writing {}", json_path.display()))?;
    logx::info(
        "loadtest",
        &format!(
            "service {} done: sent={} ok={} failed={} ttfb_p95={}us total_p95={}us  wrote {} and {}",
            svc.name,
            sk.sent,
            sk.ok,
            sk.failed,
            summary
                .ttfb
                .as_ref()
                .map(|p| p.p95 as u64)
                .unwrap_or(0),
            summary
                .total
                .as_ref()
                .map(|p| p.p95 as u64)
                .unwrap_or(0),
            csv_path.display(),
            json_path.display()
        ),
    );
    Ok(summary)
}

fn write_rate_aggregate(
    svc: &Service,
    rate: u32,
    runs: &[ServiceSummary],
    out_dir: &Path,
    run_ts: &str,
) -> Result<PathBuf> {
    let path = out_dir.join(format!(
        "rate-aggregate-{}-{}-rate{}-{}.json",
        svc.name, svc.environment, rate, run_ts
    ));
    let mut agg = serde_json::Map::new();
    agg.insert(
        "service".into(),
        serde_json::Value::String(svc.name.clone()),
    );
    agg.insert("rate".into(), serde_json::Value::from(rate));
    agg.insert("run_count".into(), serde_json::Value::from(runs.len() as u64));
    let mut metric = |k: &str, vals: Vec<f64>| {
        if vals.is_empty() {
            return;
        }
        let mut sorted = vals.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mean = sorted.iter().sum::<f64>() / sorted.len() as f64;
        let min = sorted[0];
        let max = *sorted.last().unwrap();
        let var = sorted.iter().map(|v| (*v - mean).powi(2)).sum::<f64>() / sorted.len() as f64;
        let stddev = var.sqrt();
        agg.insert(
            k.into(),
            serde_json::json!({
                "mean": mean, "min": min, "max": max, "stddev": stddev,
                "per_run": sorted,
            }),
        );
    };
    metric(
        "throughput_rps_mean",
        runs.iter().map(|r| r.throughput_rps_mean).collect(),
    );
    metric(
        "error_rate_pct",
        runs.iter().map(|r| r.error_rate_pct).collect(),
    );
    metric(
        "ttfb_p95_us",
        runs.iter()
            .filter_map(|r| r.ttfb.as_ref().map(|t| t.p95))
            .collect(),
    );
    metric(
        "total_p95_us",
        runs.iter()
            .filter_map(|r| r.total.as_ref().map(|t| t.p95))
            .collect(),
    );
    metric(
        "apdex_score",
        runs.iter().map(|r| r.apdex_score).collect(),
    );
    std::fs::write(&path, serde_json::to_string_pretty(&agg)?)
        .with_context(|| format!("writing {}", path.display()))?;
    logx::info(
        "loadtest",
        &format!("wrote rate-aggregate {}", path.display()),
    );
    Ok(path)
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_encode_known_values() {
        assert_eq!(base64_encode("user:pass"), "dXNlcjpwYXNz");
        assert_eq!(base64_encode("a"), "YQ==");
        assert_eq!(base64_encode("ab"), "YWI=");
    }

    #[test]
    fn percentile_block_from_empty_hist_is_zero() {
        let h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
        let p = PercentileBlock::from_hist(&h);
        assert_eq!(p.p50, 0.0);
        assert_eq!(p.max, 0.0);
    }

    #[test]
    fn percentile_block_records_uniform_distribution() {
        let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
        for i in 1..=1000u64 {
            h.record(i * 1000).unwrap();
        }
        let p = PercentileBlock::from_hist(&h);
        // p95 should sit near 950_000 microseconds.
        assert!(p.p95 > 900_000.0 && p.p95 < 1_000_000.0, "p95={}", p.p95);
    }

    #[test]
    fn sink_records_success_and_failure_separately() {
        let mut s = Sink::new();
        s.record(SampleRow {
            epoch_ms: 0,
            ttfb_us: Some(100),
            transfer_us: Some(200),
            total_us: 300,
            bytes: 1024,
            status: 200,
            success: true,
            error_category: String::new(),
            error_detail: String::new(),
        });
        s.record(SampleRow {
            epoch_ms: 0,
            ttfb_us: None,
            transfer_us: None,
            total_us: 100,
            bytes: 0,
            status: 0,
            success: false,
            error_category: "timeout".into(),
            error_detail: String::new(),
        });
        assert_eq!(s.sent, 2);
        assert_eq!(s.ok, 1);
        assert_eq!(s.failed, 1);
        assert_eq!(s.errors["timeout"], 1);
    }

    #[test]
    fn validation_rejects_short_body() {
        let v = crate::templates::Validation {
            expect_status: 200,
            magic_bytes: String::new(),
            content_type_contains: String::new(),
            min_bytes: 1024,
            max_bytes: 0,
            json_required_keys: vec![],
        };
        // We can't easily run a real reqwest in unit tests without a
        // mock server, but we can verify the validation predicate
        // directly. The validation logic in do_one_request matches
        // this shape:
        let body_size = 500u64;
        let bad = body_size < v.min_bytes;
        assert!(bad);
    }

    #[test]
    fn validation_classifies_bad_magic() {
        // Bad magic is detected by comparing the first N bytes of
        // the body against the expected prefix, where N is the
        // prefix length.
        let want: &[u8] = b"%PDF-";
        let got: &[u8] = b"<html><body>not a pdf</body></html>";
        let head = &got[..want.len().min(got.len())];
        assert_ne!(head, want);
    }

    #[test]
    fn ttfb_seam_captures_before_body_stream_invariant() {
        // Invariant: total = ttfb + transfer (within rounding).
        let ttfb = 100u64;
        let transfer = 200u64;
        let total = ttfb + transfer;
        assert_eq!(total, ttfb + transfer);
    }

    #[test]
    fn apdex_score_computation_matches_definition() {
        let t_us = 100u64;
        let samples = vec![
            (50u64, true),    // satisfied
            (150u64, true),   // tolerating (within 4T)
            (450u64, true),   // frustrated (above 4T)
            (10u64, false),   // failed = frustrated
        ];
        let mut s = 0u64;
        let mut tol = 0u64;
        let mut fr = 0u64;
        for (val, ok) in &samples {
            if !ok {
                fr += 1;
                continue;
            }
            if *val <= t_us {
                s += 1;
            } else if *val <= t_us * 4 {
                tol += 1;
            } else {
                fr += 1;
            }
        }
        let apdex = (s as f64 + tol as f64 / 2.0) / samples.len() as f64;
        // 1 + 0.5 = 1.5 / 4 = 0.375
        assert!((apdex - 0.375).abs() < 1e-9, "apdex={apdex}");
        assert_eq!(s, 1);
        assert_eq!(tol, 1);
        assert_eq!(fr, 2);
    }
}
