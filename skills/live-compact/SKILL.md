---
name: live-compact
description: >-
  Inspect Antigravity Live Compact statistics, shadow backups, token savings,
  and configuration thresholds. Use when the user asks about Live Compact status,
  context watermark savings, or wants to search/inspect archived tool outputs.
---

# Live Compact Inspector

Use the bundled `shadow` MCP server tools (`shadow_stats`, `shadow_search`, `shadow_read`) to inspect compression activity for the current or recent sessions:

1. Call `shadow_stats` to view total cuts, raw vs compacted bytes, estimated tokens saved, update status, and the list of archived shadow backups.
2. When locating a specific detail in a compressed log or command output, call `shadow_search` with the `shadowId` and a focused keyword or regex pattern.
3. Call `shadow_read` with bounded `startLine` and `endLine` (<= 150 lines) only when surrounding lines are needed.
4. When the user asks to check or upgrade Live Compact, run `node "$env:USERPROFILE\.gemini\config\plugins\live-compact\scripts\update-check.mjs" --check` (or `--apply` to upgrade in place and run all gate tests).

## Environment Knobs

- `AGY_LIVE_COMPACT_DISABLED=1`: Temporarily bypass all Live Compact hooks.
- `AGY_LIVE_COMPACT_NO_UPDATE_CHECK=1`: Disable the non-blocking `SessionStart` update check banner.
- `AGY_LIVE_COMPACT_SMALL_CHARS` (default `18432`) / `AGY_LIVE_COMPACT_SMALL_LINES` (default `240`): Command outputs within both limits pass through 100% verbatim to avoid unnecessary recall round-trips on compact diagnostic scripts and snapshots.
- `AGY_LIVE_COMPACT_CARD_BUDGET` (default `2800`) / `AGY_LIVE_COMPACT_FAILURE_BUDGET` (default `6400`): Character budgets for compacted Spine Cards (requires >= 35% real reduction).
- `AGY_LIVE_COMPACT_LOG_MIN_BYTES` (default `16384`, >= `240` lines) / `AGY_LIVE_COMPACT_JSON_MIN_BYTES` (default `32768`, >= `400` lines) / `AGY_LIVE_COMPACT_CODE_MIN_BYTES` (default `81920`, >= `1500` lines): Minimum file sizes for unbounded `read_file` compaction (bounded reads <= `250` lines always pass through raw).
- `AGY_LIVE_COMPACT_SHADOW_DIR`: Override shadow backup root (default `~/.gemini/antigravity/live-compact/shadow`). Context watermark is computed on demand by `shadow_stats` directly from `transcript_full.jsonl` with zero per-step `PreInvocation` hook overhead.
