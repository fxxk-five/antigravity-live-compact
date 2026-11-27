#!/usr/bin/env node
/**
 * Unit & integration gate for Antigravity Live Compact.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpineCard, estimateTokens, isToolFailure, readConfig, shouldWrapCommand } from "./plan.mjs";
import { readShadowLines, readShadowStats, saveShadowBackup, searchShadow } from "./shadow.mjs";
import { compareVersions, evaluateUpdateNotice, saveUpdateCache } from "./update-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "agy-lc-test-"));

try {
  // 1. Small command output passes through verbatim
  const small = buildSpineCard({
    text: "line 1\nline 2\nOK\n",
    sourceType: "command",
    sourceLabel: "echo ok",
    exitCode: 0,
  });
  assert.equal(small.compacted, false);
  assert.equal(small.reason, "small-output");

  // 2. Large noisy log compacts and preserves signals + shadow pointer
  const logLines = [];
  for (let i = 1; i <= 400; i += 1) {
    logLines.push(`2026-11-25T10:00:${String(i % 60).padStart(2, "0")} INFO worker-${i % 4} processed item=${i} status=ok payload=0123456789abcdef`);
  }
  logLines[120] = "2026-11-25T10:02:01 NOTICE deploy-gate: canary_version=v4.9.2 must not rollback";
  logLines[250] = "2026-11-25T10:04:11 WARN cache-pool: high_miss_ratio=0.42 shard=eu-west-3";
  logLines[310] = "2026-11-25T10:05:11 INFO worker-1 needle_middle_metric=latency_9876ms";
  const bigLog = logLines.join("\n") + "\n";

  const backup = saveShadowBackup({
    root: tmp,
    conversationId: "conv-unit-1",
    toolName: "run_command",
    callId: "call_1",
    sourceType: "command",
    sourceLabel: "cat service.log",
    exitCode: 0,
    rawText: bigLog,
  });
  assert.equal(backup.ok, true);
  assert.match(backup.shadowId, /^raw-[0-9a-f]{16}$/);

  const built = buildSpineCard({
    text: bigLog,
    sourceType: "command",
    sourceLabel: "cat service.log",
    exitCode: 0,
    shadowId: backup.shadowId,
    conversationId: "conv-unit-1",
    sha256: backup.sha256,
    bytes: backup.bytes,
  });
  assert.equal(built.compacted, true);
  assert.ok(built.savedTokens > 5000, `expected >5000 saved tokens, got ${built.savedTokens}`);
  assert.ok(built.card.includes("WARN=1"), "should include WARN count");
  assert.ok(built.card.includes("NOTICE=1"), "should include NOTICE count");
  assert.ok(built.card.includes("canary_version=v4.9.2"), "should keep NOTICE line");
  assert.ok(built.card.includes(backup.shadowId), "should include shadowId pointer");

  // 3. Shadow search recovers omitted middle needle
  const searchRes = searchShadow({
    root: tmp,
    shadowId: backup.shadowId,
    pattern: "needle_middle_metric",
    contextLines: 1,
  });
  assert.equal(searchRes.found, true);
  assert.equal(searchRes.totalMatches, 1);
  assert.equal(searchRes.matches[0].line, 311);
  assert.ok(searchRes.matches[0].text.includes("latency_9876ms"));

  // 4. Shadow bounded read works
  const readRes = readShadowLines({
    root: tmp,
    shadowId: backup.shadowId,
    startLine: 309,
    endLine: 313,
  });
  assert.equal(readRes.ok, true);
  assert.ok(readRes.content.includes("L311:"));

  // 5. Failed command preserves diagnostics
  const failLines = [...logLines];
  failLines[299] = "AssertionError: expected checksum 0xdeadbeef got 0xbad00001";
  failLines[300] = "FAILED tests/test_crypto.py::test_verify_sig";
  const failCard = buildSpineCard({
    text: failLines.join("\n"),
    sourceType: "command",
    sourceLabel: "pytest",
    exitCode: 1,
    isError: true,
    shadowId: backup.shadowId,
    conversationId: "conv-unit-1",
    sha256: backup.sha256,
    bytes: backup.bytes,
  });
  assert.equal(failCard.compacted, true);
  assert.equal(failCard.failed, true);
  assert.ok(failCard.card.includes("0xdeadbeef"), "failed card must preserve AssertionError");
  assert.ok(failCard.card.includes("FAILED tests/test_crypto.py"), "failed card must preserve FAILED line");

  // 6. live-compact-exec end-to-end exit code & compaction test
  const specPath = join(tmp, "spec-fail.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      cmd: "1..300 | ForEach-Object { Write-Output \"INFO line $_ payload=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\" }; Write-Output 'ERROR: synthetic_boom_42'; exit 3",
      convId: "conv-exec-1",
      callId: "call_exec_1",
      shadowRoot: tmp,
    }),
  );
  const execRes = spawnSync(process.execPath, [join(HERE, "live-compact-exec.mjs"), specPath], {
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: tmp },
  });
  assert.equal(execRes.status, 3, `expected exit 3, got ${execRes.status} stderr=${execRes.stderr}`);
  assert.ok(execRes.stdout.includes("[Live Compact · Spine Card] (exit=3 FAILED)"), "exec should emit Spine Card");
  assert.ok(execRes.stdout.includes("synthetic_boom_42"), "exec should keep error line");

  // 7. MCP server JSON-RPC handshake + tools/list + tools/call
  const mcpIn = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "shadow_search", arguments: { shadowId: backup.shadowId, pattern: "latency_9876ms" } },
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "shadow_stats", arguments: { conversationId: "conv-exec-1" } },
    }),
  ].join("\n") + "\n";

  const mcpRes = spawnSync(process.execPath, [join(HERE, "mcp-server.mjs")], {
    input: mcpIn,
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: tmp },
  });
  assert.equal(mcpRes.status, 0, `mcp exited ${mcpRes.status}: ${mcpRes.stderr}`);
  const replies = mcpRes.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(replies.length, 4);
  assert.equal(replies[1].result.tools.length, 3);
  assert.ok(replies[2].result.content[0].text.includes("latency_9876ms"));
  assert.ok(replies[3].result.content[0].text.includes('"cuts": 1'));

  // 8. hook-dispatch PreToolUse read_file skips bounded reads and compacts unbounded huge log
  const workDir = join(tmp, "work");
  const shadowDir = join(tmp, "shadow");
  mkdirSync(workDir, { recursive: true });
  const hugeLog = join(workDir, "huge.log");
  writeFileSync(hugeLog, bigLog, "utf8");
  const hookBounded = spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
    input: JSON.stringify({
      hookEventName: "PreToolUse",
      conversationId: "conv-hook-1",
      toolCall: { id: "c1", name: "read_file", args: { Path: hugeLog, StartLine: 10, EndLine: 40 } },
    }),
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir },
  });
  const boundedOut = JSON.parse(hookBounded.stdout);
  assert.equal(boundedOut.overwrite, undefined, "bounded read_file must pass through untouched");

  const hookUnbounded = spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
    input: JSON.stringify({
      hookEventName: "PreToolUse",
      conversationId: "conv-hook-1",
      toolCall: { id: "c2", name: "read_file", args: { Path: hugeLog } },
    }),
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir },
  });
  const unboundedOut = JSON.parse(hookUnbounded.stdout);
  assert.ok(unboundedOut.overwrite?.Path?.includes("card-raw-"), "unbounded huge log should rewrite to Spine Card");
  assert.equal(unboundedOut.overwrite?.StartLine, 1);
  assert.equal(unboundedOut.overwrite?.EndLine, 800);

  // 9. Passing test lines (`✔ ... failed ...`) do not trigger false ERRORs or evict real `✖` failures / `ℹ pass` tail
  const testRunnerLines = [];
  for (let i = 1; i <= 250; i += 1) {
    testRunnerLines.push(`✔ test case ${i}: fails closed on invalid token / ECONNREFUSED (${i}ms)`);
  }
  testRunnerLines.push("✖ test case 251: actual failure in handler (12ms)");
  testRunnerLines.push("  AssertionError: expected 200 got 500");
  testRunnerLines.push("ℹ tests 251");
  testRunnerLines.push("ℹ pass 250");
  testRunnerLines.push("ℹ fail 1");
  const testFailCard = buildSpineCard({
    text: testRunnerLines.join("\n"),
    sourceType: "command",
    sourceLabel: "node --test",
    exitCode: 1,
    isError: true,
    shadowId: backup.shadowId,
    conversationId: "conv-unit-1",
    sha256: backup.sha256,
    bytes: backup.bytes,
  });
  assert.equal(testFailCard.compacted, true);
  assert.ok(testFailCard.card.includes("✖ test case 251"), "failed test card must keep real ✖ failure");
  assert.ok(testFailCard.card.includes("AssertionError: expected 200 got 500"), "failed test card must keep AssertionError");
  assert.ok(testFailCard.card.includes("ℹ fail 1"), "failed test card must keep tail summary");
  assert.ok(testFailCard.signals.errorCount <= 3, `expected <=3 real errors, got ${testFailCard.signals.errorCount}`);
  const errSection = testFailCard.card.split("Errors / Failure diagnostics:")[1]?.split("\nTail:")[0] || "";
  assert.equal((errSection.match(/✔ /g) || []).length, 0, "passing ✔ tests must not enter error section");

  // 10. Small JSON files (<16KB / <300 lines) pass through read_file untouched
  const smallJson = join(workDir, "results.json");
  writeFileSync(smallJson, JSON.stringify({ items: Array.from({ length: 85 }, (_, i) => ({ id: i, status: "ok" })) }, null, 2), "utf8");
  const hookSmallJson = spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
    input: JSON.stringify({
      hookEventName: "PreToolUse",
      conversationId: "conv-hook-1",
      toolCall: { id: "c3", name: "read_file", args: { Path: smallJson } },
    }),
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir },
  });
  assert.equal(JSON.parse(hookSmallJson.stdout).overwrite, undefined, "moderate JSON results file should pass through verbatim");

  // 11. Mini Program (.wxml / .wxss / .wxs) source files (<28KB) pass through read_file untouched
  for (const name of ["page.wxml", "page.wxss", "helper.wxs"]) {
    const p = join(workDir, name);
    writeFileSync(p, Array.from({ length: 180 }, (_, i) => `/* line ${i + 1} */ .cls-${i} { display: flex; padding: 8rpx; }\n`).join(""), "utf8");
    const hookMp = spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
      input: JSON.stringify({
        hookEventName: "PreToolUse",
        conversationId: "conv-hook-1",
        toolCall: { id: `mp_${name}`, name: "read_file", args: { Path: p } },
      }),
      encoding: "utf8",
      env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir },
    });
    assert.equal(JSON.parse(hookMp.stdout).overwrite, undefined, `${name} (<28KB) must pass through verbatim`);
  }

  // 12. Concise 48-line / ~7.2KB search output passes through verbatim, and marginal-saving output (<35% saved) is not compacted
  const conciseSearch = Array.from({ length: 48 }, (_, i) => `/workspace/project/src/services/client/index.mjs:${100 + i}: export function handler_${i}(ctx, payload, options) { return processEvidenceItem(ctx, payload, options, ${i}); }`).join("\n");
  assert.ok(conciseSearch.length > 6500 && conciseSearch.length < 8192, `len=${conciseSearch.length}`);
  const conciseBuilt = buildSpineCard({
    text: conciseSearch,
    sourceType: "command",
    sourceLabel: "Select-String -First 48",
    exitCode: 0,
  });
  assert.equal(conciseBuilt.compacted, false, "48-line ~7.2KB search output should pass through verbatim");

  const marginalText = Array.from({ length: 95 }, (_, i) => `L${i + 1}: row_${i}_short`).join("\n");
  assert.ok(marginalText.length < 2500);
  const marginalBuilt = buildSpineCard({
    text: marginalText,
    sourceType: "command",
    sourceLabel: "short-95-lines",
    exitCode: 0,
  });
  assert.equal(marginalBuilt.compacted, false, "marginal-saving output (<35% char reduction) must not compact");

  // 13. Incremental PreInvocation transcript scan tracks lastByteOffset accurately across appended turns
  const fakeTranscript = join(workDir, "transcript_full.jsonl");
  const convInc = "conv-inc-1";
  writeFileSync(
    fakeTranscript,
    JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", input_tokens: 15000, cache_read_tokens: 0 }) + "\n",
    "utf8",
  );
  const runPreInv = () => spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
    input: JSON.stringify({ hookEventName: "PreInvocation", conversationId: convInc, transcriptPath: fakeTranscript }),
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir },
  });
  assert.equal(runPreInv().status, 0);
  const wm1 = JSON.parse(readFileSync(join(shadowDir, convInc, "watermark.json"), "utf8"));
  assert.equal(wm1.scanVersion, 2);
  assert.equal(wm1.plannerSteps, 1);
  assert.equal(wm1.peakContext, 15000);
  assert.ok(wm1.lastByteOffset > 0);

  appendFileSync(
    fakeTranscript,
    JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", model: "gemini-4-neon-high", input_tokens: 3000, cache_read_tokens: 125000 }) + "\n",
    "utf8",
  );
  const preRes2 = runPreInv();
  assert.equal(preRes2.status, 0);
  const preOut2 = JSON.parse(preRes2.stdout);
  assert.ok(preOut2.injectSteps?.[0]?.systemMessage?.systemMessage?.includes("128,000"), "should emit watermark advisory at 128k");
  const wm2 = JSON.parse(readFileSync(join(shadowDir, convInc, "watermark.json"), "utf8"));
  assert.equal(wm2.plannerSteps, 2);
  assert.equal(wm2.peakContext, 128000);
  assert.equal(wm2.totalInput, 18000);
  assert.equal(wm2.totalCacheRead, 125000);
  assert.ok(wm2.lastByteOffset > wm1.lastByteOffset);

  // 14. Stale .cmd-*.json (>10min old) is swept on next wrapped PreToolUse run_command
  const staleDir = join(shadowDir, "conv-stale-sweep");
  mkdirSync(staleDir, { recursive: true });
  const staleSpec = join(staleDir, ".cmd-old-1234.json");
  writeFileSync(staleSpec, "{}", "utf8");
  const oldDate = new Date(Date.now() - 15 * 60 * 1000);
  utimesSync(staleSpec, oldDate, oldDate);
  const hookRun = spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
    input: JSON.stringify({
      hookEventName: "PreToolUse",
      conversationId: "conv-stale-sweep",
      toolCall: { id: "c_new", name: "run_command", args: { CommandLine: "npm test" } },
    }),
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir },
  });
  assert.equal(hookRun.status, 0);
  assert.equal(existsSync(staleSpec), false, "stale .cmd spec (>10m) should be auto-swept");

  // 15. Windows PowerShell wrapper flushes Select-Object/Format-Table output before exit 0 and propagates cmdlet errors
  if (process.platform === "win32") {
    const psTableSpec = join(tmp, "spec-ps-table.json");
    writeFileSync(
      psTableSpec,
      JSON.stringify({
        cmd: `Get-ChildItem '${workDir.replace(/'/g, "''")}' | Select-Object Name, Length, LastWriteTime; Write-Output '---SEP---'; Get-ChildItem '${HERE.replace(/'/g, "''")}' | Select-Object Name`,
        convId: "conv-ps-table",
        callId: "call_ps_table",
        shadowRoot: tmp,
      }),
    );
    const psTableRes = spawnSync(process.execPath, [join(HERE, "live-compact-exec.mjs"), psTableSpec], {
      encoding: "utf8",
      env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: tmp },
    });
    assert.equal(psTableRes.status, 0, `ps table exited ${psTableRes.status}: ${psTableRes.stderr}`);
    assert.ok(psTableRes.stdout.includes("huge.log"), `Select-Object output was swallowed! stdout=${JSON.stringify(psTableRes.stdout)}`);
    assert.ok(psTableRes.stdout.includes("---SEP---"), "mixed statement separator missing");
    assert.ok(psTableRes.stdout.includes("live-compact-exec.mjs"), "second Select-Object table missing");

    const psErrSpec = join(tmp, "spec-ps-err.json");
    writeFileSync(
      psErrSpec,
      JSON.stringify({
        cmd: `Get-Item '${join(tmp, "does_not_exist_987654").replace(/'/g, "''")}'`,
        convId: "conv-ps-err",
        callId: "call_ps_err",
        shadowRoot: tmp,
      }),
    );
    const psErrRes = spawnSync(process.execPath, [join(HERE, "live-compact-exec.mjs"), psErrSpec], {
      encoding: "utf8",
      env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: tmp },
    });
    assert.notEqual(psErrRes.status, 0, "PowerShell non-terminating cmdlet error must preserve non-zero exit code");
  }

  // 16. Output safely below host ~10.3KB truncation cliff (~8.5KB / 120 lines) passes through verbatim; ~12KB / 160 lines compacts to prevent host blind truncation
  const probeOut = Array.from({ length: 120 }, (_, i) => `row_${String(i + 1).padStart(3, "0")}: status=ok path=sidecar/client/module_${i}.mjs latency=${10 + i}ms`).join("\n");
  assert.ok(probeOut.length > 7000 && probeOut.length < 9800, `len=${probeOut.length}`);
  const probeBuilt = buildSpineCard({
    text: probeOut,
    sourceType: "command",
    sourceLabel: "node probe.mjs",
    exitCode: 0,
  });
  assert.equal(probeBuilt.compacted, false, "8.5KB / 120-line diagnostic output must pass through verbatim");

  const cliffOut = Array.from({ length: 160 }, (_, i) => `row_${String(i + 1).padStart(3, "0")}: status=ok path=sidecar/client/module_inspector_${i}.mjs latency=${10 + i}ms payload=ok`).join("\n");
  assert.ok(cliffOut.length > 10500 && cliffOut.length < 18000, `cliffLen=${cliffOut.length}`);
  const cliffBuilt = buildSpineCard({
    text: cliffOut,
    sourceType: "command",
    sourceLabel: "rg -n module_inspector sidecar/",
    exitCode: 0,
  });
  assert.equal(cliffBuilt.compacted, true, "12KB output above 9.8KB threshold must compact to avoid host 10.3KB blind truncation");

  // 17. Regular source files (<80KB / <1500 lines), output.txt (<16KB / <240 lines), and bounded reads (<=250 lines) pass through; giant source (>=80KB & >=1500 lines) compacts
  const normalSrc = join(workDir, "normal-module.mjs");
  writeFileSync(normalSrc, Array.from({ length: 900 }, (_, i) => `export function fn_${i}(x) { return x + ${i}; } // normal source line padding\n`).join(""), "utf8");
  const hookNormalSrc = spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
    input: JSON.stringify({
      hookEventName: "PreToolUse",
      conversationId: "conv-hook-1",
      toolCall: { id: "c_norm_src", name: "read_file", args: { Path: normalSrc } },
    }),
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir },
  });
  assert.equal(JSON.parse(hookNormalSrc.stdout).overwrite, undefined, "normal ~55KB / 900-line source file must pass through verbatim");

  const smallOutTxt = join(workDir, "output.txt");
  writeFileSync(smallOutTxt, Array.from({ length: 155 }, (_, i) => `output line ${i + 1}: key=val_${i} detail=abcdefghijklmnopqrstuvwxyz0123456789\n`).join(""), "utf8");
  const hookOutTxt = spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
    input: JSON.stringify({
      hookEventName: "PreToolUse",
      conversationId: "conv-hook-1",
      toolCall: { id: "c_out_txt", name: "read_file", args: { Path: smallOutTxt } },
    }),
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir },
  });
  assert.equal(JSON.parse(hookOutTxt.stdout).overwrite, undefined, "155-line output.txt must pass through verbatim");

  const giantSrc = join(workDir, "giant-bundle.mjs");
  writeFileSync(giantSrc, Array.from({ length: 1600 }, (_, i) => `export const ITEM_${i} = { idx: ${i}, label: "payload_padding_for_giant_source_file_${i}" };\n`).join(""), "utf8");
  const hookGiantBounded = spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
    input: JSON.stringify({
      hookEventName: "PreToolUse",
      conversationId: "conv-hook-1",
      toolCall: { id: "c_giant_b", name: "read_file", args: { Path: giantSrc, StartLine: 1, EndLine: 220 } },
    }),
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir },
  });
  assert.equal(JSON.parse(hookGiantBounded.stdout).overwrite, undefined, "bounded read <=250 lines must pass through verbatim");

  const hookGiantUnbounded = spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
    input: JSON.stringify({
      hookEventName: "PreToolUse",
      conversationId: "conv-hook-1",
      toolCall: { id: "c_giant_u", name: "read_file", args: { Path: giantSrc } },
    }),
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir },
  });
  assert.ok(JSON.parse(hookGiantUnbounded.stdout).overwrite?.Path?.includes("card-raw-"), "giant >=80KB / >=1500-line source read must compact");

  // 18. hooks.json registers SessionStart + PreToolUse (no blocking PreInvocation) and readShadowStats computes watermark on demand
  const hooksCfg = JSON.parse(readFileSync(join(HERE, "..", "hooks.json"), "utf8"));
  assert.equal(hooksCfg["live-compact"].PreInvocation, undefined, "hooks.json should not register blocking PreInvocation hook");
  assert.ok(Array.isArray(hooksCfg["live-compact"].SessionStart) && hooksCfg["live-compact"].SessionStart.length === 1, "hooks.json should register SessionStart update hook");
  const onDemandStats = readShadowStats({ root: tmp, conversationId: "conv-exec-1", transcriptPath: fakeTranscript });
  assert.equal(onDemandStats.watermark?.source, "on-demand-transcript");
  assert.equal(onDemandStats.watermark?.peakContext, 128000);
  assert.equal(onDemandStats.watermark?.plannerSteps, 2);

  // 19. Semver comparison & SessionStart UI-only update notice (metadata.user_markdown, empty systemMessage)
  assert.equal(compareVersions("1.2.1", "1.2.0"), 1);
  assert.equal(compareVersions("v1.2.0", "1.2.0"), 0);
  assert.equal(compareVersions("1.1.9", "1.2.0"), -1);
  assert.equal(compareVersions("2.0.0", "2.0.0-beta.1"), 1);

  const testCachePath = join(tmp, "update-check-test.json");
  saveUpdateCache(testCachePath, {
    checkedAtMs: Date.now(),
    checkedAt: new Date().toISOString(),
    repo: "fxxk-five/antigravity-live-compact",
    source: "github-release",
    latestVersion: "9.9.9",
    releaseUrl: "https://github.com/fxxk-five/antigravity-live-compact/releases/tag/v9.9.9",
    summary: "Fix PowerShell output flush and retune thresholds",
  });
  let spawned = false;
  const notice = evaluateUpdateNotice({
    cachePath: testCachePath,
    spawnRefresh: () => { spawned = true; },
  });
  assert.equal(spawned, false, "fresh update cache must not spawn background refresh");
  assert.equal(notice.showNotice, true, "higher cached version must show update notice");
  assert.ok(notice.userMarkdown.includes("v9.9.9"), "update banner should display new version");

  // 20. End-to-end SessionStart hook returns UI-only injectSteps with empty systemMessage, and respects NO_UPDATE_CHECK
  const sessRes = spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
    input: JSON.stringify({ hookEventName: "SessionStart", conversationId: "conv-sess-1" }),
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_UPDATE_CACHE: testCachePath },
  });
  assert.equal(sessRes.status, 0);
  const sessOut = JSON.parse(sessRes.stdout);
  assert.equal(sessOut.injectSteps?.[0]?.systemMessage?.systemMessage, "", "SessionStart update banner must send empty systemMessage (0 LLM tokens)");
  assert.ok(sessOut.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown?.includes("v9.9.9"), "SessionStart must populate metadata.user_markdown");

  const sessOptOut = spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
    input: JSON.stringify({ hookEventName: "SessionStart", conversationId: "conv-sess-2" }),
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_UPDATE_CACHE: testCachePath, AGY_LIVE_COMPACT_NO_UPDATE_CHECK: "1" },
  });
  assert.equal(sessOptOut.status, 0);
  assert.equal(JSON.parse(sessOptOut.stdout).injectSteps, undefined, "NO_UPDATE_CHECK=1 must suppress update banner");

  // 21. Smart command gating (default cmdMode=smart) passes routine commands through untouched, wraps high-noise commands, and respects cmdMode=off/all & extra regex
  const smartCfg = readConfig({});
  assert.equal(smartCfg.cmdMode, "smart");
  for (const routine of [
    "echo hi",
    "git status --short",
    "git diff --check",
    "Get-Content app.log -Tail 30",
    "@'\nconst note = 'npm test && pytest && docker logs';\n'@ | Set-Content probe.mjs",
    "node scripts/quick-check.mjs",
  ]) {
    assert.equal(shouldWrapCommand(routine, smartCfg), false, `routine cmd should pass through untouched: ${routine}`);
  }
  for (const noisy of [
    "npm.cmd --prefix sidecar test",
    "npm.cmd --prefix runtime run verify:layout",
    "pytest -q tests/contract",
    "docker logs legal-dsh-dev-web",
    "git grep -n compileCitedAnswer sidecar/",
    "Get-ChildItem -Recurse -File miniprogram",
    "Get-Content server.log",
    "pwsh -File runtime/scripts/dev-standalone/Start-DevStandalone.ps1 -RebuildImage",
  ]) {
    assert.equal(shouldWrapCommand(noisy, smartCfg), true, `high-noise cmd should be wrapped: ${noisy}`);
  }

  const runCmdHook = (cmdLine, extraEnv = {}) =>
    JSON.parse(
      spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
        input: JSON.stringify({
          hookEventName: "PreToolUse",
          conversationId: "conv-smart-gate",
          toolCall: { id: "c_gate", name: "run_command", args: { CommandLine: cmdLine } },
        }),
        encoding: "utf8",
        env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir, ...extraEnv },
      }).stdout,
    );

  assert.equal(runCmdHook("git status --short").overwrite, undefined, "smart mode must not wrap git status");
  assert.ok(runCmdHook("npm.cmd --prefix sidecar test").overwrite?.CommandLine?.includes("live-compact-exec.mjs"), "smart mode must wrap npm test");
  assert.equal(runCmdHook("npm.cmd --prefix sidecar test", { AGY_LIVE_COMPACT_CMD_MODE: "off" }).overwrite, undefined, "cmdMode=off must pass through even npm test");
  assert.ok(runCmdHook("echo hi", { AGY_LIVE_COMPACT_CMD_MODE: "all" }).overwrite?.CommandLine?.includes("live-compact-exec.mjs"), "cmdMode=all must wrap echo hi");
  assert.ok(
    runCmdHook("node custom_acceptance_runner.mjs", { AGY_LIVE_COMPACT_CMD_EXTRA_REGEX: "custom_acceptance_runner" }).overwrite?.CommandLine?.includes("live-compact-exec.mjs"),
    "AGY_LIVE_COMPACT_CMD_EXTRA_REGEX must opt-in custom noisy commands",
  );

  // 22. v1.4.0 fixes: StartLine=1..800 giant source compacts, dense <=250-line JSONL compacts, large .md compacts, <=32KB JSON command passes through with zero orphan shadow files, and AGENTS.md inlines MCP schemas
  const hookGiant800 = spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
    input: JSON.stringify({
      hookEventName: "PreToolUse",
      conversationId: "conv-v140",
      toolCall: { id: "c_g800", name: "read_file", args: { Path: giantSrc, StartLine: 1, EndLine: 800 } },
    }),
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir },
  });
  assert.ok(
    JSON.parse(hookGiant800.stdout).overwrite?.Path?.includes("card-raw-"),
    "StartLine=1..800 on giant >=80KB source must compact (fixes 800 < 1500 bug)",
  );

  const denseJsonl = join(workDir, "dense-transcript.jsonl");
  writeFileSync(
    denseJsonl,
    Array.from({ length: 60 }, (_, i) => JSON.stringify({ step: i + 1, type: "GENERIC", payload: "x".repeat(620) }) + "\n").join(""),
    "utf8",
  );
  const hookDenseBounded = spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
    input: JSON.stringify({
      hookEventName: "PreToolUse",
      conversationId: "conv-v140",
      toolCall: { id: "c_dense", name: "read_file", args: { Path: denseJsonl, StartLine: 1, EndLine: 60 } },
    }),
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir },
  });
  assert.ok(
    JSON.parse(hookDenseBounded.stdout).overwrite?.Path?.includes("card-raw-"),
    "60-line ~38KB dense .jsonl bounded read must compact instead of leaking 45KB",
  );

  const bigDoc = join(workDir, "architecture-archive.md");
  writeFileSync(
    bigDoc,
    Array.from({ length: 520 }, (_, i) => `## Section ${i + 1}\nDetailed specification notes for slice WI-${1000 + i} covering protocol invariants and acceptance checks.\n`).join(""),
    "utf8",
  );
  const hookBigDoc = spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
    input: JSON.stringify({
      hookEventName: "PreToolUse",
      conversationId: "conv-v140",
      toolCall: { id: "c_doc", name: "read_file", args: { Path: bigDoc } },
    }),
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir },
  });
  assert.ok(JSON.parse(hookBigDoc.stdout).overwrite?.Path?.includes("card-raw-"), "unbounded >=28KB / >=400-line .md doc must compact");

  const structuredJsonOut = JSON.stringify(
    { items: Array.from({ length: 65 }, (_, i) => ({ id: i + 1, name: `item_${i}`, status: "ACTIVE", region: "ap-east-1" })) },
    null,
    2,
  );
  assert.ok(structuredJsonOut.length > 4000 && structuredJsonOut.length < 9800, `json len=${structuredJsonOut.length}`);
  const structSpec = join(tmp, "spec-struct-json.json");
  const jsonFile = join(workDir, "medium-api.json");
  writeFileSync(jsonFile, structuredJsonOut, "utf8");
  writeFileSync(
    structSpec,
    JSON.stringify({
      cmd: process.platform === "win32" ? `Get-Content -Raw '${jsonFile.replace(/'/g, "''")}'` : `cat '${jsonFile}'`,
      convId: "conv-zero-orphan",
      callId: "call_struct_json",
      shadowRoot: shadowDir,
    }),
    "utf8",
  );
  const structRes = spawnSync(process.execPath, [join(HERE, "live-compact-exec.mjs"), structSpec], {
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir },
  });
  assert.equal(structRes.status, 0);
  assert.ok(!structRes.stdout.includes("[Live Compact · Spine Card]"), "<=9.8KB valid JSON command output must pass through verbatim");
  assert.equal(existsSync(join(shadowDir, "conv-zero-orphan")), false, "uncompacted command must leave zero orphan shadow files");

  const agentsRuleText = readFileSync(join(HERE, "..", "rules", "AGENTS.md"), "utf8");
  assert.ok(
    agentsRuleText.includes("shadow_search") && agentsRuleText.includes("shadow_read") && agentsRuleText.includes("shadow_stats"),
    "rules/AGENTS.md must inline MCP tool schemas to avoid schema-read turns",
  );

  // 23. v2.0.2: Chinese UTF-8 Markdown bounded read (<=250 lines & <=36KB) passes through raw without double-trapping
  const zhDoc = join(workDir, "current-status-zh.md");
  writeFileSync(
    zhDoc,
    Array.from(
      { length: 160 },
      (_, i) => `| WI-${String(i + 1).padStart(4, "0")} | 已完成 | 前端质量门禁与真实案件双分辨率视觉验收记录条目说明文本内容对齐校验 |\n`,
    ).join(""),
    "utf8",
  );
  const zhDocBytes = Buffer.byteLength(readFileSync(zhDoc, "utf8"), "utf8");
  assert.ok(zhDocBytes > 20000 && zhDocBytes < 36864, `zhDocBytes=${zhDocBytes}`);
  const hookZhBounded = spawnSync(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
    input: JSON.stringify({
      hookEventName: "PreToolUse",
      conversationId: "conv-v202",
      toolCall: { id: "c_zh_doc", name: "read_file", args: { Path: zhDoc, StartLine: 1, EndLine: 160 } },
    }),
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir },
  });
  assert.equal(JSON.parse(hookZhBounded.stdout).overwrite, undefined, "Chinese UTF-8 Markdown bounded read (<=250L & <=36KB) must pass through raw");

  // 24. v2.0.2: shadow_read & shadow_search enforce <=8.5KB UTF-8 inline cap with nextStartLine to avoid MCP spill
  const bigUnicodeLog = Array.from(
    { length: 120 },
    (_, i) => `条目 ${i + 1}: 详细生产排查诊断信息 needle_match payload=${"中文测试数据内容".repeat(12)}`,
  ).join("\n");
  const bigUniBackup = saveShadowBackup({
    root: tmp,
    conversationId: "conv-v202-cap",
    toolName: "run_command",
    callId: "call_uni_cap",
    sourceType: "command",
    sourceLabel: "cat unicode.log",
    exitCode: 0,
    rawText: bigUnicodeLog,
  });
  const cappedRead = readShadowLines({
    root: tmp,
    shadowId: bigUniBackup.shadowId,
    startLine: 1,
    endLine: 120,
  });
  assert.equal(cappedRead.ok, true);
  assert.equal(cappedRead.byteCapped, true, "large unicode shadow_read must byte-cap to prevent MCP spill");
  assert.ok(Buffer.byteLength(cappedRead.content, "utf8") <= 8500, "shadow_read content must stay <=8500 UTF-8 bytes");
  assert.equal(cappedRead.nextStartLine, cappedRead.endLine + 1, "shadow_read must provide exact nextStartLine cursor");

  const cappedSearch = searchShadow({
    root: tmp,
    shadowId: bigUniBackup.shadowId,
    pattern: "needle_match",
    limit: 100,
    contextLines: 1,
  });
  assert.equal(cappedSearch.found, true);
  assert.equal(cappedSearch.byteCapped, true, "large shadow_search must byte-cap to prevent MCP spill");
  assert.ok(Buffer.byteLength(JSON.stringify(cappedSearch, null, 2), "utf8") <= 9000, "shadow_search JSON must stay safely below MCP spill cap");

  // 25. v2.0.2: smart mode wraps rg, Select-String, git diff/show payloads while bypassing git diff --stat/--check and git show --stat
  for (const noisyV202 of [
    "rg -n \"TODO|FIXME\" backend/ sidecar/",
    "Select-String -Path sidecar/client/*.mjs -Pattern \"fetchLegalJson\"",
    "git diff sidecar/src/",
    "git show a9abf0b",
  ]) {
    assert.equal(shouldWrapCommand(noisyV202, smartCfg), true, `v2.0.2 smart mode should wrap: ${noisyV202}`);
  }
  for (const quietV202 of [
    "git diff --stat",
    "git diff --name-only",
    "git diff --check",
    "git show --stat a9abf0b",
  ]) {
    assert.equal(shouldWrapCommand(quietV202, smartCfg), false, `v2.0.2 smart mode should bypass short stat/check: ${quietV202}`);
  }

  // 26. v2.0.2: readShadowStats reports isFallbackSession accurately
  const exactStats = readShadowStats({ root: tmp, conversationId: "conv-exec-1" });
  assert.equal(exactStats.sessionStats.cuts, 1);
  assert.equal(exactStats.isFallbackSession, false, "matching session must report isFallbackSession=false");
  const fallbackStats = readShadowStats({ root: tmp, conversationId: "conv-brand-new-empty" });
  assert.equal(fallbackStats.isFallbackSession, true, "missing session falling back to latest must report isFallbackSession=true");
  assert.equal(fallbackStats.requestedConversationId, "conv-brand-new-empty");
  assert.ok(exactStats.updateStatus && typeof exactStats.updateStatus.currentVersion === "string");

  // 27. v2.0.2: hook-dispatch resolves complete JSON stdin immediately even if host keeps stdin open without EOF
  await new Promise((resolveDone, rejectDone) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [join(HERE, "hook-dispatch.mjs")], {
      env: { ...process.env, AGY_LIVE_COMPACT_UPDATE_CACHE: testCachePath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    const guard = setTimeout(() => {
      try { child.kill(); } catch {}
      rejectDone(new Error("hook-dispatch stalled waiting for stdin EOF"));
    }, 3000);
    child.on("close", (code) => {
      clearTimeout(guard);
      try {
        assert.equal(code, 0);
        const parsed = JSON.parse(out);
        assert.ok(parsed.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown?.includes("v9.9.9"));
        assert.ok(Date.now() - startedAt < 2000, "hook-dispatch should exit well before idle timeout when JSON is complete");
        resolveDone();
      } catch (err) {
        rejectDone(err);
      }
    });
    // Intentionally write JSON WITHOUT calling child.stdin.end()
    child.stdin.write(JSON.stringify({ hookEventName: "SessionStart", conversationId: "conv-open-stdin" }));
  });

  // 28. v2.1.0: relay-session.mjs --self-test passes end-to-end and rules/AGENTS.md encodes subagent GC + baton relay
  const relaySelfTest = spawnSync(process.execPath, [join(HERE, "relay-session.mjs"), "--self-test"], {
    encoding: "utf8",
  });
  assert.equal(relaySelfTest.status, 0, `relay-session --self-test failed: ${relaySelfTest.stderr}`);
  const relayOut = JSON.parse(relaySelfTest.stdout);
  assert.equal(relayOut.ok, true);
  assert.equal(relayOut.selfTest, "PASSED");
  assert.ok(
    agentsRuleText.includes("invoke_subagent") &&
      agentsRuleText.includes("relay-session.mjs") &&
      agentsRuleText.includes("CreateConversation"),
    "rules/AGENTS.md must include subagent GC redlines and baton-relay instructions",
  );

  assert.ok(estimateTokens("中文测试 hello world") > 0);
  assert.equal(isToolFailure("ok", false, 0), false);
  assert.equal(isToolFailure("ok", false, 1), true);

  console.log("ALL 28 LIVE-COMPACT GATE TESTS PASSED!");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
