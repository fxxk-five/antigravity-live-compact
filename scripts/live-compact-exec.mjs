#!/usr/bin/env node
/**
 * Deterministic in-flight command runner for Antigravity Live Compact.
 * Executed transparently via PreToolUse overwrite on `run_command`.
 *
 * Guarantees:
 * - Preserves cwd, environment, UTF-8 encoding, and exact exit code.
 * - Small outputs pass through 100% verbatim.
 * - Large outputs are backed up to shadow storage FIRST (fail-closed: on backup
 *   failure, raw output is emitted untouched), then compacted into a Spine Card.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { buildSpineCard, readConfig } from "./plan.mjs";
import { recordCutStats, saveShadowBackup, shadowRootDir } from "./shadow.mjs";

const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

function runOriginalCommand(commandLine) {
  return new Promise((resolvePromise) => {
    let child;
    let tempPs1 = "";
    if (process.platform === "win32") {
      // Run via temporary UTF-8 BOM .ps1 file to avoid CLIXML stderr wrappers,
      // preserve exact quoting & UTF-8 characters, and avoid 8KB CLI limits.
      const psScript = [
        "$ProgressPreference = 'SilentlyContinue'",
        "try { $OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $OutputEncoding; [Console]::InputEncoding = $OutputEncoding } catch {}",
        "$global:LASTEXITCODE = 0",
        "& {",
        commandLine,
        "}",
        "$__lc_ok = $?",
        "if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
        "if (-not $__lc_ok) { exit 1 }",
        "exit 0",
      ].join("\r\n");
      tempPs1 = join(tmpdir(), `agy-lc-${process.pid}-${randomBytes(6).toString("hex")}.ps1`);
      writeFileSync(tempPs1, `\uFEFF${psScript}`, "utf8");
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tempPs1], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } else {
      child = spawn("/bin/sh", ["-c", commandLine], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }

    const cleanupTemp = () => {
      if (tempPs1) {
        try { unlinkSync(tempPs1); } catch {}
        tempPs1 = "";
      }
    };

    const outChunks = [];
    const errChunks = [];
    const combinedChunks = [];
    let totalBytes = 0;
    let truncatedCapture = false;

    const pushChunk = (buf, target) => {
      if (totalBytes < MAX_CAPTURE_BYTES) {
        const allow = Math.min(buf.length, MAX_CAPTURE_BYTES - totalBytes);
        const slice = allow === buf.length ? buf : buf.subarray(0, allow);
        target.push(slice);
        combinedChunks.push(slice);
        totalBytes += slice.length;
        if (allow < buf.length) truncatedCapture = true;
      } else {
        truncatedCapture = true;
      }
    };

    let settled = false;
    let exited = false;
    let exitCodeVal = 0;
    let exitSignalVal = null;
    let drainTimer = null;
    let hardDrainTimer = null;

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (drainTimer) clearTimeout(drainTimer);
      if (hardDrainTimer) clearTimeout(hardDrainTimer);
      cleanupTemp();
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
      const stdout = Buffer.concat(outChunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      let combined = Buffer.concat(combinedChunks).toString("utf8");
      if (truncatedCapture) {
        combined += `\n[live-compact: output exceeded ${MAX_CAPTURE_BYTES} bytes capture cap]`;
      }
      resolvePromise({
        exitCode: typeof code === "number" ? code : signal ? 128 : 1,
        stdout,
        stderr,
        combined,
        truncatedCapture,
      });
    };

    const schedulePostExitDrain = () => {
      if (!exited || settled) return;
      if (drainTimer) clearTimeout(drainTimer);
      drainTimer = setTimeout(() => finish(exitCodeVal, exitSignalVal), 150);
    };

    child.stdout.on("data", (chunk) => {
      pushChunk(chunk, outChunks);
      schedulePostExitDrain();
    });
    child.stderr.on("data", (chunk) => {
      pushChunk(chunk, errChunks);
      schedulePostExitDrain();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (drainTimer) clearTimeout(drainTimer);
      if (hardDrainTimer) clearTimeout(hardDrainTimer);
      cleanupTemp();
      resolvePromise({
        exitCode: 1,
        stdout: "",
        stderr: `live-compact-exec spawn error: ${err.message}\n`,
        combined: `live-compact-exec spawn error: ${err.message}\n`,
        truncatedCapture: false,
      });
    });

    // When the shell exits on Windows after spawning a detached child via
    // Start-Process (which inherits stdio pipe handles), `close` would hang
    // until the detached child terminates. Drain buffered output briefly after
    // `exit` and finish without blocking on grandchildren.
    child.on("exit", (code, signal) => {
      exited = true;
      exitCodeVal = code;
      exitSignalVal = signal;
      schedulePostExitDrain();
      hardDrainTimer = setTimeout(() => finish(exitCodeVal, exitSignalVal), 600);
    });

    child.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}

async function main() {
  const specPath = process.argv[2];
  if (!specPath) {
    process.stderr.write("live-compact-exec: missing spec path\n");
    process.exit(2);
  }

  let spec;
  try {
    spec = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (error) {
    process.stderr.write(`live-compact-exec: failed to read spec: ${error.message}\n`);
    process.exit(2);
  } finally {
    try { unlinkSync(specPath); } catch {}
  }

  const config = readConfig();
  const started = performance.now();
  const result = await runOriginalCommand(String(spec.cmd || ""));
  const root = spec.shadowRoot || shadowRootDir();
  const convId = spec.convId || "default";
  const callId = spec.callId || "";

  const emitVerbatim = () => {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  };

  if (config.disabled) {
    emitVerbatim();
    return;
  }

  // Build combined representation preserving stderr boundary tag if stderr present.
  let rawText = result.stdout;
  if (result.stderr) {
    rawText = rawText
      ? `${rawText.replace(/\n+$/, "")}\n[stderr]\n${result.stderr}`
      : `[stderr]\n${result.stderr}`;
  }

  // Fast pre-check before touching disk: skip small outputs completely.
  const lineCount = rawText ? rawText.replace(/\r\n/g, "\n").split("\n").length : 0;
  if (rawText.length <= config.smallChars && lineCount <= config.smallLines) {
    emitVerbatim();
    return;
  }

  // Fail-closed: persist full shadow backup BEFORE attempting compaction.
  const backup = saveShadowBackup({
    root,
    conversationId: convId,
    toolName: "run_command",
    callId,
    sourceType: "command",
    sourceLabel: spec.cmd || "",
    exitCode: result.exitCode,
    rawText,
    maxBytes: config.shadowMaxBytes,
  });

  if (!backup.ok) {
    // Fail-closed: never discard data when backup fails.
    emitVerbatim();
    return;
  }

  const built = buildSpineCard({
    text: rawText,
    sourceType: "command",
    sourceLabel: spec.cmd || "",
    exitCode: result.exitCode,
    isError: result.exitCode !== 0,
    shadowId: backup.shadowId,
    conversationId: convId,
    sha256: backup.sha256,
    bytes: backup.bytes,
    config,
  });

  if (!built.compacted) {
    emitVerbatim();
    return;
  }

  recordCutStats({
    root,
    conversationId: convId,
    entry: {
      toolName: "run_command",
      shadowId: backup.shadowId,
      sourceLabel: String(spec.cmd || "").slice(0, 160),
      exitCode: result.exitCode,
      failed: built.failed,
      rawBytes: backup.bytes,
      cardBytes: Buffer.byteLength(built.card, "utf8"),
      rawLines: built.rawLines,
      retainedLines: built.retainedLines,
      rawTokensEst: built.rawTokens,
      cardTokensEst: built.cardTokens,
      savedTokensEst: built.savedTokens,
      durationMs: Math.round(performance.now() - started),
    },
  });

  process.stdout.write(`${built.card}\n`);
  process.exit(result.exitCode);
}

main().catch((error) => {
  process.stderr.write(`live-compact-exec fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
