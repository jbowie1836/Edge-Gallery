# ecm-loadtest

Single-binary Rust CLI load tester for the ECM Image Viewer Service
and adjacent endpoints (legacy PDF servlet, EWS batch ingestion).
Pure-Rust dependencies only -- rustls TLS, no OpenSSL, no MSVC --
so the project cross-compiles cleanly from Windows to Linux without
a C toolchain.

## Target service

```
Endpoint:   POST {host}/ecmimageviewer/documents/view
Content:    application/json
Body:       {"dcn":"<document control number>"}
Response:   application/pdf bytes
```

The ECM Image Viewer Service is a Spring Boot 2.0.2 PDF retrieval
service handling roughly 8.4 million POST requests per month from
STP, TLM, CCI, and Doc Center.

## Build

Linux:

```
cargo build --release
```

Windows GNU toolchain (no MSVC required):

```
rustup target add x86_64-pc-windows-gnu
cargo build --release --target x86_64-pc-windows-gnu
```

Linux musl (static binary) from any host:

```
rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl
```

The release binary lands at `target/<target>/release/ecm-loadtest`
and is < 15 MB stripped.

## Subcommands

```
ecm-loadtest run --config PATH [--out-dir DIR]
                 [--no-archive] [--no-serve] [--no-launch]
                 [--port N] [--vscode] [--env LABEL]
                 [--no-report] [--stop-at-error-pct PCT]
                 [--target-rps N] [--launch-only-compare]
                 [--skip-post-validation]

ecm-loadtest report --run-id TS [--out-dir DIR]
ecm-loadtest serve  [--out-dir DIR] [--port N]
ecm-loadtest tui    [--config PATH] [--out-dir DIR]
ecm-loadtest docs   [--out-path PATH]
ecm-loadtest example-config
```

## Sample workflow

```
# 1. Emit a starter YAML config
./ecm-loadtest example-config > loadtest.yaml

# 2. Edit it -- pick the services you want, set host URLs

# 3. Run the load test
./ecm-loadtest run --config loadtest.yaml

# 4. The default browser opens at
#    http://127.0.0.1:8765/report/<latest>.html
#    with one tab per produced report
```

Prior runs are accessible at `http://127.0.0.1:8765/archive`.

## Configuration

The YAML config has two levels:

1. **Top-level settings** shared across the entire run (load
   pattern, global timeouts, output directory).
2. A `services:` list where each entry is an independent target.
   Each service runs concurrently with the others. Comment a
   service out -- or set `enabled: false` -- to skip it.

A run with N enabled services produces N independent samples CSVs,
N summary JSONs, and N HTML reports, plus one cross-service
comparison report when 2+ services are enabled.

See `examples/loadtest.yaml` for a fully annotated config.

## Load patterns

```
sustained     Linear ramp to N concurrent users, then hold for D
              seconds. Optional target_rps cap.
stress        Walk through a list of (concurrency, duration_seconds)
              stages without cooldown.
rate_levels   Rate-targeted pattern: drive at exactly R req/sec for
              D seconds, repeat runs_per_rate times, advance to the
              next rate. Designed for the AC1-AC4 comparison
              matrix.
```

## Service templates

The `templates/` folder ships four service templates that encode
the defaults for a class of service:

```
pdf-retrieval-service.yaml      Online POST, JSON in / PDF out
json-api-service.yaml           Online POST, JSON in / JSON out
legacy-pdf-servlet.yaml         Online POST, form-urlencoded / PDF
batch-ingestion-service.yaml    Batch file-drop with log_marker
```

Each service block in `loadtest.yaml` references a template via
`template: <name>` and overrides only the fields that differ from
the template default.

## Auth

A service block with no `auth:` key sends requests unauthenticated.
When `auth:` is present, the supported modes are:

```
basic            HTTP Basic from username + password (or ECM_PASSWORD env)
bearer           Authorization: Bearer <bearer_token>
webseal-cookie   verbatim PD-S-SESSION-ID=... cookie
```

Auth is per-service; the same run can hit one service
unauthenticated and another with basic auth.

## Metrics

Every run produces a metric surface PER service PER rate (or volume)
PER run:

```
Request counts        sent, ok, failed, documents_rendered, error_rate_pct
Throughput            mean / peak / min / stddev rps, target vs actual
Response time         three independent HDR histograms:
                      ttfb_us, transfer_us, total_us
                      p10/p25/p50/p75/p90/p95/p99/p99.9/max/mean/stddev
Apdex                 satisfied / tolerating / frustrated buckets, score
Error breakdown       timeout / connect / tls / status_4xx / status_5xx /
                      body_too_small / body_too_large / bad_magic_bytes / other
Data volume           total bytes, response_size percentiles
Concurrency           in_flight_max, in_flight_mean
Batch-only            documents_dropped / picked_up / unprocessed,
                      pickup_latency percentiles, processing_latency,
                      e4931_count
```

Cross-run aggregates (mean / min / max / stddev / per_run) are
emitted to `rate-aggregate-*.json` and `volume-aggregate-*.json`
when `runs_per_rate >= 2` or `runs_per_volume >= 2`.

## Output artifacts

```
samples-<service>-<env>-rate<R>-run<N>-<ts>.csv    per-request rows
summary-<service>-<env>-rate<R>-run<N>-<ts>.json   per-run metric block
report-<service>-<env>-rate<R>-run<N>-<ts>.html    dark-theme HTML report

rate-aggregate-<service>-<env>-rate<R>-<ts>.json   AC3 envelope
rate-aggregate-<service>-<env>-rate<R>-<ts>.html   per-rate HTML aggregate

documents-<service>-<env>-vol<V>-run<N>-<ts>.csv   batch per-document rows
volume-aggregate-<service>-<env>-vol<V>-<ts>.json  batch AC3 envelope

compare-<ts>.html                                  cross-service compare (AC4)
validation-<ts>.json + .html                       post-run validation suite
```

Archive rotation is automatic: prior outputs in the results
directory move into `<out_dir>/archive/<archive_ts>/` BEFORE the
new run writes a single file. Add `--no-archive` to disable.

## Embedded report server

After a `run` (unless `--no-serve`) the binary starts a tiny_http
server on `127.0.0.1:8765` (loopback only, never the network) and
auto-launches every produced report URL in the default browser as
separate tabs. The compare report (when present) opens first as
the active tab.

```
GET /                       run index
GET /report/<filename>      HTML report files
GET /artifact/<filename>    CSV / JSON artifacts
GET /archive                archive index
GET /archive/<ts>/[<file>]  archived run files
GET /favicon.ico            embedded 1x1 PNG
```

Path-traversal attempts return 404. Responses set
`Cache-Control: no-store` so a re-run shows fresh content.

CLI overrides:

```
--no-launch              skip the browser open; server stays up
--launch-only-compare    open just the compare URL for multi-service runs
--vscode                 open every report file in VS Code instead
--port N                 override the default 8765
```

## Exit codes

```
   0   success
  10   config parse error
  11   config validation error
  12   config conflict (duplicate name, empty services list, ...)
  13   manifest file missing
  14   manifest schema invalid
  15   manifest data invalid
  20   batch drop folder problem
  21   batch source file missing
  22   batch log_marker problem
  23   SFTP connect failure
  24   SFTP auth rejected
  25   SFTP permission
  30   server bind failed
  40   filesystem permission denied
  41   filesystem disk full
  50   shutdown incomplete
  60   post-run validation failure
  70   bug (panic caught)
 130   user interrupt (Ctrl+C before any artifact written)
```

## Cross-platform notes

- Filesystem operations use `std::path::PathBuf`; no hardcoded
  `/` or `\`.
- Vendor folder GID checks on Linux are logged-only; Windows
  skips with a debug line.
- TLS is rustls (pure Rust). No openssl, no openssl-sys, no MSVC.
- The SFTP transport uses `russh` + `russh-sftp` (also pure Rust).

## Upgrade toolchain + deps

Run `./upgrade.sh` on Linux/macOS or double-click `upgrade.bat` on
Windows. Both scripts execute the same six steps:

```
1. rustup self update
2. rustup update stable
3. install / refresh cargo-update, cargo-outdated, cargo-audit
4. cargo update
5. cargo outdated --root-deps-only
6. cargo audit
```

Neither script edits `Cargo.toml` or creates git commits.

## Sample gRPC test target

`samples/grpc-pdf-server/` is a separate Cargo crate that exposes
a gRPC server-streaming RPC returning PDF bytes from a folder.
Useful as a local test target. See its dedicated README for build
and run instructions.

## Acceptance criteria mapping

```
AC1 (online) ->  per-service per-rate per-run summary JSON (legacy PDF servlet)
AC2 (online) ->  per-service per-rate per-run summary JSON (ECM Image Viewer Service)
AC3 (online) ->  rate-aggregate-*.json with mean / min / max across >= 3 runs
AC4 (online) ->  compare-<ts>.html implementation delta table

AC1 (batch)  ->  baseline MQ-mode batch summary JSON
AC2 (batch)  ->  per-service per-volume per-run batch summary JSON
AC3 (batch)  ->  volume-aggregate-*.json with mean / min / max across >= 3 runs
AC4 (batch)  ->  compare-<ts>.html with E4931 frequency delta
```

## Status of this build

The core code paths are implemented and pass `cargo test`. The
following surfaces are scoped down relative to the full build
prompt and called out honestly:

- `tui` subcommand is a stub that logs a "not yet wired" message;
  the full ratatui dashboard with live tick streams is not yet
  implemented
- `docs/playbook.html` ships as a smaller (60-150 KB target)
  self-contained playbook rather than the full 200 KB-1 MB target
- SFTP transport is scaffolded with the correct YAML schema and
  error categories; no live integration test against a real server
- The 6-pass END-TO-END AUDIT and the multi-part FULL TEST RUN
  with parallel mock servers were not run inline at delivery time
