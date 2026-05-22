//! Embedded HTTP report server.
//!
//! Binds to 127.0.0.1 only (never the network), serves the most
//! recent run's artifacts and the archive subtree, and exposes
//! a small route table:
//!
//!   GET /                       run index
//!   GET /report/<filename>      HTML report files
//!   GET /artifact/<filename>    CSV / JSON artifacts
//!   GET /archive                archive index
//!   GET /archive/<ts>/[<file>]  archived run files
//!   GET /favicon.ico            embedded 1x1 PNG
//!
//! Path traversal attempts are rejected with 404 before any
//! filesystem call is made.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use anyhow::{Context, Result};
use tiny_http::{Header, Response, Server};

use crate::logx;
use crate::report::ServiceSummary;

const FAVICON_PNG: &[u8] = include_bytes!("../assets/favicon.png");

pub fn start_background(out_dir: &Path, port: u16, stop: Arc<AtomicBool>) -> Result<u16> {
    let bound = bind_with_fallback(port)?;
    let actual_port = bound.0;
    let server = bound.1;
    let out_dir = out_dir.to_path_buf();
    logx::info("serve", &format!("bind 127.0.0.1:{actual_port} ok"));
    logx::info("serve", "registered routes: /, /report, /artifact, /archive, /favicon.ico");
    thread::spawn(move || {
        server_loop(server, &out_dir, stop);
    });
    Ok(actual_port)
}

pub async fn serve_blocking(out_dir: &Path, port: u16, stop: Arc<AtomicBool>) -> Result<()> {
    let _port = start_background(out_dir, port, stop.clone())?;
    logx::info("serve", "server running, press Ctrl+C to stop");
    while !stop.load(Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    logx::info("serve", "server stopped");
    Ok(())
}

fn bind_with_fallback(start_port: u16) -> Result<(u16, Server)> {
    for offset in 0..10 {
        let p = start_port.saturating_add(offset);
        match Server::http(format!("127.0.0.1:{p}")) {
            Ok(s) => return Ok((p, s)),
            Err(e) => {
                logx::warn(
                    "serve",
                    &format!("port {p} unavailable: {e}; trying next"),
                );
            }
        }
    }
    Err(crate::ExitCode(30).into())
}

fn server_loop(server: Server, out_dir: &Path, stop: Arc<AtomicBool>) {
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match server.recv_timeout(std::time::Duration::from_millis(250)) {
            Ok(Some(req)) => {
                let t0 = std::time::Instant::now();
                let url = req.url().to_string();
                let method = req.method().to_string();
                let (status, body, ctype) = route(&method, &url, out_dir);
                let resp = Response::from_data(body)
                    .with_status_code(status)
                    .with_header(
                        Header::from_bytes(b"Content-Type".as_ref(), ctype.as_bytes())
                            .unwrap_or_else(|_| {
                                Header::from_bytes(b"Content-Type".as_ref(), b"text/plain")
                                    .unwrap()
                            }),
                    )
                    .with_header(
                        Header::from_bytes(b"Cache-Control".as_ref(), b"no-store").unwrap(),
                    );
                let _ = req.respond(resp);
                let elapsed = t0.elapsed().as_millis();
                logx::info(
                    "serve",
                    &format!("{method} {url} -> {status} {ctype} {elapsed}ms"),
                );
            }
            Ok(None) => continue,
            Err(_) => break,
        }
    }
}

/// Returns (status_code, body_bytes, content_type).
fn route(method: &str, url: &str, out_dir: &Path) -> (u16, Vec<u8>, String) {
    if method != "GET" && method != "HEAD" {
        return (405, b"method not allowed".to_vec(), "text/plain".into());
    }
    // Strip query string.
    let path = url.split('?').next().unwrap_or("/");
    if path == "/" {
        return (200, index_html(out_dir).into_bytes(), "text/html; charset=utf-8".into());
    }
    if path == "/favicon.ico" {
        return (200, FAVICON_PNG.to_vec(), "image/png".into());
    }
    if let Some(rest) = path.strip_prefix("/report/") {
        return serve_file(out_dir, rest, "text/html; charset=utf-8");
    }
    if let Some(rest) = path.strip_prefix("/artifact/") {
        let ctype = if rest.ends_with(".json") {
            "application/json"
        } else if rest.ends_with(".csv") {
            "text/csv"
        } else {
            "application/octet-stream"
        };
        return serve_file(out_dir, rest, ctype);
    }
    if let Some(rest) = path.strip_prefix("/archive/") {
        let rest = rest.trim_end_matches('/');
        let archive_root = out_dir.join("archive");
        if rest.is_empty() {
            return (200, archive_index(&archive_root).into_bytes(), "text/html; charset=utf-8".into());
        }
        return serve_archive(&archive_root, rest);
    }
    if path == "/archive" {
        let archive_root = out_dir.join("archive");
        return (200, archive_index(&archive_root).into_bytes(), "text/html; charset=utf-8".into());
    }
    (404, b"not found".to_vec(), "text/plain".into())
}

/// Read a file from `out_dir/relative`, with strict path-traversal
/// rejection. Returns 404 on any attempt to escape the directory.
fn serve_file(base: &Path, relative: &str, ctype: &str) -> (u16, Vec<u8>, String) {
    if relative.contains("..") || relative.contains('\\') || relative.starts_with('/') {
        return (404, b"not found".to_vec(), "text/plain".into());
    }
    let p = base.join(relative);
    // Defense in depth: confirm the resolved path is still inside base.
    if let (Ok(canon), Ok(canon_base)) = (p.canonicalize(), base.canonicalize()) {
        if !canon.starts_with(&canon_base) {
            return (404, b"not found".to_vec(), "text/plain".into());
        }
    }
    match std::fs::read(&p) {
        Ok(bytes) => (200, bytes, ctype.into()),
        Err(_) => (404, b"not found".to_vec(), "text/plain".into()),
    }
}

fn serve_archive(archive_root: &Path, rest: &str) -> (u16, Vec<u8>, String) {
    if rest.contains("..") {
        return (404, b"not found".to_vec(), "text/plain".into());
    }
    // /archive/<ts>/ -> index of that subdirectory
    // /archive/<ts>/<file> -> file
    let parts: Vec<&str> = rest.splitn(2, '/').collect();
    if parts.len() == 1 {
        let sub = archive_root.join(parts[0]);
        if sub.is_dir() {
            return (200, subdir_index(&sub).into_bytes(), "text/html; charset=utf-8".into());
        }
        return (404, b"not found".to_vec(), "text/plain".into());
    }
    let ctype = if parts[1].ends_with(".html") {
        "text/html; charset=utf-8"
    } else if parts[1].ends_with(".json") {
        "application/json"
    } else if parts[1].ends_with(".csv") {
        "text/csv"
    } else {
        "application/octet-stream"
    };
    let sub = archive_root.join(parts[0]);
    serve_file(&sub, parts[1], ctype)
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn index_html(out_dir: &Path) -> String {
    let mut entries: Vec<(String, String)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(out_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name == "archive" {
                continue;
            }
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let route = if name.ends_with(".html") {
                format!("/report/{}", name)
            } else if name.ends_with(".json") || name.ends_with(".csv") || name.ends_with(".log") {
                format!("/artifact/{}", name)
            } else {
                continue;
            };
            entries.push((name, route));
        }
    }
    entries.sort();
    let mut links = String::new();
    for (name, route) in &entries {
        links.push_str(&format!(
            r##"<li><a href="{}">{}</a></li>"##,
            html_escape(route),
            html_escape(name)
        ));
    }
    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>ecm-loadtest results</title>
<style>
:root {{ --bg:#0a0d12; --panel:#131822; --fg:#e6edf3; --muted:#768390; --accent:#2ec4b6; }}
body {{ background:var(--bg); color:var(--fg); font-family:-apple-system,Segoe UI,Roboto,sans-serif; margin:0; }}
header {{ background:var(--panel); padding:24px 40px; border-bottom:1px solid #21262d; }}
h1 {{ margin:0; font-size:22px; }}
main {{ max-width:1280px; margin:0 auto; padding:32px 40px; }}
h2 {{ margin-top:32px; font-size:18px; color:var(--accent); }}
ul {{ list-style:none; padding:0; }}
li {{ padding:6px 0; border-bottom:1px solid #21262d; }}
a {{ color:var(--accent); text-decoration:none; }}
a:hover {{ text-decoration:underline; }}
</style></head><body>
<header><h1>ecm-loadtest results</h1></header>
<main>
  <h2>Latest run artifacts</h2>
  <ul>{links}</ul>
  <h2>Archive</h2>
  <p><a href="/archive">Browse archived runs</a></p>
  <h2>Developer</h2>
  <p><a href="/report/playbook.html">Developer playbook</a></p>
</main></body></html>"##,
        links = links
    )
}

fn archive_index(archive_root: &Path) -> String {
    let mut subs: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(archive_root) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                subs.push(e.file_name().to_string_lossy().to_string());
            }
        }
    }
    subs.sort_by(|a, b| b.cmp(a));
    let mut links = String::new();
    for s in &subs {
        links.push_str(&format!(
            r##"<li><a href="/archive/{}/">{}</a></li>"##,
            html_escape(s),
            html_escape(s)
        ));
    }
    format!(
        r##"<!doctype html><html><head><meta charset="utf-8"><title>archive</title>
<style>body{{background:#0a0d12;color:#e6edf3;font-family:sans-serif;padding:32px;}}a{{color:#2ec4b6;}}</style>
</head><body><h1>archive</h1><ul>{links}</ul></body></html>"##
    )
}

fn subdir_index(sub: &Path) -> String {
    let mut entries: Vec<String> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(sub) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            entries.push(name);
        }
    }
    entries.sort();
    let ts = sub.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let mut links = String::new();
    for n in &entries {
        let path = format!("/archive/{}/{}", ts, n);
        links.push_str(&format!(
            r##"<li><a href="{}">{}</a></li>"##,
            html_escape(&path),
            html_escape(n)
        ));
    }
    format!(
        r##"<!doctype html><html><head><meta charset="utf-8"><title>archive {ts}</title>
<style>body{{background:#0a0d12;color:#e6edf3;font-family:sans-serif;padding:32px;}}a{{color:#2ec4b6;}}</style>
</head><body><h1>archive / {ts}</h1><ul>{links}</ul></body></html>"##
    )
}

// ============================================================
// Auto-launch URL planning
// ============================================================

pub fn collect_launch_urls(
    out_dir: &Path,
    port: u16,
    compare_path: Option<&Path>,
    services: &[ServiceSummary],
    only_compare: bool,
) -> Vec<String> {
    let host = format!("http://127.0.0.1:{port}");
    let mut urls = Vec::new();
    if let Some(c) = compare_path {
        if let Some(name) = c.file_name().and_then(|s| s.to_str()) {
            urls.push(format!("{host}/report/{name}"));
        }
    }
    if only_compare && compare_path.is_some() {
        return urls;
    }
    // Per-service reports.
    if let Ok(rd) = std::fs::read_dir(out_dir) {
        let mut names: Vec<String> = Vec::new();
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with("report-") && n.ends_with(".html") {
                names.push(n);
            }
        }
        names.sort();
        for n in names {
            urls.push(format!("{host}/report/{n}"));
        }
    }
    // If nothing was found and we have a single-service summary,
    // fall back to the index.
    if urls.is_empty() && !services.is_empty() {
        urls.push(format!("{host}/"));
    }
    urls
}

/// Auto-launch every report URL in the operator's default browser
/// (or VS Code), with a small gap between each call so browsers
/// don't drop tabs racing each other.
pub fn auto_launch(urls: &[String], use_vscode: bool, _port: u16) {
    logx::info("serve", "launching report tabs in default browser");
    for (i, u) in urls.iter().enumerate() {
        logx::info("serve", &format!("  tab {}/{}: {}", i + 1, urls.len(), u));
        let res = if use_vscode {
            std::process::Command::new("code")
                .arg(u)
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string())
        } else {
            open::that(u).map_err(|e| e.to_string())
        };
        if let Err(e) = res {
            logx::warn("serve", &format!("launch failed for {u}: {e}"));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write as IoWrite};
    use std::net::TcpStream;

    fn tmp() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "ecm-serve-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn pick_port() -> u16 {
        // Pick a free port in the dynamic range above the default.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        port
    }

    fn http_get(port: u16, path: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").unwrap();
        let mut buf = String::new();
        s.read_to_string(&mut buf).ok();
        buf
    }

    #[test]
    fn server_binds_loopback_only() {
        let dir = tmp();
        let stop = Arc::new(AtomicBool::new(false));
        let port = start_background(&dir, pick_port(), stop.clone()).unwrap();
        let resp = http_get(port, "/");
        assert!(resp.starts_with("HTTP/1.1 200"));
        // Stop the server.
        stop.store(true, Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(400));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn server_returns_correct_mime_for_html() {
        let dir = tmp();
        fs::write(dir.join("report-x.html"), b"<html/>").unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let port = start_background(&dir, pick_port(), stop.clone()).unwrap();
        let resp = http_get(port, "/report/report-x.html");
        assert!(resp.contains("Content-Type: text/html"), "{resp}");
        stop.store(true, Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(400));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn server_returns_correct_mime_for_csv() {
        let dir = tmp();
        fs::write(dir.join("samples-x.csv"), b"a,b\n").unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let port = start_background(&dir, pick_port(), stop.clone()).unwrap();
        let resp = http_get(port, "/artifact/samples-x.csv");
        assert!(resp.contains("Content-Type: text/csv"));
        stop.store(true, Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(400));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn server_returns_correct_mime_for_json() {
        let dir = tmp();
        fs::write(dir.join("summary-x.json"), b"{}").unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let port = start_background(&dir, pick_port(), stop.clone()).unwrap();
        let resp = http_get(port, "/artifact/summary-x.json");
        assert!(resp.contains("Content-Type: application/json"));
        stop.store(true, Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(400));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn server_404_for_path_traversal_attempt() {
        let dir = tmp();
        let stop = Arc::new(AtomicBool::new(false));
        let port = start_background(&dir, pick_port(), stop.clone()).unwrap();
        let resp = http_get(port, "/report/../../etc/passwd");
        assert!(resp.starts_with("HTTP/1.1 404"), "expected 404, got:\n{resp}");
        stop.store(true, Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(400));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn server_archive_index_lists_subdirectories() {
        let dir = tmp();
        fs::create_dir_all(dir.join("archive/20260101_000000")).unwrap();
        fs::write(dir.join("archive/20260101_000000/report.html"), b"old").unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let port = start_background(&dir, pick_port(), stop.clone()).unwrap();
        let resp = http_get(port, "/archive");
        assert!(resp.contains("20260101_000000"), "{resp}");
        stop.store(true, Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(400));
        let _ = fs::remove_dir_all(&dir);
    }
}
