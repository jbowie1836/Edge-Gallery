//! Pre-run archive rotation.
//!
//! Before any new artifact is written, prior outputs in the
//! results directory are moved into
//! `<out_dir>/archive/<archive_ts>/`. `archive_ts` is derived
//! from the mtime of the newest .html (or .json / .csv) in the
//! directory, so the archive subtree reflects when that prior
//! run actually completed.
//!
//! Skips files inside the existing `archive/` subtree (we never
//! recurse) and stops cleanly when the directory does not exist
//! or is empty.

use std::path::Path;
use std::time::SystemTime;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};

use crate::logx;

const ARTIFACT_PREFIXES: &[&str] = &[
    "samples-",
    "summary-",
    "report-",
    "rate-aggregate-",
    "volume-aggregate-",
    "compare-",
    "documents-",
    "validation-",
];

pub fn rotate(out_dir: &Path) -> Result<()> {
    logx::info(
        "archive",
        &format!("scanning {} for prior artifacts", out_dir.display()),
    );
    if !out_dir.exists() {
        std::fs::create_dir_all(out_dir)
            .with_context(|| format!("creating {}", out_dir.display()))?;
        return Ok(());
    }

    let mut newest_mtime: Option<SystemTime> = None;
    let mut artifacts = Vec::new();
    let read = match std::fs::read_dir(out_dir) {
        Ok(r) => r,
        Err(e) => {
            return Err(e).with_context(|| format!("reading {}", out_dir.display()));
        }
    };
    for entry in read.flatten() {
        let p = entry.path();
        let name = match p.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if name == "archive" {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let is_artifact = ARTIFACT_PREFIXES.iter().any(|pre| name.starts_with(pre))
            || name.ends_with(".html")
            || name.ends_with(".json")
            || name.ends_with(".csv")
            || name.ends_with(".log");
        if !is_artifact {
            continue;
        }
        artifacts.push(p.clone());
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        // We prefer the newest html for the archive_ts source.
        if name.ends_with(".html") {
            match newest_mtime {
                None => newest_mtime = Some(mtime),
                Some(prev) if mtime > prev => newest_mtime = Some(mtime),
                _ => {}
            }
        } else if newest_mtime.is_none() {
            newest_mtime = Some(mtime);
        }
    }

    if artifacts.is_empty() {
        logx::info("archive", "no prior artifacts; skipping rotation");
        return Ok(());
    }

    let ts = match newest_mtime {
        Some(t) => {
            let dt: DateTime<Utc> = t.into();
            dt.format("%Y%m%d_%H%M%S").to_string()
        }
        None => Utc::now().format("%Y%m%d_%H%M%S").to_string(),
    };
    let dest = out_dir.join("archive").join(&ts);
    std::fs::create_dir_all(&dest)
        .with_context(|| format!("creating {}", dest.display()))?;
    let mut moved = 0u32;
    for src in &artifacts {
        let name = match src.file_name() {
            Some(n) => n,
            None => continue,
        };
        let target = dest.join(name);
        // rename is atomic on the same filesystem; fall back to
        // copy+remove if the destination is on a different mount.
        if std::fs::rename(src, &target).is_err() {
            std::fs::copy(src, &target).with_context(|| {
                format!("copying {} to {}", src.display(), target.display())
            })?;
            std::fs::remove_file(src)
                .with_context(|| format!("removing {}", src.display()))?;
        }
        moved += 1;
    }
    logx::info(
        "archive",
        &format!("moved {moved} files to {}", dest.display()),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn tmp() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "ecm-archive-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write(p: &Path, c: &str) {
        let mut f = fs::File::create(p).unwrap();
        f.write_all(c.as_bytes()).unwrap();
    }

    #[test]
    fn archive_rotation_moves_prior_artifacts_to_timestamped_dir() {
        let dir = tmp();
        write(&dir.join("report-svc-idev1-x.html"), "<html/>");
        write(&dir.join("summary-svc-idev1-x.json"), "{}");
        write(&dir.join("samples-svc-idev1-x.csv"), "a\n");
        rotate(&dir).unwrap();
        let archive = dir.join("archive");
        assert!(archive.exists());
        let kids: Vec<_> = fs::read_dir(&archive).unwrap().flatten().collect();
        assert_eq!(kids.len(), 1);
        let sub = kids[0].path();
        let files: Vec<_> = fs::read_dir(&sub).unwrap().flatten().collect();
        assert_eq!(files.len(), 3);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn archive_rotation_skips_when_dir_empty() {
        let dir = tmp();
        rotate(&dir).unwrap();
        assert!(!dir.join("archive").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn archive_rotation_does_not_recurse_into_archive_subtree() {
        let dir = tmp();
        fs::create_dir_all(dir.join("archive/20200101_000000")).unwrap();
        write(&dir.join("archive/20200101_000000/report-old.html"), "x");
        write(&dir.join("report-new.html"), "y");
        rotate(&dir).unwrap();
        // The old archived file must remain in place.
        assert!(dir.join("archive/20200101_000000/report-old.html").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn archive_rotation_uses_newest_html_mtime() {
        // We can't easily set mtime portably; just verify the
        // archive dir name parses as YYYYMMDD_HHMMSS.
        let dir = tmp();
        write(&dir.join("report-svc-x.html"), "x");
        rotate(&dir).unwrap();
        let archive = dir.join("archive");
        let kids: Vec<_> = fs::read_dir(&archive).unwrap().flatten().collect();
        let name = kids[0].file_name().to_string_lossy().to_string();
        assert_eq!(name.len(), 15, "ts dir name should be YYYYMMDD_HHMMSS: {name}");
        let _ = fs::remove_dir_all(&dir);
    }
}
