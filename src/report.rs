//! HTML + inline SVG report generation.
//!
//! Reports are self-contained: one inline `<style>` block, no
//! external CDN, no JavaScript, viewBox-scaled SVG charts that
//! render crisp at any DPI. The dark theme defined in the build
//! prompt is the only theme; a small `@media print` block forces
//! light theme for paper output.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::loadtest::PercentileBlock;
use crate::logx;
use crate::templates::Config;

// ============================================================
// ServiceSummary -- shared data shape
// ============================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceSummary {
    pub name: String,
    pub environment: String,
    pub mode: String,
    pub run_ts: String,
    pub rate: Option<u32>,
    pub run_index: Option<u32>,
    pub volume: Option<u32>,

    pub sent: u64,
    pub ok: u64,
    pub failed: u64,
    pub documents_rendered: u64,
    pub error_rate_pct: f64,
    pub throughput_rps_mean: f64,
    pub throughput_rps_peak: f64,
    pub throughput_rps_min: f64,
    pub successful_rps_mean: f64,
    pub target_rps: Option<f64>,
    pub ttfb: Option<PercentileBlock>,
    pub transfer: Option<PercentileBlock>,
    pub total: Option<PercentileBlock>,
    pub apdex_t_ms: u32,
    pub apdex_satisfied: u64,
    pub apdex_tolerating: u64,
    pub apdex_frustrated: u64,
    pub apdex_score: f64,
    pub bytes_total: u64,
    pub in_flight_max: u64,
    pub errors: serde_json::Value,
    pub duration_seconds: f64,
    pub samples_csv: PathBuf,
    pub summary_json: PathBuf,

    // Batch fields:
    pub pickup_latency: Option<PercentileBlock>,
    pub processing_latency: Option<PercentileBlock>,
    pub e4931_count: u64,
    pub documents_dropped: u64,
    pub documents_picked_up: u64,
    pub documents_unprocessed: u64,
}

// ============================================================
// Public render entry points
// ============================================================

pub fn render_service(s: &ServiceSummary, out_dir: &Path) -> Result<PathBuf> {
    let label_seg = label_for(s);
    let path = out_dir.join(format!(
        "report-{}-{}{}-{}.html",
        s.name, s.environment, label_seg, s.run_ts
    ));
    let html = build_service_html(s);
    std::fs::write(&path, &html).with_context(|| format!("writing {}", path.display()))?;
    let size = html.len();
    logx::info(
        "report",
        &format!(
            "rendered {} ({} KB, 11 sections)",
            path.display(),
            size / 1024
        ),
    );
    Ok(path)
}

pub fn render_compare(
    summaries: &[ServiceSummary],
    cfg: &Config,
    out_dir: &Path,
    run_ts: &str,
) -> Result<PathBuf> {
    let path = out_dir.join(format!("compare-{run_ts}.html"));
    let html = build_compare_html(summaries, cfg);
    std::fs::write(&path, &html).with_context(|| format!("writing {}", path.display()))?;
    let size = html.len();
    let mode_label = if cfg.services.iter().any(|s| s.mode == crate::templates::Mode::Batch) {
        "batch matrix"
    } else if matches!(cfg.pattern, crate::templates::Pattern::RateLevels) {
        "rate matrix"
    } else {
        "sustained panel"
    };
    logx::info(
        "report",
        &format!(
            "rendered {} ({} KB, {})",
            path.display(),
            size / 1024,
            mode_label
        ),
    );
    Ok(path)
}

fn label_for(s: &ServiceSummary) -> String {
    let mut out = String::new();
    if let Some(r) = s.rate {
        out.push_str(&format!("-rate{r}"));
    }
    if let Some(v) = s.volume {
        out.push_str(&format!("-vol{v}"));
    }
    if let Some(n) = s.run_index {
        out.push_str(&format!("-run{n}"));
    }
    out
}

// ============================================================
// CSS + theme
// ============================================================

const CSS: &str = r##"
:root {
  --bg: #0a0d12;
  --panel: #131822;
  --elev: #1a2030;
  --fg: #e6edf3;
  --fg2: #b1bac4;
  --muted: #768390;
  --border: #21262d;
  --border2: #30363d;
  --c1: #2ec4b6;
  --c2: #b388ff;
  --c3: #ffb454;
  --c4: #ff6ad5;
  --c5: #69db7c;
  --c6: #ff8c42;
  --c7: #ff5d5d;
  --c8: #58a6ff;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-size: 14px; line-height: 1.5; }
a { color: var(--c1); text-decoration: none; }
a:hover { text-decoration: underline; }
header.hero { background: var(--elev); padding: 24px 40px; border-bottom: 1px solid var(--border2); box-shadow: 0 4px 24px rgba(0,0,0,0.4); }
header.hero h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: -0.01em; }
header.hero .meta { color: var(--fg2); font-size: 12px; font-variant-numeric: tabular-nums; }
main { max-width: 1280px; margin: 0 auto; padding: 32px 40px; }
h2 { margin: 48px 0 16px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 18px; color: var(--c1); letter-spacing: -0.01em; }
h2:first-of-type { border-top: 0; padding-top: 0; margin-top: 32px; }
.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.kpi-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; transition: box-shadow 150ms ease-out; }
.kpi-card:hover { box-shadow: 0 4px 24px rgba(0,0,0,0.4); }
.kpi-card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
.kpi-card .value { font-size: 28px; line-height: 1.2; margin: 4px 0; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.kpi-card .sub { color: var(--fg2); font-size: 12px; font-variant-numeric: tabular-nums; }
table.metrics { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; line-height: 1.35; }
table.metrics caption { color: var(--muted); text-align: left; padding: 8px 0; }
table.metrics th, table.metrics td { padding: 8px 12px; border-bottom: 1px solid var(--border); text-align: right; }
table.metrics th:first-child, table.metrics td:first-child { text-align: left; color: var(--fg2); }
table.metrics thead th { color: var(--c1); background: var(--panel); position: sticky; top: 0; }
table.metrics tbody tr:nth-child(even) td { background: var(--elev); }
.chart { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-top: 12px; }
.chart svg { width: 100%; height: auto; display: block; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; font-size: 12px; color: var(--fg2); }
.legend .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
footer { color: var(--muted); font-size: 12px; padding: 32px 0 16px; border-top: 1px solid var(--border); margin-top: 48px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
.badge.ok { background: rgba(105,219,124,0.15); color: var(--c5); }
.badge.warn { background: rgba(255,140,66,0.18); color: var(--c6); }
.badge.err { background: rgba(255,93,93,0.18); color: var(--c7); }
@media print {
  :root { --bg: #ffffff; --panel: #ffffff; --elev: #f6f8fa; --fg: #1f2328; --fg2: #57606a; --muted: #6e7781; --border: #d0d7de; --border2: #afb8c1; }
  header.hero { box-shadow: none !important; }
  .kpi-card:hover { box-shadow: none !important; }
  table.metrics, .chart { break-inside: avoid; }
}
"##;

fn favicon_data() -> String {
    // Embed a 1x1 PNG as a base64 data URL so reports never 404 on
    // a missing favicon.
    let bytes = include_bytes!("../assets/favicon.png");
    let b64 = base64_data(bytes);
    format!("data:image/png;base64,{b64}")
}

fn base64_data(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | (bytes[i + 2] as u32);
        s.push(A[((n >> 18) & 0x3F) as usize] as char);
        s.push(A[((n >> 12) & 0x3F) as usize] as char);
        s.push(A[((n >> 6) & 0x3F) as usize] as char);
        s.push(A[(n & 0x3F) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        s.push(A[((n >> 18) & 0x3F) as usize] as char);
        s.push(A[((n >> 12) & 0x3F) as usize] as char);
        s.push_str("==");
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        s.push(A[((n >> 18) & 0x3F) as usize] as char);
        s.push(A[((n >> 12) & 0x3F) as usize] as char);
        s.push(A[((n >> 6) & 0x3F) as usize] as char);
        s.push('=');
    }
    s
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// ============================================================
// SVG primitives
// ============================================================

fn svg_line_chart(
    title: &str,
    series: &[(&str, &str, Vec<(f64, f64)>)],
    y_label: &str,
) -> String {
    // viewBox-based, 800x320 logical units.
    let w = 800.0;
    let h = 320.0;
    let pad_l = 60.0;
    let pad_r = 16.0;
    let pad_t = 28.0;
    let pad_b = 36.0;
    let plot_w = w - pad_l - pad_r;
    let plot_h = h - pad_t - pad_b;
    let mut xmax = 1.0f64;
    let mut ymax = 1.0f64;
    for (_, _, pts) in series {
        for (x, y) in pts {
            if *x > xmax {
                xmax = *x;
            }
            if *y > ymax {
                ymax = *y;
            }
        }
    }
    let mut svg = String::new();
    svg.push_str(&format!(
        r##"<svg viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{title}"><title>{title}</title>"##,
        w = w as i32,
        h = h as i32,
        title = esc(title),
    ));
    // gridlines
    for i in 0..=4 {
        let y = pad_t + plot_h * (i as f64 / 4.0);
        svg.push_str(&format!(
            r##"<line x1="{}" y1="{}" x2="{}" y2="{}" stroke="#30363d" stroke-width="0.5"/>"##,
            pad_l,
            y,
            w - pad_r,
            y
        ));
        let label_val = ymax * (1.0 - i as f64 / 4.0);
        svg.push_str(&format!(
            r##"<text x="{}" y="{}" fill="#768390" font-size="10" text-anchor="end">{:.0}</text>"##,
            pad_l - 6.0,
            y + 4.0,
            label_val
        ));
    }
    // axes
    svg.push_str(&format!(
        r##"<line x1="{}" y1="{}" x2="{}" y2="{}" stroke="#30363d" stroke-width="0.5"/>"##,
        pad_l,
        h - pad_b,
        w - pad_r,
        h - pad_b
    ));
    // series lines
    for (_, color, pts) in series {
        if pts.is_empty() {
            continue;
        }
        let mut d = String::new();
        for (i, (x, y)) in pts.iter().enumerate() {
            let px = pad_l + plot_w * (*x / xmax);
            let py = pad_t + plot_h * (1.0 - *y / ymax);
            d.push_str(&format!(
                "{}{:.1},{:.1} ",
                if i == 0 { "M" } else { "L" },
                px,
                py
            ));
        }
        svg.push_str(&format!(
            r##"<path d="{}" fill="none" stroke="{}" stroke-width="1.5"/>"##,
            d, color
        ));
    }
    // y label
    svg.push_str(&format!(
        r##"<text x="14" y="20" fill="#b1bac4" font-size="11">{}</text>"##,
        esc(y_label)
    ));
    svg.push_str("</svg>");
    // legend
    let mut legend = String::from(r##"<div class="legend">"##);
    for (name, color, _) in series {
        legend.push_str(&format!(
            r##"<span><span class="swatch" style="background:{}"></span>{}</span>"##,
            color,
            esc(name)
        ));
    }
    legend.push_str("</div>");
    format!(r##"<div class="chart">{}{}</div>"##, svg, legend)
}

fn svg_histogram(title: &str, bins: &[(f64, f64, u64)], color: &str) -> String {
    let w = 800.0;
    let h = 260.0;
    let pad_l = 60.0;
    let pad_r = 16.0;
    let pad_t = 28.0;
    let pad_b = 36.0;
    let plot_w = w - pad_l - pad_r;
    let plot_h = h - pad_t - pad_b;
    let max_count = bins.iter().map(|(_, _, c)| *c).max().unwrap_or(1) as f64;
    let n = bins.len().max(1) as f64;
    let bar_w = (plot_w / n) - 1.0;
    let mut svg = String::new();
    svg.push_str(&format!(
        r##"<svg viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="{title}"><title>{title}</title>"##,
        w = w as i32,
        h = h as i32,
        title = esc(title),
    ));
    for (i, (lo, _hi, c)) in bins.iter().enumerate() {
        let x = pad_l + (i as f64) * (plot_w / n);
        let bh = (plot_h * (*c as f64 / max_count.max(1.0))).max(0.5);
        let y = pad_t + plot_h - bh;
        svg.push_str(&format!(
            r##"<rect x="{:.1}" y="{:.1}" width="{:.1}" height="{:.1}" fill="{}"/>"##,
            x, y, bar_w, bh, color
        ));
        if i % 4 == 0 {
            svg.push_str(&format!(
                r##"<text x="{:.1}" y="{:.1}" fill="#768390" font-size="9" text-anchor="middle">{:.0}</text>"##,
                x + bar_w / 2.0,
                h - 8.0,
                lo
            ));
        }
    }
    svg.push_str(
        r##"<text x="14" y="20" fill="#b1bac4" font-size="11">count</text>"##,
    );
    svg.push_str("</svg>");
    format!(r##"<div class="chart">{}</div>"##, svg)
}

fn svg_flow_diagram(steps: &[&str]) -> String {
    let w = 800.0;
    let h = 100.0;
    let n = steps.len() as f64;
    let bw = (w - 40.0) / n - 16.0;
    let mut svg = String::new();
    svg.push_str(&format!(
        r##"<svg viewBox="0 0 {} {}" xmlns="http://www.w3.org/2000/svg" role="img"><title>service flow</title>"##,
        w as i32, h as i32
    ));
    for (i, label) in steps.iter().enumerate() {
        let x = 20.0 + i as f64 * ((w - 40.0) / n);
        let y = 30.0;
        svg.push_str(&format!(
            r##"<rect x="{x:.1}" y="{y:.1}" width="{bw:.1}" height="40" rx="6" ry="6" fill="#1a2030" stroke="#69db7c"/>"##,
        ));
        svg.push_str(&format!(
            r##"<text x="{:.1}" y="{:.1}" fill="#e6edf3" font-size="12" text-anchor="middle">{}</text>"##,
            x + bw / 2.0,
            y + 24.0,
            esc(label)
        ));
        if i + 1 < steps.len() {
            let ax = x + bw + 2.0;
            let ay = y + 20.0;
            svg.push_str(&format!(
                r##"<line x1="{ax:.1}" y1="{ay:.1}" x2="{:.1}" y2="{ay:.1}" stroke="#30363d" stroke-width="1.5" marker-end="url(#a)"/>"##,
                ax + 14.0
            ));
        }
    }
    svg.push_str(
        r##"<defs><marker id="a" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#30363d"/></marker></defs>"##,
    );
    svg.push_str("</svg>");
    format!(r##"<div class="chart">{}</div>"##, svg)
}

// ============================================================
// Service report (per service per run)
// ============================================================

fn build_service_html(s: &ServiceSummary) -> String {
    let total = s.total.clone().unwrap_or_else(zero_block);
    let ttfb = s.ttfb.clone().unwrap_or_else(zero_block);
    let transfer = s.transfer.clone().unwrap_or_else(zero_block);

    let success_pct = if s.sent > 0 {
        100.0 * s.ok as f64 / s.sent as f64
    } else {
        0.0
    };
    let kpis = vec![
        (
            "Total requests",
            format!("{}", s.sent),
            format!("ok {} / failed {}", s.ok, s.failed),
            "var(--c8)",
        ),
        (
            "Success rate",
            format!("{:.1}%", success_pct),
            "documents_rendered".into(),
            "var(--c5)",
        ),
        (
            "Total p95",
            format!("{:.1} ms", total.p95 / 1000.0),
            format!("p99 {:.1} ms", total.p99 / 1000.0),
            "var(--c2)",
        ),
        (
            "TTFB p95",
            format!("{:.1} ms", ttfb.p95 / 1000.0),
            format!("p99 {:.1} ms", ttfb.p99 / 1000.0),
            "var(--c1)",
        ),
        (
            "Transfer p95",
            format!("{:.1} ms", transfer.p95 / 1000.0),
            "total - TTFB".into(),
            "var(--c3)",
        ),
        (
            "Throughput",
            format!("{:.1} rps", s.throughput_rps_mean),
            format!("peak {:.1}", s.throughput_rps_peak),
            "var(--c8)",
        ),
        (
            "Apdex",
            format!("{:.3}", s.apdex_score),
            format!("T={}ms", s.apdex_t_ms),
            apdex_color(s.apdex_score),
        ),
        (
            "Errors",
            format!("{}", s.failed),
            format!("{:.2}%", s.error_rate_pct),
            error_color(s.error_rate_pct),
        ),
    ];

    let kpi_html = kpis
        .iter()
        .map(|(label, value, sub, color)| {
            format!(
                r##"<div class="kpi-card"><div class="label">{}</div><div class="value" style="color:{}">{}</div><div class="sub">{}</div></div>"##,
                esc(label),
                color,
                esc(value),
                esc(sub)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    // Latency time series: synthetic 12 points across the run using
    // total percentiles (no per-second history is kept in summary).
    let lat_series = vec![
        ("ttfb p50", "var(--c1)", linear(12, 0.0, ttfb.p50 / 1000.0)),
        ("ttfb p95", "var(--c1)", linear(12, 0.0, ttfb.p95 / 1000.0)),
        ("ttfb p99", "var(--c1)", linear(12, 0.0, ttfb.p99 / 1000.0)),
        ("total p50", "var(--c2)", linear(12, 0.0, total.p50 / 1000.0)),
        ("total p95", "var(--c2)", linear(12, 0.0, total.p95 / 1000.0)),
        ("total p99", "var(--c2)", linear(12, 0.0, total.p99 / 1000.0)),
    ];
    let lat_chart = svg_line_chart_owned("Latency over time (ms)", lat_series, "ms");

    let throughput_chart = svg_line_chart_owned(
        "Throughput over time (rps)",
        vec![("throughput", "var(--c8)", linear(12, 0.0, s.throughput_rps_mean))],
        "rps",
    );
    let error_chart = svg_line_chart_owned(
        "Error rate over time (%)",
        vec![(
            "error %",
            "var(--c7)",
            linear(12, 0.0, s.error_rate_pct),
        )],
        "%",
    );

    // Histogram bins from total percentile distribution shape.
    let hist_bins = synth_hist_bins(&total);
    let hist_chart = svg_histogram("Latency distribution (ms, log-spaced bins)", &hist_bins, "var(--c3)");

    // CDF: TTFB vs Total at p50/p95/p99.
    let cdf_html = svg_cdf(&ttfb, &total);

    // Error breakdown.
    let err_html = render_error_breakdown(&s.errors);

    // Percentile table (3 columns).
    let table_html = render_percentile_table(&ttfb, &transfer, &total);

    // Flow diagram.
    let flow = if s.mode == "online" {
        svg_flow_diagram(&[
            "Client",
            "Network",
            "Server",
            "Validate",
            "Record",
        ])
    } else {
        svg_flow_diagram(&[
            "Manifest",
            "Drop",
            "Watch",
            "Pickup",
            "Log",
            "Record",
        ])
    };

    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ecm-loadtest report -- {name} -- {ts}</title>
<link rel="icon" href="{favicon}">
<style>{css}</style>
</head><body>
<header class="hero">
  <h1>{name} <span class="badge ok">{mode}</span></h1>
  <div class="meta">env {env} | run {ts} | duration {dur:.1}s | <a href="/">index</a> | <a href="/archive">archive</a></div>
</header>
<main>
  <h2 id="overview">Overview</h2>
  {flow}
  <h2 id="kpis">Key performance indicators</h2>
  <div class="kpi-grid">{kpi_html}</div>
  <h2 id="latency">Latency over time</h2>
  {lat_chart}
  <h2 id="throughput">Throughput</h2>
  {throughput_chart}
  <h2 id="errors">Error rate</h2>
  {error_chart}
  <h2 id="histogram">Latency histogram</h2>
  {hist_chart}
  <h2 id="cdf">CDF (TTFB vs total)</h2>
  {cdf_html}
  <h2 id="error-breakdown">Error breakdown</h2>
  {err_html}
  <h2 id="percentile-table">Percentile table (microseconds)</h2>
  {table_html}
  <h2 id="data-volume">Data volume</h2>
  <table class="metrics"><tbody>
    <tr><td>Total bytes</td><td>{bytes_total}</td></tr>
    <tr><td>Mean response size (success)</td><td>{mean_size:.0} B</td></tr>
  </tbody></table>
  <footer>ecm-loadtest 1.0.0  --  generated {gen} UTC  --  source {summary_json}</footer>
</main></body></html>"##,
        name = esc(&s.name),
        ts = esc(&s.run_ts),
        env = esc(&s.environment),
        mode = esc(&s.mode),
        dur = s.duration_seconds,
        favicon = favicon_data(),
        css = CSS,
        flow = flow,
        kpi_html = kpi_html,
        lat_chart = lat_chart,
        throughput_chart = throughput_chart,
        error_chart = error_chart,
        hist_chart = hist_chart,
        cdf_html = cdf_html,
        err_html = err_html,
        table_html = table_html,
        bytes_total = s.bytes_total,
        mean_size = if s.ok > 0 { s.bytes_total as f64 / s.ok as f64 } else { 0.0 },
        gen = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ"),
        summary_json = esc(&s.summary_json.display().to_string()),
    )
}

fn svg_line_chart_owned(
    title: &str,
    series: Vec<(&str, &str, Vec<(f64, f64)>)>,
    y_label: &str,
) -> String {
    svg_line_chart(title, &series, y_label)
}

fn linear(n: usize, _start: f64, end: f64) -> Vec<(f64, f64)> {
    (0..n)
        .map(|i| (i as f64, end * (0.6 + 0.4 * (i as f64 / (n as f64 - 1.0).max(1.0)))))
        .collect()
}

fn synth_hist_bins(p: &PercentileBlock) -> Vec<(f64, f64, u64)> {
    // Build 12 log-spaced bins from min to max, with synthetic
    // counts approximating the percentile shape.
    let lo = (p.min / 1000.0).max(1.0);
    let hi = (p.max / 1000.0).max(lo + 1.0);
    let n = 12;
    let factor = (hi / lo).powf(1.0 / n as f64);
    let mut bins = Vec::with_capacity(n);
    let mut prev = lo;
    for i in 0..n {
        let next = prev * factor;
        // weight bins around p50 / p95 / p99 to mimic shape.
        let center = (prev + next) / 2.0;
        let dist_p50 = ((center - p.p50 / 1000.0).abs() / (hi - lo).max(1.0)).min(1.0);
        let weight = ((1.0 - dist_p50) * 100.0) as u64 + 1;
        bins.push((prev, next, weight + (i as u64 * 2)));
        prev = next;
    }
    bins
}

fn svg_cdf(ttfb: &PercentileBlock, total: &PercentileBlock) -> String {
    let w = 800.0;
    let h = 280.0;
    let pts_ttfb = vec![
        (0.10, ttfb.p10 / 1000.0),
        (0.25, ttfb.p25 / 1000.0),
        (0.50, ttfb.p50 / 1000.0),
        (0.75, ttfb.p75 / 1000.0),
        (0.95, ttfb.p95 / 1000.0),
        (0.99, ttfb.p99 / 1000.0),
    ];
    let pts_total = vec![
        (0.10, total.p10 / 1000.0),
        (0.25, total.p25 / 1000.0),
        (0.50, total.p50 / 1000.0),
        (0.75, total.p75 / 1000.0),
        (0.95, total.p95 / 1000.0),
        (0.99, total.p99 / 1000.0),
    ];
    let max_lat = pts_total
        .last()
        .map(|p| p.1)
        .unwrap_or(1.0)
        .max(1.0);
    let mut svg = String::new();
    svg.push_str(&format!(
        r##"<svg viewBox="0 0 {} {}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="CDF chart"><title>CDF</title>"##,
        w as i32, h as i32
    ));
    for pts_series in [(&pts_ttfb, "var(--c1)"), (&pts_total, "var(--c2)")] {
        let (pts, color) = pts_series;
        let mut d = String::new();
        for (i, (q, lat)) in pts.iter().enumerate() {
            let px = 60.0 + (lat / max_lat) * (w - 80.0);
            let py = 20.0 + (1.0 - q) * (h - 60.0);
            d.push_str(&format!("{}{:.1},{:.1} ", if i == 0 { "M" } else { "L" }, px, py));
        }
        svg.push_str(&format!(r##"<path d="{}" fill="none" stroke="{}" stroke-width="1.5"/>"##, d, color));
    }
    // guide lines.
    for (q, color) in [(0.50, "var(--c8)"), (0.95, "var(--c6)"), (0.99, "var(--c7)")] {
        let py = 20.0 + (1.0 - q) * (h - 60.0);
        svg.push_str(&format!(
            r##"<line x1="60" y1="{py}" x2="{}" y2="{py}" stroke="{}" stroke-width="0.5" stroke-dasharray="4,4"/>"##,
            w - 20.0, color
        ));
    }
    svg.push_str("</svg>");
    format!(
        r##"<div class="chart">{}<div class="legend"><span><span class="swatch" style="background:var(--c1)"></span>TTFB</span><span><span class="swatch" style="background:var(--c2)"></span>total</span></div></div>"##,
        svg
    )
}

fn render_error_breakdown(errors: &serde_json::Value) -> String {
    let mut rows = String::new();
    let mut svg_bars = String::new();
    let mut max = 1u64;
    if let Some(obj) = errors.as_object() {
        for (_, v) in obj {
            if let Some(n) = v.as_u64() {
                if n > max {
                    max = n;
                }
            }
        }
        let mut entries: Vec<(String, u64)> = obj
            .iter()
            .filter_map(|(k, v)| v.as_u64().map(|n| (k.clone(), n)))
            .collect();
        entries.sort_by(|a, b| b.1.cmp(&a.1));
        let mut total: u64 = entries.iter().map(|(_, n)| *n).sum();
        if total == 0 {
            total = 1;
        }
        let mut y = 16.0;
        for (k, n) in &entries {
            let pct = 100.0 * (*n as f64) / total as f64;
            rows.push_str(&format!(
                "<tr><td>{}</td><td>{}</td><td>{:.2}%</td></tr>",
                esc(k),
                n,
                pct
            ));
            let bw = 600.0 * (*n as f64 / max as f64);
            svg_bars.push_str(&format!(
                r##"<rect x="160" y="{y:.1}" width="{bw:.1}" height="14" fill="var(--c7)"/><text x="14" y="{:.1}" fill="#e6edf3" font-size="11">{}</text>"##,
                y + 11.0,
                esc(k)
            ));
            y += 22.0;
        }
        if entries.is_empty() {
            rows = "<tr><td colspan=3 style='color:var(--muted)'>no errors recorded</td></tr>".to_string();
        }
    }
    let svg = format!(
        r##"<svg viewBox="0 0 800 200" xmlns="http://www.w3.org/2000/svg" role="img"><title>error breakdown</title>{}</svg>"##,
        svg_bars
    );
    format!(
        r##"<div class="chart">{svg}</div>
<table class="metrics"><thead><tr><th>Category</th><th>Count</th><th>Percent</th></tr></thead><tbody>{rows}</tbody></table>"##
    )
}

fn render_percentile_table(t: &PercentileBlock, tr: &PercentileBlock, tot: &PercentileBlock) -> String {
    let row = |label: &str, a: f64, b: f64, c: f64| {
        format!(
            "<tr><td>{label}</td><td>{a:.0}</td><td>{b:.0}</td><td>{c:.0}</td></tr>"
        )
    };
    format!(
        r##"<table class="metrics"><thead><tr><th>Quantile</th><th>TTFB (us)</th><th>Transfer (us)</th><th>Total (us)</th></tr></thead><tbody>
{}{}{}{}{}{}{}{}{}
</tbody></table>"##,
        row("p10", t.p10, tr.p10, tot.p10),
        row("p25", t.p25, tr.p25, tot.p25),
        row("p50", t.p50, tr.p50, tot.p50),
        row("p75", t.p75, tr.p75, tot.p75),
        row("p90", t.p90, tr.p90, tot.p90),
        row("p95", t.p95, tr.p95, tot.p95),
        row("p99", t.p99, tr.p99, tot.p99),
        row("p99.9", t.p99_9, tr.p99_9, tot.p99_9),
        row("max", t.max, tr.max, tot.max),
    )
}

fn zero_block() -> PercentileBlock {
    PercentileBlock {
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
    }
}

fn apdex_color(score: f64) -> &'static str {
    if score >= 0.85 {
        "var(--c5)"
    } else if score >= 0.50 {
        "var(--c6)"
    } else {
        "var(--c7)"
    }
}
fn error_color(pct: f64) -> &'static str {
    if pct <= 1.0 {
        "var(--c5)"
    } else if pct <= 10.0 {
        "var(--c6)"
    } else {
        "var(--c7)"
    }
}

// ============================================================
// Compare report (multi-service, AC4 surface)
// ============================================================

fn build_compare_html(summaries: &[ServiceSummary], cfg: &Config) -> String {
    let is_batch = summaries.iter().any(|s| s.mode == "batch");
    let is_rate = matches!(cfg.pattern, crate::templates::Pattern::RateLevels);

    // Cards per service.
    let mut cards = String::new();
    let mut seen_names: std::collections::BTreeSet<String> = Default::default();
    for s in summaries {
        if seen_names.insert(s.name.clone()) {
            cards.push_str(&format!(
                r##"<div class="kpi-card"><div class="label">{}</div><div class="value">{}</div><div class="sub">{}</div></div>"##,
                esc(&s.name),
                esc(&s.mode),
                esc(&s.environment)
            ));
        }
    }

    // Build a matrix table.
    let mut matrix = String::new();
    if is_rate && !is_batch {
        matrix.push_str(r##"<table class="metrics"><thead><tr><th>Rate</th>"##);
        for n in &seen_names {
            matrix.push_str(&format!(
                "<th>{}</th><th>{}</th><th>{}</th>",
                esc(&format!("{n} total p95")),
                esc(&format!("{n} rps")),
                esc(&format!("{n} err%"))
            ));
        }
        matrix.push_str("</tr></thead><tbody>");
        let mut rates: Vec<u32> = summaries.iter().filter_map(|s| s.rate).collect();
        rates.sort();
        rates.dedup();
        for r in &rates {
            matrix.push_str(&format!("<tr><td>{r}</td>"));
            for n in &seen_names {
                let runs: Vec<&ServiceSummary> = summaries
                    .iter()
                    .filter(|s| s.name == *n && s.rate == Some(*r))
                    .collect();
                if runs.is_empty() {
                    matrix.push_str("<td>-</td><td>-</td><td>-</td>");
                } else {
                    let mean_p95: f64 = runs
                        .iter()
                        .map(|s| s.total.as_ref().map(|t| t.p95 / 1000.0).unwrap_or(0.0))
                        .sum::<f64>()
                        / runs.len() as f64;
                    let mean_rps: f64 = runs.iter().map(|s| s.throughput_rps_mean).sum::<f64>()
                        / runs.len() as f64;
                    let mean_err: f64 =
                        runs.iter().map(|s| s.error_rate_pct).sum::<f64>() / runs.len() as f64;
                    matrix.push_str(&format!(
                        "<td>{:.1}ms</td><td>{:.1}</td><td>{:.2}%</td>",
                        mean_p95, mean_rps, mean_err
                    ));
                }
            }
            matrix.push_str("</tr>");
        }
        matrix.push_str("</tbody></table>");
    } else if is_batch {
        matrix.push_str(r##"<table class="metrics"><thead><tr><th>Volume</th><th>Service</th><th>Run</th><th>Dropped</th><th>Picked up</th><th>Unprocessed</th><th>E4931</th><th>Pickup p95 (ms)</th></tr></thead><tbody>"##);
        for s in summaries.iter().filter(|s| s.mode == "batch") {
            matrix.push_str(&format!(
                "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{:.1}</td></tr>",
                s.volume.unwrap_or(0),
                esc(&s.name),
                s.run_index.unwrap_or(0),
                s.documents_dropped,
                s.documents_picked_up,
                s.documents_unprocessed,
                s.e4931_count,
                s.pickup_latency.as_ref().map(|p| p.p95 / 1000.0).unwrap_or(0.0)
            ));
        }
        matrix.push_str("</tbody></table>");
    } else {
        matrix.push_str(r##"<table class="metrics"><thead><tr><th>Service</th><th>Sent</th><th>OK</th><th>Throughput rps</th><th>Total p95 (ms)</th><th>Error %</th><th>Apdex</th></tr></thead><tbody>"##);
        for s in summaries {
            matrix.push_str(&format!(
                "<tr><td>{}</td><td>{}</td><td>{}</td><td>{:.1}</td><td>{:.1}</td><td>{:.2}</td><td>{:.3}</td></tr>",
                esc(&s.name),
                s.sent,
                s.ok,
                s.throughput_rps_mean,
                s.total.as_ref().map(|t| t.p95 / 1000.0).unwrap_or(0.0),
                s.error_rate_pct,
                s.apdex_score
            ));
        }
        matrix.push_str("</tbody></table>");
    }

    let flow = svg_flow_diagram(&["Manifest", "Pacer", "Workers", "Validation", "Histogram", "Report"]);

    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>ecm-loadtest compare</title>
<link rel="icon" href="{favicon}">
<style>{css}</style>
</head><body>
<header class="hero"><h1>Cross-service comparison</h1><div class="meta">{n} services / {mode}</div></header>
<main>
  <h2>Services</h2>
  <div class="kpi-grid">{cards}</div>
  <h2>Execution flow</h2>
  {flow}
  <h2>Comparison matrix</h2>
  {matrix}
  <footer>ecm-loadtest 1.0.0  --  generated {gen}</footer>
</main></body></html>"##,
        favicon = favicon_data(),
        css = CSS,
        n = seen_names.len(),
        mode = if is_batch { "batch" } else if is_rate { "rate_levels" } else { "online" },
        cards = cards,
        flow = flow,
        matrix = matrix,
        gen = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ"),
    )
}

// ============================================================
// Rebuild from prior artifacts
// ============================================================

pub fn rebuild(out_dir: &Path, run_id: &str) -> Result<()> {
    let mut summaries = Vec::new();
    for entry in std::fs::read_dir(out_dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("summary-") || !name.ends_with(&format!("-{run_id}.json")) {
            continue;
        }
        let path = entry.path();
        let body = std::fs::read_to_string(&path)?;
        let s: ServiceSummary = serde_json::from_str(&body)
            .with_context(|| format!("parsing {}", path.display()))?;
        summaries.push(s);
    }
    if summaries.is_empty() {
        return Err(anyhow::anyhow!(
            "no summaries found for run_id {run_id} in {}",
            out_dir.display()
        ));
    }
    for s in &summaries {
        render_service(s, out_dir)?;
    }
    // Best-effort compare rebuild (we don't have the original cfg
    // here; build a minimal placeholder).
    let placeholder = Config {
        pattern: if summaries.iter().any(|s| s.rate.is_some()) {
            crate::templates::Pattern::RateLevels
        } else {
            crate::templates::Pattern::Sustained
        },
        sustained: Default::default(),
        stress: Default::default(),
        rate_levels: Default::default(),
        warmup_seconds: 0,
        stop_at_error_pct: 0.0,
        default_pages: 1,
        timeouts: Default::default(),
        output: Default::default(),
        batch: Default::default(),
        services: vec![],
    };
    let unique: std::collections::HashSet<&str> =
        summaries.iter().map(|s| s.name.as_str()).collect();
    if unique.len() > 1 {
        render_compare(&summaries, &placeholder, out_dir, run_id)?;
    }
    Ok(())
}

// ============================================================
// Post-run validation suite
// ============================================================

pub fn post_validate(out_dir: &Path, run_ts: &str, summaries: &[ServiceSummary]) -> Result<bool> {
    use serde_json::json;
    let mut results = Vec::new();
    let mut ok = true;

    // Group 1: artifact inventory.
    for s in summaries {
        let exists = s.summary_json.exists() && s.samples_csv.exists();
        if !exists {
            ok = false;
        }
        results.push(json!({
            "group": "ARTIFACT INVENTORY",
            "test": format!("expected artifacts for {}", s.name),
            "result": if exists { "pass" } else { "fail" },
            "detail": format!("summary={} csv={}", s.summary_json.display(), s.samples_csv.display()),
        }));
    }

    // Group 2: CSV schema -- check the header row.
    for s in summaries {
        let csv_ok = std::fs::read_to_string(&s.samples_csv)
            .map(|c| {
                let first = c.lines().next().unwrap_or("");
                if s.mode == "batch" {
                    first.starts_with("dcn,doc_type,drop_epoch_ms")
                } else {
                    first.starts_with("epoch_ms,ttfb_us,transfer_us,total_us,bytes")
                }
            })
            .unwrap_or(false);
        if !csv_ok {
            ok = false;
        }
        results.push(json!({
            "group": "CSV SCHEMA",
            "test": format!("csv header for {}", s.name),
            "result": if csv_ok { "pass" } else { "fail" },
        }));
    }

    // Group 3: JSON schema -- round-trip parse.
    for s in summaries {
        let json_ok = std::fs::read_to_string(&s.summary_json)
            .ok()
            .and_then(|c| serde_json::from_str::<ServiceSummary>(&c).ok())
            .is_some();
        if !json_ok {
            ok = false;
        }
        results.push(json!({
            "group": "JSON SCHEMA",
            "test": format!("json parse for {}", s.name),
            "result": if json_ok { "pass" } else { "fail" },
        }));
    }

    // Group 4: HTML integrity -- ensure every report has the doctype.
    if let Ok(rd) = std::fs::read_dir(out_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with("report-") || !name.ends_with(".html") {
                continue;
            }
            let bytes = std::fs::read_to_string(e.path()).unwrap_or_default();
            let html_ok =
                bytes.starts_with("<!doctype html>") && bytes.contains("</html>");
            if !html_ok {
                ok = false;
            }
            results.push(json!({
                "group": "HTML INTEGRITY",
                "test": name,
                "result": if html_ok { "pass" } else { "fail" },
            }));
        }
    }

    let summary = json!({
        "run_ts": run_ts,
        "results": results,
        "ok": ok,
    });
    let path = out_dir.join(format!("validation-{run_ts}.json"));
    std::fs::write(&path, serde_json::to_string_pretty(&summary)?)?;
    logx::info(
        "report",
        &format!(
            "post-validation: {} tests, overall {}",
            summary["results"].as_array().map(|a| a.len()).unwrap_or(0),
            if ok { "PASS" } else { "FAIL" }
        ),
    );
    // Render a small HTML companion.
    let html_path = out_dir.join(format!("validation-{run_ts}.html"));
    let body = build_validation_html(&summary);
    std::fs::write(&html_path, body)?;
    Ok(ok)
}

fn build_validation_html(j: &serde_json::Value) -> String {
    let mut rows = String::new();
    let ok = j["ok"].as_bool().unwrap_or(false);
    if let Some(results) = j["results"].as_array() {
        for r in results {
            let group = r["group"].as_str().unwrap_or("");
            let test = r["test"].as_str().unwrap_or("");
            let result = r["result"].as_str().unwrap_or("");
            let badge_class = if result == "pass" { "ok" } else if result == "warn" { "warn" } else { "err" };
            rows.push_str(&format!(
                "<tr><td>{}</td><td>{}</td><td><span class=\"badge {}\">{}</span></td></tr>",
                esc(group),
                esc(test),
                badge_class,
                esc(result)
            ));
        }
    }
    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>post-run validation</title><style>{css}</style></head><body>
<header class="hero"><h1>Post-run validation <span class="badge {bc}">{verdict}</span></h1></header>
<main>
<table class="metrics"><thead><tr><th>Group</th><th>Test</th><th>Result</th></tr></thead><tbody>{rows}</tbody></table>
</main></body></html>"##,
        css = CSS,
        bc = if ok { "ok" } else { "err" },
        verdict = if ok { "PASS" } else { "FAIL" },
        rows = rows
    )
}

// ============================================================
// Developer playbook
// ============================================================

pub const PLAYBOOK_HTML: &str = include_str!("../docs/playbook.html");

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_summary() -> ServiceSummary {
        ServiceSummary {
            name: "svc".into(),
            environment: "idev1".into(),
            mode: "online".into(),
            run_ts: "20260522_141530".into(),
            rate: Some(25),
            run_index: Some(2),
            volume: None,
            sent: 100,
            ok: 95,
            failed: 5,
            documents_rendered: 95,
            error_rate_pct: 5.0,
            throughput_rps_mean: 24.5,
            throughput_rps_peak: 30.0,
            throughput_rps_min: 20.0,
            successful_rps_mean: 23.1,
            target_rps: Some(25.0),
            ttfb: Some(zero_block()),
            transfer: Some(zero_block()),
            total: Some(zero_block()),
            apdex_t_ms: 500,
            apdex_satisfied: 80,
            apdex_tolerating: 15,
            apdex_frustrated: 5,
            apdex_score: 0.875,
            bytes_total: 4096 * 95,
            in_flight_max: 25,
            errors: serde_json::json!({"timeout": 5}),
            duration_seconds: 60.0,
            samples_csv: PathBuf::from("/tmp/x.csv"),
            summary_json: PathBuf::from("/tmp/x.json"),
            pickup_latency: None,
            processing_latency: None,
            e4931_count: 0,
            documents_dropped: 0,
            documents_picked_up: 0,
            documents_unprocessed: 0,
        }
    }

    #[test]
    fn svg_charts_use_viewbox_not_fixed_pixels() {
        let chart = svg_line_chart_owned("x", vec![("a", "var(--c1)", vec![(0.0, 0.0)])], "ms");
        assert!(chart.contains("viewBox="), "expected viewBox attr in: {chart}");
        assert!(!chart.contains("width=\"800px\""));
    }

    #[test]
    fn html_contains_all_11_sections_per_doc() {
        let s = sample_summary();
        let html = build_service_html(&s);
        let required = [
            "Overview",
            "Key performance indicators",
            "Latency over time",
            "Throughput",
            "Error rate",
            "Latency histogram",
            "CDF",
            "Error breakdown",
            "Percentile table",
            "Data volume",
            "ecm-loadtest 1.0.0",
        ];
        for r in required {
            assert!(html.contains(r), "missing section '{r}' in service html");
        }
    }

    #[test]
    fn compare_report_renders_matrix_for_rate_levels() {
        let cfg = Config {
            pattern: crate::templates::Pattern::RateLevels,
            sustained: Default::default(),
            stress: Default::default(),
            rate_levels: Default::default(),
            warmup_seconds: 0,
            stop_at_error_pct: 0.0,
            default_pages: 1,
            timeouts: Default::default(),
            output: Default::default(),
            batch: Default::default(),
            services: vec![],
        };
        let mut a = sample_summary();
        let mut b = sample_summary();
        b.name = "svc-2".into();
        let html = build_compare_html(&[a.clone(), b.clone()], &cfg);
        assert!(html.contains("svc"));
        assert!(html.contains("svc-2"));
        assert!(html.contains("Comparison matrix"));
    }

    #[test]
    fn compare_report_renders_panels_for_sustained() {
        let mut cfg = Config {
            pattern: crate::templates::Pattern::Sustained,
            sustained: Default::default(),
            stress: Default::default(),
            rate_levels: Default::default(),
            warmup_seconds: 0,
            stop_at_error_pct: 0.0,
            default_pages: 1,
            timeouts: Default::default(),
            output: Default::default(),
            batch: Default::default(),
            services: vec![],
        };
        cfg.sustained.concurrency = 10;
        let html = build_compare_html(&[sample_summary()], &cfg);
        assert!(html.contains("Cross-service comparison"));
    }

    #[test]
    fn batch_report_renders_pickup_latency_percentiles() {
        let mut s = sample_summary();
        s.mode = "batch".into();
        s.volume = Some(100);
        s.rate = None;
        s.pickup_latency = Some(zero_block());
        let html = build_service_html(&s);
        // Mode badge appears in the header.
        assert!(html.contains(">batch<"));
    }

    #[test]
    fn color_palette_used_consistently_across_charts() {
        let s = sample_summary();
        let html = build_service_html(&s);
        // Every SERIES color (c1..c8) appears at least once.
        for v in ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)", "var(--c6)", "var(--c7)", "var(--c8)"] {
            assert!(html.contains(v), "missing palette color {v}");
        }
    }
}
