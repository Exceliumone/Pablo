# Provenance & modification policy

This directory is an unmodified import of the existing Solana sniper/copy-trading
engine (`solana-vntr-sniper`). It is the trading core of the PABLO platform.

## Rule

**Nothing in `src/` is rewritten.** The DEX adapters (`src/dex/`), swap execution,
selling strategy, risk management, transaction parsing (`src/processor/`), and
RPC/Jupiter/blockhash plumbing (`src/library/`) stay byte-for-byte what they were
at import time, except for the one documented exception below.

## The one sanctioned change (Phase 3, not yet applied)

`src/common/config.rs` currently loads `Config` once per process from `.env` via
a global `OnceCell<Mutex<Config>>`. To run one isolated `executor` per subscriber
(see `docs/ARCHITECTURE.md`), `Config::new()` will be changed to accept its
values as a parameter instead of reading `std::env` directly, so the same binary
can be instantiated per user with different wallets/settings. `.env` loading is
kept as the local-dev fallback. This is a plumbing change only — no trading logic
is touched by it.

## Everything else

New capability (multi-tenancy, HTTP control surface, event streaming) is added
*around* this crate, in `apps/engine-bridge`, which depends on `engine` as a
library (`src/lib.rs` already exposes the modules needed for that).

See `docs/ARCHITECTURE.md` at the repo root for the full rationale.
