#!/usr/bin/env bash
# ===========================================================
# ecm-loadtest upgrade script (Linux / macOS)
# -----------------------------------------------------------
# Purpose:
#   One-click toolchain + dependency refresh.
#
# Steps (all six run regardless of individual failures):
#   1. Refresh rustup itself
#   2. Update the stable toolchain
#   3. Install/refresh helper cargo subcommands
#   4. Update Cargo.lock to latest compatible versions
#   5. Report outdated dependencies (info only)
#   6. Security audit
#
# What this script does NOT do:
#   - Modify Cargo.toml (operator does that based on output)
#   - Create git commits
#   - Switch toolchain channels
#   - Retry on network failures
# ===========================================================

set -u

echo "ecm-loadtest upgrade script"
echo

# --- STEP 1: refresh rustup itself ---
echo "=== STEP 1: refresh rustup itself ==="
if command -v rustup >/dev/null 2>&1; then
    rustup self update
else
    echo "rustup not on PATH. Install from https://rustup.rs and re-run."
fi
echo "STEP 1 exit code: $?"
echo

# --- STEP 2: update stable toolchain ---
echo "=== STEP 2: update stable toolchain ==="
if command -v rustup >/dev/null 2>&1; then
    rustup update stable
fi
echo "STEP 2 exit code: $?"
echo

# --- STEP 3: install/refresh helper subcommands ---
echo "=== STEP 3: install/refresh helper cargo subcommands ==="
if ! cargo install --list 2>/dev/null | grep -q '^cargo-update '; then
    echo "Installing cargo-update..."
    cargo install cargo-update
fi
if ! cargo install --list 2>/dev/null | grep -q '^cargo-outdated '; then
    echo "Installing cargo-outdated..."
    cargo install cargo-outdated
fi
if ! cargo install --list 2>/dev/null | grep -q '^cargo-audit '; then
    echo "Installing cargo-audit..."
    cargo install cargo-audit
fi
cargo install-update -a
echo "STEP 3 exit code: $?"
echo

# --- STEP 4: update Cargo.lock ---
echo "=== STEP 4: update Cargo.lock to latest compatible versions ==="
cargo update
echo "STEP 4 exit code: $?"
echo

# --- STEP 5: report outdated direct deps ---
echo "=== STEP 5: report outdated dependencies (info only) ==="
cargo outdated --root-deps-only
echo "STEP 5 exit code: $?"
echo

# --- STEP 6: security audit ---
echo "=== STEP 6: security audit ==="
cargo audit
echo "STEP 6 exit code: $?"
echo

# --- Summary ---
echo "============================================================"
echo "UPGRADE COMPLETE"
RUSTUP_V=$(rustup --version 2>/dev/null | head -1)
RUSTC_V=$(rustc --version 2>/dev/null)
CARGO_V=$(cargo --version 2>/dev/null)
echo "  rustup version: ${RUSTUP_V}"
echo "  rustc version:  ${RUSTC_V}"
echo "  cargo version:  ${CARGO_V}"
echo "============================================================"

read -r -p "Press Enter to close..." _ </dev/tty 2>/dev/null || true
