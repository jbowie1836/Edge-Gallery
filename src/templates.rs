//! Configuration loader, service-template inheritance, and
//! manifest CSV reader.
//!
//! The YAML schema is documented in the build prompt. This module
//! is intentionally tolerant on input (unknown fields warn, not
//! error) but strict where the prompt mandates fail-fast
//! semantics: required fields missing, unknown enum values,
//! out-of-range numerics, and duplicate service names all return
//! a CONFIG-VALIDATE or CONFIG-CONFLICT error.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::logx;

// ============================================================
// Public types
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Pattern {
    Sustained,
    Stress,
    RateLevels,
}

impl Default for Pattern {
    fn default() -> Self {
        Pattern::Sustained
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Online,
    Batch,
}

impl Default for Mode {
    fn default() -> Self {
        Mode::Online
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Sustained {
    #[serde(default)]
    pub concurrency: u32,
    #[serde(default)]
    pub ramp_seconds: u32,
    #[serde(default)]
    pub hold_seconds: u32,
    #[serde(default)]
    pub target_rps: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StressStage {
    pub concurrency: u32,
    pub duration_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Stress {
    #[serde(default)]
    pub stages: Vec<StressStage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateLevels {
    #[serde(default)]
    pub rates: Vec<u32>,
    #[serde(default = "default_60")]
    pub duration_seconds: u32,
    #[serde(default = "default_3")]
    pub runs_per_rate: u32,
    #[serde(default = "default_30")]
    pub cooldown_seconds: u32,
    #[serde(default = "default_200")]
    pub max_concurrency: u32,
    #[serde(default = "default_500")]
    pub apdex_threshold_ms: u32,
}

impl Default for RateLevels {
    fn default() -> Self {
        Self {
            rates: vec![],
            duration_seconds: 60,
            runs_per_rate: 3,
            cooldown_seconds: 30,
            max_concurrency: 200,
            apdex_threshold_ms: 500,
        }
    }
}

fn default_60() -> u32 {
    60
}
fn default_3() -> u32 {
    3
}
fn default_30() -> u32 {
    30
}
fn default_200() -> u32 {
    200
}
fn default_500() -> u32 {
    500
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Timeouts {
    #[serde(default = "default_10")]
    pub connect_seconds: u32,
    #[serde(default = "default_60")]
    pub request_seconds: u32,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            connect_seconds: 10,
            request_seconds: 60,
        }
    }
}

fn default_10() -> u32 {
    10
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Output {
    #[serde(default = "default_results_dir")]
    pub dir: PathBuf,
}

impl Default for Output {
    fn default() -> Self {
        Self {
            dir: PathBuf::from("results"),
        }
    }
}

fn default_results_dir() -> PathBuf {
    PathBuf::from("results")
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Batch {
    #[serde(default)]
    pub volumes: Vec<u32>,
    #[serde(default = "default_60")]
    pub drop_rate_per_minute: u32,
    #[serde(default = "default_30_min")]
    pub cycle_duration_minutes: u32,
    #[serde(default = "default_3")]
    pub runs_per_volume: u32,
    #[serde(default = "default_120")]
    pub cooldown_seconds: u32,
    #[serde(default = "default_500_ms")]
    pub poll_interval_ms: u32,
    #[serde(default = "yes")]
    pub e4931_tracking: bool,
}

fn default_30_min() -> u32 {
    30
}
fn default_120() -> u32 {
    120
}
fn default_500_ms() -> u32 {
    500
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub path: PathBuf,
    #[serde(default = "default_dcn_col")]
    pub dcn_column: String,
    #[serde(default = "default_xml_col")]
    pub xml_path_column: String,
    #[serde(default = "default_pdf_col")]
    pub pdf_path_column: String,
    #[serde(default = "default_selection")]
    pub selection: String,
}

fn default_dcn_col() -> String {
    "dcn".into()
}
fn default_xml_col() -> String {
    "xml_path".into()
}
fn default_pdf_col() -> String {
    "pdf_path".into()
}
fn default_selection() -> String {
    "random".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Validation {
    #[serde(default = "default_200_u16")]
    pub expect_status: u16,
    #[serde(default)]
    pub magic_bytes: String,
    #[serde(default)]
    pub content_type_contains: String,
    #[serde(default)]
    pub min_bytes: u64,
    #[serde(default)]
    pub max_bytes: u64,
    #[serde(default)]
    pub json_required_keys: Vec<String>,
}

fn default_200_u16() -> u16 {
    200
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Tls {
    #[serde(default = "yes")]
    pub verify: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Auth {
    pub mode: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub bearer_token: String,
    #[serde(default)]
    pub cookie: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LogMarker {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub completion_pattern: String,
    #[serde(default)]
    pub error_pattern: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Service {
    pub name: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub delay_ms: u64,
    #[serde(default)]
    pub mode: Mode,
    pub template: String,
    #[serde(default = "default_env")]
    pub environment: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default = "default_ct")]
    pub content_type: String,
    #[serde(default)]
    pub body_template: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub auth: Option<Auth>,
    #[serde(default)]
    pub tls: Tls,
    #[serde(default)]
    pub validation: Validation,
    pub manifest: Manifest,

    // Batch-only fields:
    #[serde(default)]
    pub drop_folder: String,
    #[serde(default = "default_pickup")]
    pub pickup_signal: String,
    #[serde(default)]
    pub log_marker: LogMarker,
    #[serde(default = "default_transport")]
    pub transport: String,
    #[serde(default)]
    pub sftp: Option<SftpConfig>,
}

fn default_env() -> String {
    "unknown".into()
}
fn default_method() -> String {
    "POST".into()
}
fn default_ct() -> String {
    "application/json".into()
}
fn default_pickup() -> String {
    "file_removed".into()
}
fn default_transport() -> String {
    "local".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpAuth {
    pub mode: String,
    #[serde(default)]
    pub private_key_path: String,
    #[serde(default)]
    pub passphrase: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpConfig {
    pub host: String,
    #[serde(default = "default_22")]
    pub port: u16,
    pub username: String,
    pub auth: SftpAuth,
    #[serde(default)]
    pub known_hosts_path: String,
    #[serde(default = "yes")]
    pub strict_host_key_checking: bool,
    #[serde(default = "default_4")]
    pub connection_count: u32,
    #[serde(default = "default_30")]
    pub connection_idle_seconds: u32,
    #[serde(default = "default_65536")]
    pub upload_chunk_bytes: u32,
}

fn default_22() -> u16 {
    22
}
fn default_4() -> u32 {
    4
}
fn default_65536() -> u32 {
    65536
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub pattern: Pattern,
    #[serde(default)]
    pub sustained: Sustained,
    #[serde(default)]
    pub stress: Stress,
    #[serde(default)]
    pub rate_levels: RateLevels,
    #[serde(default)]
    pub warmup_seconds: u32,
    #[serde(default)]
    pub stop_at_error_pct: f32,
    #[serde(default = "default_1")]
    pub default_pages: u32,
    #[serde(default)]
    pub timeouts: Timeouts,
    #[serde(default)]
    pub output: Output,
    #[serde(default)]
    pub batch: Batch,
    pub services: Vec<Service>,
}

fn default_1() -> u32 {
    1
}

// ============================================================
// Template merge
// ============================================================

/// Resolve template files: prefer a `templates/` directory next to
/// the config file (config-relative), and fall back to `./templates/`
/// in the working directory. Config-relative takes priority so a
/// test or alternate config can ship its own templates without
/// being shadowed by the project's defaults.
fn locate_template(name: &str, config_dir: &Path) -> Option<PathBuf> {
    let candidates = [
        config_dir.join("templates").join(format!("{name}.yaml")),
        PathBuf::from("templates").join(format!("{name}.yaml")),
    ];
    candidates.into_iter().find(|p| p.exists())
}

fn merge_template(svc: &mut Service, config_dir: &Path, visited: &mut Vec<String>) -> Result<()> {
    if visited.contains(&svc.template) {
        bail!(
            "CONFIG-CONFLICT: circular template extends chain at '{}'",
            svc.template
        );
    }
    visited.push(svc.template.clone());

    let path = locate_template(&svc.template, config_dir).ok_or_else(|| {
        anyhow!(
            "CONFIG-PARSE: template '{}' not found in templates/",
            svc.template
        )
    })?;
    logx::info("templates", &format!("loaded {}", path.display()));
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("reading template {}", path.display()))?;
    let tpl: serde_yaml::Value = serde_yaml::from_str(&raw)
        .with_context(|| format!("parsing template {}", path.display()))?;

    // Apply each template field as a fallback if the service block
    // did not set it. Template fields are simple scalars and maps.
    if let serde_yaml::Value::Mapping(map) = &tpl {
        if let Some(serde_yaml::Value::String(s)) = map.get(serde_yaml::Value::String("method".into())) {
            if svc.method == default_method() {
                svc.method = s.clone();
            }
        }
        if let Some(serde_yaml::Value::String(s)) = map.get(serde_yaml::Value::String("body_template".into())) {
            if svc.body_template.is_empty() {
                svc.body_template = s.clone();
            }
        }
        if let Some(headers) = map.get(serde_yaml::Value::String("headers".into())) {
            if let serde_yaml::Value::Mapping(m) = headers {
                for (k, v) in m {
                    if let (serde_yaml::Value::String(k), serde_yaml::Value::String(v)) = (k, v) {
                        svc.headers.entry(k.clone()).or_insert(v.clone());
                    }
                }
            }
        }
        if let Some(serde_yaml::Value::Mapping(t)) = map.get(serde_yaml::Value::String("tls".into())) {
            if let Some(serde_yaml::Value::Bool(b)) = t.get(serde_yaml::Value::String("verify".into())) {
                // Service `tls.verify` defaults to true; only adopt
                // the template's value when it explicitly differs.
                if !*b && svc.tls.verify {
                    svc.tls.verify = *b;
                }
            }
        }
        if let Some(serde_yaml::Value::Mapping(v)) = map.get(serde_yaml::Value::String("validation".into())) {
            apply_validation_defaults(&mut svc.validation, v);
        }
        if let Some(serde_yaml::Value::String(p)) = map.get(serde_yaml::Value::String("pickup_signal".into())) {
            if svc.pickup_signal == default_pickup() {
                svc.pickup_signal = p.clone();
            }
        }
        if let Some(serde_yaml::Value::Mapping(lm)) = map.get(serde_yaml::Value::String("log_marker".into())) {
            if svc.log_marker.path.is_empty() {
                if let Some(serde_yaml::Value::String(p)) = lm.get(serde_yaml::Value::String("path".into())) {
                    svc.log_marker.path = p.clone();
                }
                if let Some(serde_yaml::Value::String(p)) = lm.get(serde_yaml::Value::String("completion_pattern".into())) {
                    svc.log_marker.completion_pattern = p.clone();
                }
                if let Some(serde_yaml::Value::String(p)) = lm.get(serde_yaml::Value::String("error_pattern".into())) {
                    svc.log_marker.error_pattern = p.clone();
                }
            }
        }
        // Single-level inheritance via extends.
        if let Some(serde_yaml::Value::String(parent)) = map.get(serde_yaml::Value::String("extends".into())) {
            let original = svc.template.clone();
            svc.template = parent.clone();
            merge_template(svc, config_dir, visited)?;
            svc.template = original;
        }
    }
    if svc.headers.is_empty() {
        svc.headers
            .insert("Content-Type".into(), svc.content_type.clone());
    }
    Ok(())
}

fn apply_validation_defaults(v: &mut Validation, m: &serde_yaml::Mapping) {
    let g = |k: &str| m.get(serde_yaml::Value::String(k.into()));
    if v.expect_status == 200 {
        if let Some(serde_yaml::Value::Number(n)) = g("expect_status") {
            if let Some(i) = n.as_u64() {
                v.expect_status = i as u16;
            }
        }
    }
    if v.magic_bytes.is_empty() {
        if let Some(serde_yaml::Value::String(s)) = g("magic_bytes") {
            v.magic_bytes = s.clone();
        }
    }
    if v.content_type_contains.is_empty() {
        if let Some(serde_yaml::Value::String(s)) = g("content_type_contains") {
            v.content_type_contains = s.clone();
        }
    }
    if v.min_bytes == 0 {
        if let Some(serde_yaml::Value::Number(n)) = g("min_bytes") {
            if let Some(i) = n.as_u64() {
                v.min_bytes = i;
            }
        }
    }
    if v.max_bytes == 0 {
        if let Some(serde_yaml::Value::Number(n)) = g("max_bytes") {
            if let Some(i) = n.as_u64() {
                v.max_bytes = i;
            }
        }
    }
}

// ============================================================
// Config loader entry point
// ============================================================

pub fn load_config(path: &Path) -> Result<Config> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("CONFIG-PARSE: reading {}", path.display()))?;
    let mut cfg: Config = serde_yaml::from_str(&raw)
        .with_context(|| format!("CONFIG-PARSE: parsing {}", path.display()))?;
    let config_dir = path.parent().unwrap_or(Path::new(".")).to_path_buf();

    if cfg.services.is_empty() {
        bail!("CONFIG-CONFLICT: services list is empty");
    }

    // Validate top-level constraints.
    if !(0.0..=100.0).contains(&cfg.stop_at_error_pct) {
        bail!(
            "CONFIG-VALIDATE: stop_at_error_pct out of range 0.0..=100.0: {}",
            cfg.stop_at_error_pct
        );
    }
    if cfg.warmup_seconds > 600 {
        bail!(
            "CONFIG-VALIDATE: warmup_seconds out of range 0..=600: {}",
            cfg.warmup_seconds
        );
    }
    if !(1..=1000).contains(&cfg.default_pages) {
        bail!(
            "CONFIG-VALIDATE: default_pages out of range 1..=1000: {}",
            cfg.default_pages
        );
    }

    // Validate and merge each service.
    let mut seen_names: HashMap<String, usize> = HashMap::new();
    let mut had_enabled = false;
    for (idx, svc) in cfg.services.iter_mut().enumerate() {
        if svc.name.is_empty() {
            bail!("CONFIG-VALIDATE: service[{idx}] has empty name");
        }
        if !svc
            .name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            || svc.name.len() > 64
        {
            bail!(
                "CONFIG-VALIDATE: service[{idx}] name '{}' invalid (must be [A-Za-z0-9-_]{{1,64}})",
                svc.name
            );
        }
        if svc.enabled {
            if let Some(prev) = seen_names.insert(svc.name.clone(), idx) {
                bail!(
                    "CONFIG-CONFLICT: duplicate enabled service name '{}' at services[{prev}] and services[{idx}]",
                    svc.name
                );
            }
            had_enabled = true;
        }
        if svc.delay_ms > 600_000 {
            logx::warn(
                "templates",
                &format!(
                    "service[{idx}] {} delay_ms={} above ceiling, clamping to 600000",
                    svc.name, svc.delay_ms
                ),
            );
            svc.delay_ms = 600_000;
        }
        if !svc.enabled {
            logx::info(
                "templates",
                &format!("service[{idx}] {} enabled=false, skipping", svc.name),
            );
            continue;
        }
        logx::info(
            "templates",
            &format!(
                "service[{idx}] {} enabled=true delay_ms={}",
                svc.name, svc.delay_ms
            ),
        );

        // Mode-specific required fields.
        if svc.mode == Mode::Online {
            if svc.host.is_empty() {
                bail!(
                    "CONFIG-VALIDATE: service[{idx}] {} missing 'host'",
                    svc.name
                );
            }
            if svc.endpoint.is_empty() {
                bail!(
                    "CONFIG-VALIDATE: service[{idx}] {} missing 'endpoint'",
                    svc.name
                );
            }
        } else if svc.mode == Mode::Batch && svc.drop_folder.is_empty() {
            bail!(
                "CONFIG-VALIDATE: service[{idx}] {} missing 'drop_folder'",
                svc.name
            );
        }

        let mut visited = Vec::new();
        merge_template(svc, &config_dir, &mut visited)
            .with_context(|| format!("merging template for service '{}'", svc.name))?;
    }
    if !had_enabled {
        bail!("CONFIG-CONFLICT: every service is disabled");
    }

    // Cross-block coherence.
    let any_batch = cfg
        .services
        .iter()
        .any(|s| s.enabled && s.mode == Mode::Batch);
    if any_batch && cfg.batch.volumes.is_empty() {
        bail!("CONFIG-CONFLICT: batch service enabled but batch.volumes is empty");
    }

    Ok(cfg)
}

// ============================================================
// Manifest CSV loader
// ============================================================

#[derive(Debug, Clone)]
pub struct ManifestRow {
    pub fields: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct ManifestData {
    pub rows: Vec<ManifestRow>,
    pub selection: String,
    pub dcn_column: String,
}

impl ManifestData {
    /// Pick a manifest row according to the configured selection
    /// rule. `cursor` is mutated for sequential walks.
    pub fn pick(&self, cursor: &mut usize, rng: &mut impl rand::Rng) -> &ManifestRow {
        match self.selection.as_str() {
            "sequential" => {
                let row = &self.rows[*cursor % self.rows.len()];
                *cursor = (*cursor + 1) % self.rows.len();
                row
            }
            "weighted" => {
                let weights: Vec<u32> = self
                    .rows
                    .iter()
                    .map(|r| {
                        r.fields
                            .get("priority")
                            .and_then(|s| s.parse::<u32>().ok())
                            .unwrap_or(1)
                            .max(1)
                    })
                    .collect();
                let total: u32 = weights.iter().sum();
                let mut pick = rng.gen_range(0..total);
                for (i, w) in weights.iter().enumerate() {
                    if pick < *w {
                        return &self.rows[i];
                    }
                    pick -= *w;
                }
                &self.rows[0]
            }
            _ => {
                // random (default)
                let idx = rng.gen_range(0..self.rows.len());
                &self.rows[idx]
            }
        }
    }
}

pub fn load_manifest(m: &Manifest) -> Result<ManifestData> {
    if !m.path.exists() {
        return Err(anyhow!(
            "MANIFEST-MISSING-FILE: {}",
            m.path.display()
        ));
    }
    let mut rdr = csv::Reader::from_path(&m.path)
        .with_context(|| format!("opening manifest {}", m.path.display()))?;
    let headers: Vec<String> = rdr
        .headers()
        .with_context(|| format!("reading header from {}", m.path.display()))?
        .iter()
        .map(|s| s.to_string())
        .collect();

    let mut rows = Vec::new();
    for (idx, rec) in rdr.records().enumerate() {
        let rec = rec.with_context(|| format!("row {idx} of manifest"))?;
        let mut fields = HashMap::new();
        for (i, h) in headers.iter().enumerate() {
            let v = rec.get(i).unwrap_or("").trim().to_string();
            fields.insert(h.clone(), v);
        }
        rows.push(ManifestRow { fields });
    }

    if rows.is_empty() {
        return Err(anyhow!(
            "MANIFEST-DATA: manifest {} has zero data rows",
            m.path.display()
        ));
    }
    if !headers.iter().any(|h| h == &m.dcn_column) {
        return Err(anyhow!(
            "MANIFEST-SCHEMA: manifest {} missing required column '{}'",
            m.path.display(),
            m.dcn_column
        ));
    }
    // Duplicate DCN warning.
    let mut seen = std::collections::HashSet::new();
    let mut dups = 0u32;
    for r in &rows {
        if let Some(d) = r.fields.get(&m.dcn_column) {
            if !seen.insert(d.clone()) {
                dups += 1;
            }
        }
    }
    if dups > 0 {
        logx::warn(
            "templates",
            &format!(
                "manifest {} has {dups} duplicate DCN row(s)",
                m.path.display()
            ),
        );
    }
    logx::info(
        "templates",
        &format!(
            "manifest {}: {} rows, {} unique DCNs",
            m.path.display(),
            rows.len(),
            seen.len()
        ),
    );

    Ok(ManifestData {
        rows,
        selection: m.selection.clone(),
        dcn_column: m.dcn_column.clone(),
    })
}

/// Render a request body by substituting `${col}` with the row
/// value for that column. Two well-known names are always
/// resolved: `${pages}` falls back to `default_pages`, and
/// `${env}` resolves to the service's environment label.
pub fn render_body(
    template: &str,
    row: &ManifestRow,
    default_pages: u32,
    env: &str,
) -> Result<String> {
    let mut out = String::with_capacity(template.len() + 32);
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if let Some(end_rel) = bytes[i + 2..].iter().position(|&b| b == b'}') {
                let name = std::str::from_utf8(&bytes[i + 2..i + 2 + end_rel])
                    .map_err(|e| anyhow!("body_template UTF-8: {e}"))?;
                let value = match name {
                    "pages" => row
                        .fields
                        .get("pages")
                        .filter(|s| !s.is_empty())
                        .cloned()
                        .unwrap_or_else(|| default_pages.to_string()),
                    "env" => env.to_string(),
                    other => row
                        .fields
                        .get(other)
                        .cloned()
                        .ok_or_else(|| {
                            anyhow!(
                                "CONFIG-VALIDATE: body_template references unknown column '${{{other}}}'"
                            )
                        })?,
                };
                out.push_str(&value);
                i += 2 + end_rel + 1;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    Ok(out)
}

// ============================================================
// Annotated example config (printed by `example-config`)
// ============================================================

pub const EXAMPLE_CONFIG: &str = include_str!("../examples/loadtest.yaml");

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_dir() -> Result<TempDir> {
        let unique = format!(
            "ecm-loadtest-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        );
        let dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&dir)?;
        Ok(TempDir(dir))
    }

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    impl std::ops::Deref for TempDir {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    fn write(p: &Path, contents: &str) {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut f = std::fs::File::create(p).unwrap();
        f.write_all(contents.as_bytes()).unwrap();
    }

    #[test]
    fn template_merge_overlays_service_block() {
        let dir = tmp_dir().unwrap();
        write(
            &dir.join("templates/pdf-retrieval-service.yaml"),
            "mode: online\nmethod: POST\nbody_template: '{\"dcn\":\"${dcn}\"}'\n",
        );
        write(
            &dir.join("examples/manifest.csv"),
            "dcn,pages\nDCN1,3\nDCN2,5\n",
        );
        let cfg = format!(
            r#"
pattern: sustained
sustained:
  concurrency: 1
  hold_seconds: 1
services:
  - name: svc1
    mode: online
    template: pdf-retrieval-service
    host: http://127.0.0.1:1
    endpoint: /x
    manifest:
      path: {}/examples/manifest.csv
"#,
            dir.display()
        );
        let p = dir.join("c.yaml");
        write(&p, &cfg);
        let c = load_config(&p).unwrap();
        // Template provided body_template; service block did not.
        assert_eq!(c.services[0].body_template, "{\"dcn\":\"${dcn}\"}");
    }

    #[test]
    fn template_extends_chain_resolves() {
        let dir = tmp_dir().unwrap();
        write(
            &dir.join("templates/parent.yaml"),
            "mode: online\nmethod: GET\n",
        );
        write(
            &dir.join("templates/child.yaml"),
            "extends: parent\nbody_template: 'b'\n",
        );
        write(&dir.join("examples/manifest.csv"), "dcn\nA\n");
        let cfg = format!(
            r#"
pattern: sustained
services:
  - name: svc
    mode: online
    template: child
    host: http://127.0.0.1:1
    endpoint: /x
    manifest:
      path: {}/examples/manifest.csv
"#,
            dir.display()
        );
        let p = dir.join("c.yaml");
        write(&p, &cfg);
        let c = load_config(&p).unwrap();
        assert_eq!(c.services[0].body_template, "b");
        // method from parent.
        assert_eq!(c.services[0].method, "GET");
    }

    #[test]
    fn template_extends_circular_fails() {
        let dir = tmp_dir().unwrap();
        write(&dir.join("templates/a.yaml"), "extends: b\n");
        write(&dir.join("templates/b.yaml"), "extends: a\n");
        write(&dir.join("examples/manifest.csv"), "dcn\nX\n");
        let cfg = format!(
            r#"
pattern: sustained
services:
  - name: x
    mode: online
    template: a
    host: http://127.0.0.1:1
    endpoint: /e
    manifest:
      path: {}/examples/manifest.csv
"#,
            dir.display()
        );
        let p = dir.join("c.yaml");
        write(&p, &cfg);
        let err = load_config(&p).unwrap_err();
        assert!(format!("{err:#}").contains("circular"));
    }

    #[test]
    fn manifest_loader_validates_header_row() {
        let dir = tmp_dir().unwrap();
        write(&dir.join("m.csv"), "wrongcol\nfoo\n");
        let m = Manifest {
            path: dir.join("m.csv"),
            dcn_column: "dcn".into(),
            xml_path_column: "xml_path".into(),
            pdf_path_column: "pdf_path".into(),
            selection: "random".into(),
        };
        let err = load_manifest(&m).unwrap_err();
        assert!(format!("{err:#}").contains("MANIFEST-SCHEMA"));
    }

    #[test]
    fn manifest_loader_rejects_missing_required_columns() {
        let dir = tmp_dir().unwrap();
        write(&dir.join("m.csv"), "doc_type\nW2\n");
        let m = Manifest {
            path: dir.join("m.csv"),
            dcn_column: "dcn".into(),
            xml_path_column: "xml_path".into(),
            pdf_path_column: "pdf_path".into(),
            selection: "random".into(),
        };
        let err = load_manifest(&m).unwrap_err();
        assert!(format!("{err:#}").contains("MANIFEST-SCHEMA"));
    }

    #[test]
    fn manifest_loader_warns_duplicate_dcns() {
        let dir = tmp_dir().unwrap();
        write(&dir.join("m.csv"), "dcn\nA\nA\nB\n");
        let m = Manifest {
            path: dir.join("m.csv"),
            dcn_column: "dcn".into(),
            xml_path_column: "x".into(),
            pdf_path_column: "p".into(),
            selection: "random".into(),
        };
        let md = load_manifest(&m).unwrap();
        assert_eq!(md.rows.len(), 3);
    }

    #[test]
    fn manifest_selection_sequential_wraps() {
        let dir = tmp_dir().unwrap();
        write(&dir.join("m.csv"), "dcn\nA\nB\n");
        let m = Manifest {
            path: dir.join("m.csv"),
            dcn_column: "dcn".into(),
            xml_path_column: "x".into(),
            pdf_path_column: "p".into(),
            selection: "sequential".into(),
        };
        let md = load_manifest(&m).unwrap();
        let mut cur = 0usize;
        let mut rng = rand::thread_rng();
        let a = md.pick(&mut cur, &mut rng).fields["dcn"].clone();
        let b = md.pick(&mut cur, &mut rng).fields["dcn"].clone();
        let c = md.pick(&mut cur, &mut rng).fields["dcn"].clone();
        assert_eq!(a, "A");
        assert_eq!(b, "B");
        assert_eq!(c, "A");
    }

    #[test]
    fn manifest_selection_random_covers_all_rows_in_1000_picks() {
        let dir = tmp_dir().unwrap();
        write(&dir.join("m.csv"), "dcn\nA\nB\nC\nD\n");
        let m = Manifest {
            path: dir.join("m.csv"),
            dcn_column: "dcn".into(),
            xml_path_column: "x".into(),
            pdf_path_column: "p".into(),
            selection: "random".into(),
        };
        let md = load_manifest(&m).unwrap();
        let mut seen = std::collections::HashSet::new();
        let mut cur = 0;
        let mut rng = rand::thread_rng();
        for _ in 0..1000 {
            seen.insert(md.pick(&mut cur, &mut rng).fields["dcn"].clone());
        }
        assert_eq!(seen.len(), 4);
    }

    #[test]
    fn manifest_selection_weighted_respects_priority_column() {
        let dir = tmp_dir().unwrap();
        write(&dir.join("m.csv"), "dcn,priority\nA,1\nB,100\n");
        let m = Manifest {
            path: dir.join("m.csv"),
            dcn_column: "dcn".into(),
            xml_path_column: "x".into(),
            pdf_path_column: "p".into(),
            selection: "weighted".into(),
        };
        let md = load_manifest(&m).unwrap();
        let mut cur = 0;
        let mut rng = rand::thread_rng();
        let mut b_count = 0;
        for _ in 0..1000 {
            if md.pick(&mut cur, &mut rng).fields["dcn"] == "B" {
                b_count += 1;
            }
        }
        // With weight 100 vs 1, B should dominate.
        assert!(b_count > 900, "weighted selection too weak: B={b_count}");
    }

    #[test]
    fn duplicate_service_name_exits_with_conflict() {
        let dir = tmp_dir().unwrap();
        write(&dir.join("templates/t.yaml"), "mode: online\n");
        write(&dir.join("m.csv"), "dcn\nA\n");
        let cfg = format!(
            r#"
pattern: sustained
services:
  - name: same
    mode: online
    template: t
    host: http://127.0.0.1:1
    endpoint: /e
    manifest: {{ path: {0}/m.csv }}
  - name: same
    mode: online
    template: t
    host: http://127.0.0.1:1
    endpoint: /e
    manifest: {{ path: {0}/m.csv }}
"#,
            dir.display()
        );
        let p = dir.join("c.yaml");
        write(&p, &cfg);
        let err = load_config(&p).unwrap_err();
        assert!(format!("{err:#}").contains("CONFIG-CONFLICT"));
    }

    #[test]
    fn body_template_substitution() {
        let row = ManifestRow {
            fields: [("dcn".into(), "D1".into()), ("pages".into(), "7".into())]
                .into_iter()
                .collect(),
        };
        let s = render_body(r#"{"dcn":"${dcn}","p":${pages},"e":"${env}"}"#, &row, 1, "idev1")
            .unwrap();
        assert_eq!(s, r#"{"dcn":"D1","p":7,"e":"idev1"}"#);
    }

    #[test]
    fn body_template_unknown_column_fails() {
        let row = ManifestRow {
            fields: [("dcn".into(), "D".into())].into_iter().collect(),
        };
        let err = render_body("${nope}", &row, 1, "x").unwrap_err();
        assert!(format!("{err:#}").contains("unknown column"));
    }
}
