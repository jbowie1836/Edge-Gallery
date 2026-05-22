@echo off
REM ===========================================================
REM ecm-loadtest upgrade script (Windows)
REM -----------------------------------------------------------
REM Purpose:
REM   One-click toolchain + dependency refresh. Double-click from
REM   File Explorer or run from cmd / PowerShell.
REM
REM Steps (all six run regardless of individual failures):
REM   1. Refresh rustup itself
REM   2. Update the stable toolchain
REM   3. Install/refresh helper cargo subcommands
REM   4. Update Cargo.lock to latest compatible versions
REM   5. Report outdated dependencies (info only)
REM   6. Security audit
REM
REM What this script does NOT do:
REM   - Modify Cargo.toml (operator does that based on output)
REM   - Create git commits
REM   - Switch toolchain channels
REM   - Retry on network failures
REM ===========================================================

echo ecm-loadtest upgrade script
echo.

REM --- STEP 1: refresh rustup itself ---
echo === STEP 1: refresh rustup itself ===
where rustup >nul 2>&1
if errorlevel 1 (
    echo rustup not on PATH. Install from https://rustup.rs and re-run.
) else (
    rustup self update
)
echo STEP 1 exit code: %errorlevel%
echo.

REM --- STEP 2: update stable toolchain ---
echo === STEP 2: update stable toolchain ===
where rustup >nul 2>&1
if not errorlevel 1 rustup update stable
echo STEP 2 exit code: %errorlevel%
echo.

REM --- STEP 3: install/refresh helper subcommands ---
echo === STEP 3: install/refresh helper cargo subcommands ===
cargo install --list | findstr /B "cargo-update " >nul 2>&1
if errorlevel 1 cargo install cargo-update
cargo install --list | findstr /B "cargo-outdated " >nul 2>&1
if errorlevel 1 cargo install cargo-outdated
cargo install --list | findstr /B "cargo-audit " >nul 2>&1
if errorlevel 1 cargo install cargo-audit
cargo install-update -a
echo STEP 3 exit code: %errorlevel%
echo.

REM --- STEP 4: update Cargo.lock ---
echo === STEP 4: update Cargo.lock to latest compatible versions ===
cargo update
echo STEP 4 exit code: %errorlevel%
echo.

REM --- STEP 5: report outdated direct deps ---
echo === STEP 5: report outdated dependencies (info only) ===
cargo outdated --root-deps-only
echo STEP 5 exit code: %errorlevel%
echo.

REM --- STEP 6: security audit ---
echo === STEP 6: security audit ===
cargo audit
echo STEP 6 exit code: %errorlevel%
echo.

REM --- Summary ---
echo ============================================================
echo UPGRADE COMPLETE
for /f "delims=" %%v in ('rustup --version 2^>nul') do set RUSTUP_V=%%v
for /f "delims=" %%v in ('rustc --version 2^>nul') do set RUSTC_V=%%v
for /f "delims=" %%v in ('cargo --version 2^>nul') do set CARGO_V=%%v
echo   rustup version: %RUSTUP_V%
echo   rustc version:  %RUSTC_V%
echo   cargo version:  %CARGO_V%
echo ============================================================

pause
