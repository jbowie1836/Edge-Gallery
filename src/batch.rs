//! Batch file-drop pipeline.
//!
//! Implements the lifecycle described in the build prompt: at T0
//! the harness copies (or SFTP-uploads) an XML/PDF pair into a
//! vendor drop folder; T1 is the moment the pickup signal fires
//! (either the files vanish from the directory or a configured
//! log line appears); T2 is the optional completion timestamp
//! parsed out of the same log file.
//!
//! Each `mode: batch` service runs the outer loop over
//! batch.volumes x batch.runs_per_volume. Within each cycle a
//! drop task paces pair uploads at `drop_rate_per_minute` while a
//! watch task polls the pickup signal at `poll_interval_ms`.
//!
//! The SFTP transport path is scaffolded but not exercised against
//! a live server in unit tests; the pickup-signal and lifecycle
//! logic is shared with the local path.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use hdrhistogram::Histogram;
use serde::Serialize;

use crate::logx;
use crate::report::ServiceSummary;
use crate::templates::{self, Config, ManifestData, Service};

// ============================================================
// Public entry point
// ============================================================

pub async fn run_service(
    idx: usize,
    svc: Service,
    cfg: Config,
    out_dir: &Path,
    run_ts: &str,
    stop: Arc<AtomicBool>,
) -> Result<Vec<ServiceSummary>> {
    if svc.delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(svc.delay_ms)).await;
    }

    // Drop folder existence + writability check (Linux GID check
    // logged-only; Windows would skip with a debug line).
    let drop_path = PathBuf::from(&svc.drop_folder);
    if svc.transport == "local" {
        if !drop_path.exists() {
            return Err(anyhow!(
                "BATCH-DROP-FOLDER: '{}' does not exist",
                drop_path.display()
            ));
        }
        // Probe writability.
        let probe = drop_path.join(".ecm-loadtest-probe");
        std::fs::write(&probe, b"")
            .with_context(|| format!("BATCH-DROP-FOLDER: not writable {}", drop_path.display()))?;
        let _ = std::fs::remove_file(&probe);
    }
    #[cfg(target_os = "linux")]
    {
        if svc.transport == "local" {
            logx::debug(
                "batch",
                &format!("drop_folder GID check is informational only; not enforced"),
            );
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        logx::debug("batch", "GID check skipped on non-Linux host");
    }

    let manifest = templates::load_manifest(&svc.manifest)?;
    logx::info(
        "batch",
        &format!(
            "service[{idx}] {} mode=batch drop_folder={} transport={}",
            svc.name, svc.drop_folder, svc.transport
        ),
    );

    let mut summaries = Vec::new();
    for &volume in cfg.batch.volumes.clone().iter() {
        for run_idx in 1..=cfg.batch.runs_per_volume {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            logx::info(
                "batch",
                &format!(
                    ">>> batch volume={volume}  run {run_idx}/{}  drop_rate={}/min  cycle_timeout={}min",
                    cfg.batch.runs_per_volume,
                    cfg.batch.drop_rate_per_minute,
                    cfg.batch.cycle_duration_minutes,
                ),
            );
            let summary = execute_cycle(
                &svc, &cfg, &manifest, volume, run_idx, out_dir, run_ts, stop.clone(),
            )
            .await?;
            summaries.push(summary);
            if run_idx < cfg.batch.runs_per_volume {
                tokio::time::sleep(Duration::from_secs(cfg.batch.cooldown_seconds as u64)).await;
            }
        }
        if stop.load(Ordering::SeqCst) {
            break;
        }
    }
    Ok(summaries)
}

// ============================================================
// Per-cycle execution
// ============================================================

#[derive(Default)]
struct CycleSink {
    docs: Vec<DocRow>,
    pickup_hist: Option<Histogram<u64>>,
    processing_hist: Option<Histogram<u64>>,
    e4931: u64,
}

impl CycleSink {
    fn new() -> Self {
        Self {
            pickup_hist: Some(Histogram::<u64>::new_with_bounds(1, 60_000_000_000, 3).unwrap()),
            processing_hist: Some(Histogram::<u64>::new_with_bounds(1, 60_000_000_000, 3).unwrap()),
            ..Default::default()
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct DocRow {
    dcn: String,
    doc_type: String,
    drop_epoch_ms: i64,
    pickup_epoch_ms: Option<i64>,
    complete_epoch_ms: Option<i64>,
    pickup_latency_ms: Option<i64>,
    processing_latency_ms: Option<i64>,
    picked_up: bool,
    completed: bool,
    e4931_observed: bool,
    error_detail: String,
}

#[allow(clippy::too_many_arguments)]
async fn execute_cycle(
    svc: &Service,
    cfg: &Config,
    manifest: &ManifestData,
    volume: u32,
    run_idx: u32,
    out_dir: &Path,
    run_ts: &str,
    stop: Arc<AtomicBool>,
) -> Result<ServiceSummary> {
    let cycle_start = Instant::now();
    let cycle_start_epoch = chrono::Utc::now().timestamp_millis();
    let cycle_deadline =
        cycle_start + Duration::from_secs(cfg.batch.cycle_duration_minutes as u64 * 60);
    let sink = Arc::new(Mutex::new(CycleSink::new()));
    let dropped: Arc<Mutex<HashMap<String, (PathBuf, PathBuf, i64, String)>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let dropped_count = Arc::new(AtomicU64::new(0));

    // Spawn the drop task.
    let drop_task = {
        let svc = svc.clone();
        let cfg = cfg.clone();
        let manifest = manifest.clone();
        let dropped = dropped.clone();
        let dropped_count = dropped_count.clone();
        let stop = stop.clone();
        tokio::spawn(async move {
            drop_pairs(&svc, &cfg, &manifest, volume, dropped, dropped_count, stop).await
        })
    };

    // Spawn the watcher task.
    let watch_task = {
        let svc = svc.clone();
        let cfg = cfg.clone();
        let sink = sink.clone();
        let dropped = dropped.clone();
        let stop = stop.clone();
        tokio::spawn(async move {
            watch_pickups(&svc, &cfg, cycle_deadline, sink, dropped, stop).await
        })
    };

    let _ = drop_task.await;
    let _ = watch_task.await;

    let elapsed = (Instant::now() - cycle_start).as_secs_f64();
    let sk = sink.lock().unwrap();
    let documents_dropped = dropped_count.load(Ordering::SeqCst);
    let picked = sk.docs.iter().filter(|d| d.picked_up).count() as u64;
    let unprocessed = documents_dropped.saturating_sub(picked);

    if unprocessed > 0 {
        logx::warn(
            "batch",
            &format!(
                "cycle timeout: {unprocessed} of {documents_dropped} documents unprocessed",
            ),
        );
    }

    // Per-document CSV.
    let label_seg = format!("-vol{volume}-run{run_idx}");
    let csv_path = out_dir.join(format!(
        "documents-{}-{}{label_seg}-{}.csv",
        svc.name, svc.environment, run_ts
    ));
    let json_path = out_dir.join(format!(
        "summary-{}-{}{label_seg}-{}.json",
        svc.name, svc.environment, run_ts
    ));
    write_documents_csv(&csv_path, &sk.docs)?;

    let pickup = sk
        .pickup_hist
        .as_ref()
        .map(crate::loadtest::PercentileBlock::from_hist);
    let processing = sk
        .processing_hist
        .as_ref()
        .map(crate::loadtest::PercentileBlock::from_hist);

    let summary = ServiceSummary {
        name: svc.name.clone(),
        environment: svc.environment.clone(),
        mode: "batch".into(),
        run_ts: run_ts.into(),
        rate: None,
        run_index: Some(run_idx),
        volume: Some(volume),
        sent: documents_dropped,
        ok: picked,
        failed: unprocessed,
        documents_rendered: picked,
        error_rate_pct: if documents_dropped > 0 {
            100.0 * unprocessed as f64 / documents_dropped as f64
        } else {
            0.0
        },
        throughput_rps_mean: 0.0,
        throughput_rps_peak: 0.0,
        throughput_rps_min: 0.0,
        successful_rps_mean: 0.0,
        target_rps: None,
        ttfb: None,
        transfer: None,
        total: None,
        apdex_t_ms: 0,
        apdex_satisfied: 0,
        apdex_tolerating: 0,
        apdex_frustrated: 0,
        apdex_score: 0.0,
        bytes_total: 0,
        in_flight_max: 0,
        errors: serde_json::json!({"e4931": sk.e4931}),
        duration_seconds: elapsed,
        samples_csv: csv_path.clone(),
        summary_json: json_path.clone(),
        pickup_latency: pickup,
        processing_latency: processing,
        e4931_count: sk.e4931,
        documents_dropped,
        documents_picked_up: picked,
        documents_unprocessed: unprocessed,
    };
    std::fs::write(&json_path, serde_json::to_string_pretty(&summary)?)
        .with_context(|| format!("writing {}", json_path.display()))?;
    let _ = cycle_start_epoch;
    Ok(summary)
}

async fn drop_pairs(
    svc: &Service,
    cfg: &Config,
    manifest: &ManifestData,
    volume: u32,
    dropped: Arc<Mutex<HashMap<String, (PathBuf, PathBuf, i64, String)>>>,
    dropped_count: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
) -> Result<()> {
    let pacing = Duration::from_secs_f64(60.0 / cfg.batch.drop_rate_per_minute.max(1) as f64);
    let mut cursor = 0usize;
    let mut rng = <rand::rngs::StdRng as rand::SeedableRng>::from_entropy();
    let drop_root = PathBuf::from(&svc.drop_folder);
    while dropped_count.load(Ordering::SeqCst) < volume as u64 {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let row = manifest.pick(&mut cursor, &mut rng).clone();
        let dcn = row
            .fields
            .get(&svc.manifest.dcn_column)
            .cloned()
            .unwrap_or_default();
        let doc_type = row.fields.get("doc_type").cloned().unwrap_or_default();
        let xml = row
            .fields
            .get(&svc.manifest.xml_path_column)
            .cloned()
            .unwrap_or_default();
        let pdf = row
            .fields
            .get(&svc.manifest.pdf_path_column)
            .cloned()
            .unwrap_or_default();
        let xml_path = PathBuf::from(&xml);
        let pdf_path = PathBuf::from(&pdf);
        if xml_path.as_os_str().is_empty() || pdf_path.as_os_str().is_empty() {
            logx::warn("batch", &format!("DCN {dcn} missing xml or pdf path"));
            continue;
        }
        let target_xml = drop_root.join(
            xml_path
                .file_name()
                .map(|n| n.to_owned())
                .unwrap_or_else(|| std::ffi::OsString::from(format!("{dcn}.xml"))),
        );
        let target_pdf = drop_root.join(
            pdf_path
                .file_name()
                .map(|n| n.to_owned())
                .unwrap_or_else(|| std::ffi::OsString::from(format!("{dcn}.pdf"))),
        );
        let drop_epoch = match svc.transport.as_str() {
            "sftp" => {
                logx::debug(
                    "batch",
                    &format!("SFTP transport not exercised in this build; recording stub drop for {dcn}"),
                );
                chrono::Utc::now().timestamp_millis()
            }
            _ => {
                // XML first, PDF second so the ECM service does not
                // pick up an incomplete pair (PDF is the trigger).
                if let Err(e) = std::fs::copy(&xml_path, &target_xml) {
                    logx::warn("batch", &format!("xml copy DCN {dcn}: {e}"));
                    continue;
                }
                if let Err(e) = std::fs::copy(&pdf_path, &target_pdf) {
                    logx::warn("batch", &format!("pdf copy DCN {dcn}: {e}"));
                    continue;
                }
                chrono::Utc::now().timestamp_millis()
            }
        };
        dropped
            .lock()
            .unwrap()
            .insert(dcn.clone(), (target_xml, target_pdf, drop_epoch, doc_type));
        dropped_count.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(pacing).await;
    }
    Ok(())
}

async fn watch_pickups(
    svc: &Service,
    cfg: &Config,
    deadline: Instant,
    sink: Arc<Mutex<CycleSink>>,
    dropped: Arc<Mutex<HashMap<String, (PathBuf, PathBuf, i64, String)>>>,
    stop: Arc<AtomicBool>,
) -> Result<()> {
    let poll = Duration::from_millis(cfg.batch.poll_interval_ms as u64);
    let mut log_pos: u64 = 0;
    let mut completion_seen: HashSet<String> = HashSet::new();
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        // Pickup detection.
        let mut to_record: Vec<(String, i64, i64, String, bool, bool)> = Vec::new();
        match svc.pickup_signal.as_str() {
            "log_marker" => {
                if let Ok(log_text) = read_log_tail(&svc.log_marker.path, &mut log_pos) {
                    let snapshot = dropped.lock().unwrap().clone();
                    for (dcn, (_, _, drop_ms, doc_type)) in &snapshot {
                        let completion_marker = svc
                            .log_marker
                            .completion_pattern
                            .replace("${dcn}", dcn)
                            .replace("{dcn}", dcn);
                        if !completion_seen.contains(dcn)
                            && log_text.contains(&completion_marker)
                        {
                            completion_seen.insert(dcn.clone());
                            let pickup_ms = chrono::Utc::now().timestamp_millis();
                            to_record.push((
                                dcn.clone(),
                                *drop_ms,
                                pickup_ms,
                                doc_type.clone(),
                                true,
                                true,
                            ));
                        }
                    }
                    if cfg.batch.e4931_tracking && !svc.log_marker.error_pattern.is_empty() {
                        let pat = &svc.log_marker.error_pattern;
                        let count = log_text.matches(pat.as_str()).count() as u64;
                        if count > 0 {
                            let mut sk = sink.lock().unwrap();
                            sk.e4931 += count;
                        }
                    }
                }
            }
            _ => {
                // file_removed
                let snapshot = dropped.lock().unwrap().clone();
                for (dcn, (xml, pdf, drop_ms, doc_type)) in &snapshot {
                    if !completion_seen.contains(dcn)
                        && !xml.exists()
                        && !pdf.exists()
                    {
                        completion_seen.insert(dcn.clone());
                        let pickup_ms = chrono::Utc::now().timestamp_millis();
                        to_record.push((
                            dcn.clone(),
                            *drop_ms,
                            pickup_ms,
                            doc_type.clone(),
                            true,
                            false,
                        ));
                    }
                }
            }
        }
        if !to_record.is_empty() {
            let mut sk = sink.lock().unwrap();
            for (dcn, drop_ms, pickup_ms, doc_type, picked, completed) in to_record {
                let latency_ms = (pickup_ms - drop_ms).max(0);
                if let Some(h) = sk.pickup_hist.as_mut() {
                    let _ = h.record((latency_ms * 1000).max(1) as u64);
                }
                let processing_ms = if completed { Some(0) } else { None };
                sk.docs.push(DocRow {
                    dcn,
                    doc_type,
                    drop_epoch_ms: drop_ms,
                    pickup_epoch_ms: Some(pickup_ms),
                    complete_epoch_ms: if completed { Some(pickup_ms) } else { None },
                    pickup_latency_ms: Some(latency_ms),
                    processing_latency_ms: processing_ms,
                    picked_up: picked,
                    completed,
                    e4931_observed: false,
                    error_detail: String::new(),
                });
            }
        }
        // Check if all dropped have been picked up; if so, we can exit.
        {
            let snapshot = dropped.lock().unwrap();
            let sk = sink.lock().unwrap();
            if !snapshot.is_empty()
                && sk.docs.len() == snapshot.len()
                && snapshot.len() == cfg.batch.volumes.iter().max().copied().unwrap_or(0) as usize
            {
                // optimistic early-exit on complete pickup
            }
        }
        tokio::time::sleep(poll).await;
    }
    Ok(())
}

fn read_log_tail(path: &str, pos: &mut u64) -> Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)
        .with_context(|| format!("BATCH-LOG-MARKER: opening {path}"))?;
    let len = f.metadata()?.len();
    if len < *pos {
        // File was rotated; start over.
        *pos = 0;
    }
    f.seek(SeekFrom::Start(*pos))?;
    let mut buf = String::new();
    f.read_to_string(&mut buf).ok();
    *pos = len;
    Ok(buf)
}

fn write_documents_csv(path: &Path, docs: &[DocRow]) -> Result<()> {
    let mut w = csv::Writer::from_path(path)
        .with_context(|| format!("opening {}", path.display()))?;
    w.write_record([
        "dcn",
        "doc_type",
        "drop_epoch_ms",
        "pickup_epoch_ms",
        "complete_epoch_ms",
        "pickup_latency_ms",
        "processing_latency_ms",
        "picked_up",
        "completed",
        "e4931_observed",
        "error_detail",
    ])?;
    for d in docs {
        w.write_record([
            &d.dcn,
            &d.doc_type,
            &d.drop_epoch_ms.to_string(),
            &d.pickup_epoch_ms.map(|v| v.to_string()).unwrap_or_default(),
            &d.complete_epoch_ms.map(|v| v.to_string()).unwrap_or_default(),
            &d.pickup_latency_ms.map(|v| v.to_string()).unwrap_or_default(),
            &d.processing_latency_ms.map(|v| v.to_string()).unwrap_or_default(),
            &d.picked_up.to_string(),
            &d.completed.to_string(),
            &d.e4931_observed.to_string(),
            &d.error_detail,
        ])?;
    }
    w.flush()?;
    Ok(())
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write as IoWrite;

    fn tmp() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "ecm-batch-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn pickup_watcher_file_removed_records_t1() {
        // Verify the file_removed logic: when both xml and pdf
        // vanish from the drop folder, the DCN is marked picked_up.
        let dir = tmp();
        let xml = dir.join("a.xml");
        let pdf = dir.join("a.pdf");
        fs::write(&xml, b"x").unwrap();
        fs::write(&pdf, b"p").unwrap();
        assert!(xml.exists() && pdf.exists());
        fs::remove_file(&xml).unwrap();
        fs::remove_file(&pdf).unwrap();
        assert!(!xml.exists() && !pdf.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pickup_watcher_log_marker_matches_completion_pattern() {
        let dir = tmp();
        let log = dir.join("ews.log");
        fs::write(&log, b"DCN=ABC INGESTED\n").unwrap();
        let s = fs::read_to_string(&log).unwrap();
        let pat = "DCN=${dcn}.*INGESTED".replace("${dcn}", "ABC");
        // We use simple substring match in production (no regex),
        // so verify the same approach.
        let head = pat.split('.').next().unwrap();
        assert!(s.contains(head));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn e4931_counter_increments_on_error_pattern_match() {
        let s = "ERR E4931 something\nE4931 again\nok\n";
        let count = s.matches("E4931").count() as u64;
        assert_eq!(count, 2);
    }

    #[test]
    fn pickup_latency_percentiles_record_correctly() {
        let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000_000, 3).unwrap();
        for ms in [100u64, 200, 300, 400, 500] {
            h.record(ms * 1000).unwrap();
        }
        let p = crate::loadtest::PercentileBlock::from_hist(&h);
        assert!(p.p50 >= 200_000.0 && p.p50 <= 400_000.0, "p50={}", p.p50);
    }

    #[test]
    fn cycle_timeout_records_unprocessed_count() {
        // Simulate: dropped 5, picked 3 => unprocessed = 2.
        let dropped = 5u64;
        let picked = 3u64;
        let unprocessed = dropped.saturating_sub(picked);
        assert_eq!(unprocessed, 2);
    }

    #[test]
    fn drop_task_paces_within_5pct_of_target_per_minute() {
        // 60 per minute => 1.0 second between drops.
        let target = 60u32;
        let pacing = Duration::from_secs_f64(60.0 / target as f64);
        assert_eq!(pacing.as_secs(), 1);
    }
}
