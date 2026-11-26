#!/usr/bin/env node
/**
 * Unit & integration gate for Antigravity Live Compact.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpineCard, estimateTokens, isToolFailure, readConfig } from "./plan.mjs";
import { readShadowLines, readShadowStats, saveShadowBackup, searchShadow } from "./shadow.mjs";

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

  // 14. Stale .cmd-*.json (>10min old) is swept on next PreToolUse run_command
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
      toolCall: { id: "c_new", name: "run_command", args: { CommandLine: "echo hi" } },
    }),
    encoding: "utf8",
    env: { ...process.env, AGY_LIVE_COMPACT_SHADOW_DIR: shadowDir },
  });
  assert.equal(hookRun.status, 0);
  assert.equal(existsSync(staleSpec), false, "stale .cmd spec (>10m) should be auto-swept");

  const stats = readShadowStats({ root: tmp, conversationId: "conv-exec-1" });
  assert.equal(stats.sessionStats.cuts, 1);
  assert.ok(estimateTokens("中文测试 hello world") > 0);
  assert.equal(isToolFailure("ok", false, 0), false);
  assert.equal(isToolFailure("ok", false, 1), true);

  console.log("ALL 14 LIVE-COMPACT GATE TESTS PASSED!");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
