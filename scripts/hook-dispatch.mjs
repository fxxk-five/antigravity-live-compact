#!/usr/bin/env node
/**
 * Unified lifecycle hook dispatcher for Antigravity Live Compact.
 * Handles:
 *  - PreToolUse (run_command): wraps command via deterministic live-compact-exec.mjs
 *  - PreToolUse (read_file): compacts unbounded large logs/files into Spine Cards with shadow backup
 *  - PreInvocation: monitors real token watermark from transcript_full.jsonl without breaking prefix cache
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpineCard, readConfig } from "./plan.mjs";
import { recordCutStats, saveShadowBackup, sessionShadowDir, shadowRootDir } from "./shadow.mjs";
import { evaluateUpdateNotice } from "./update-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXEC_SCRIPT = join(HERE, "live-compact-exec.mjs");

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar", ".wasm", ".exe", ".dll",
  ".so", ".dylib", ".mp3", ".wav", ".mp4", ".mov", ".avi", ".mkv", ".woff", ".woff2", ".ttf",
]);

const CODE_EXTS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".java",
  ".kt", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php",
  ".css", ".scss", ".sass", ".less", ".styl", ".pcss",
  ".html", ".htm", ".vue", ".svelte", ".astro", ".pug", ".ejs", ".hbs",
  ".wxml", ".wxss", ".wxs", ".ux", ".swan", ".ttml", ".ttss", ".axml", ".acss",
  ".md", ".mdx", ".yaml", ".yml", ".toml", ".ini", ".xml", ".plist",
  ".sql", ".graphql", ".gql", ".proto", ".tf", ".tfvars", ".hcl",
  ".gradle", ".cmake", ".dart", ".lua", ".scala", ".ex", ".exs", ".zig",
  ".ps1", ".sh", ".bash", ".zsh", ".bat", ".cmd",
]);

const STALE_CMD_SPEC_MS = 10 * 60 * 1000;

function sweepStaleCmdSpecs(dir, nowMs = Date.now()) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(".cmd-") || !entry.name.endsWith(".json")) continue;
      const full = join(dir, entry.name);
      try {
        if (nowMs - statSync(full).mtimeMs > STALE_CMD_SPEC_MS) unlinkSync(full);
      } catch {}
    }
  } catch {}
}

function readStdin() {
  return new Promise((resolvePromise) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolvePromise(""));
  });
}

function handleRunCommand(payload, config) {
  const args = payload?.toolCall?.args || {};
  const cmd = typeof args.CommandLine === "string" ? args.CommandLine : "";
  if (!cmd.trim()) return { decision: "allow" };
  if (args.IsDaemon === true) return { decision: "allow" };
  // Never double-wrap our own runner.
  if (cmd.includes("live-compact-exec.mjs")) return { decision: "allow" };

  const root = shadowRootDir();
  const convId = payload.conversationId || "default";
  const callId = payload?.toolCall?.id || `call_${randomBytes(6).toString("hex")}`;
  const dir = sessionShadowDir(root, convId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweepStaleCmdSpecs(dir);

  const safeCall = callId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  const specPath = join(dir, `.cmd-${safeCall}-${randomBytes(4).toString("hex")}.json`);
  writeFileSync(
    specPath,
    JSON.stringify({
      cmd,
      convId,
      callId,
      shadowRoot: root,
      createdAt: Date.now(),
    }),
    "utf8",
  );

  return {
    decision: "allow",
    overwrite: {
      CommandLine: `node "${EXEC_SCRIPT}" "${specPath}"`,
    },
  };
}

function handleReadFile(payload, config) {
  const args = payload?.toolCall?.args || {};
  const rawPath = typeof args.Path === "string" ? args.Path : "";
  if (!rawPath) return { decision: "allow" };

  const absPath = resolve(rawPath);
  const root = shadowRootDir();
  // Never intercept our own shadow/card files.
  const absLower = absPath.toLowerCase();
  const rootLower = resolve(root).toLowerCase();
  if (absLower === rootLower || absLower.startsWith(rootLower + sep)) {
    return { decision: "allow" };
  }

  // Respect explicit byte pagination or narrow line-range surgical reads (e.g. for editing or recall).
  if (Number(args.ByteOffset) > 0) return { decision: "allow" };
  const hasStart = Number.isInteger(args.StartLine) && args.StartLine >= 1;
  const hasEnd = Number.isInteger(args.EndLine) && args.EndLine >= 1;
  if (hasStart && hasEnd && (args.EndLine - args.StartLine + 1) <= config.maxBoundedReadLines) {
    return { decision: "allow" };
  }

  const ext = extname(absPath).toLowerCase();
  if (BINARY_EXTS.has(ext)) return { decision: "allow" };
  if (!existsSync(absPath)) return { decision: "allow" };

  let st;
  try {
    st = statSync(absPath);
  } catch {
    return { decision: "allow" };
  }
  if (!st.isFile()) return { decision: "allow" };

  const isCode = CODE_EXTS.has(ext);
  const isJson = ext === ".json";
  const minBytes = isCode ? config.codeMinBytes : isJson ? config.jsonMinBytes : config.logMinBytes;
  const minLines = isCode ? config.codeMinLines : isJson ? config.jsonMinLines : config.logMinLines;
  // Cap huge files at 16MB for synchronous hook read safety.
  if (st.size < minBytes || st.size > 16 * 1024 * 1024) {
    return { decision: "allow" };
  }

  let content;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    return { decision: "allow" };
  }
  // Skip binary files mislabeled with text extensions.
  if (content.includes("\u0000")) return { decision: "allow" };

  const allLines = content.replace(/\r\n/g, "\n").split("\n");
  if (allLines.length < minLines) return { decision: "allow" };

  // If caller asked for a large explicit range (e.g. StartLine=1, EndLine=800), slice to that range.
  let targetText = content;
  if (hasStart || hasEnd) {
    const s = hasStart ? Math.max(1, args.StartLine) : 1;
    const e = hasEnd ? Math.min(allLines.length, args.EndLine) : allLines.length;
    if (e - s + 1 < minLines) return { decision: "allow" };
    targetText = allLines.slice(s - 1, e).join("\n");
  }

  const convId = payload.conversationId || "default";
  const callId = payload?.toolCall?.id || `read_${randomBytes(6).toString("hex")}`;

  const backup = saveShadowBackup({
    root,
    conversationId: convId,
    toolName: "read_file",
    callId,
    sourceType: "file",
    sourceLabel: absPath,
    originalPath: absPath,
    exitCode: 0,
    rawText: targetText,
    maxBytes: config.shadowMaxBytes,
  });
  if (!backup.ok) return { decision: "allow" };

  const built = buildSpineCard({
    text: targetText,
    sourceType: "file",
    sourceLabel: absPath,
    originalPath: absPath,
    exitCode: 0,
    isError: false,
    shadowId: backup.shadowId,
    conversationId: convId,
    sha256: backup.sha256,
    bytes: backup.bytes,
    config,
  });
  if (!built.compacted) return { decision: "allow" };

  const cardPath = join(backup.dir, `card-${backup.shadowId}.txt`);
  writeFileSync(cardPath, `${built.card}\n`, "utf8");

  recordCutStats({
    root,
    conversationId: convId,
    entry: {
      toolName: "read_file",
      shadowId: backup.shadowId,
      sourceLabel: absPath,
      failed: false,
      rawBytes: backup.bytes,
      cardBytes: Buffer.byteLength(built.card, "utf8"),
      rawLines: built.rawLines,
      retainedLines: built.retainedLines,
      rawTokensEst: built.rawTokens,
      cardTokensEst: built.cardTokens,
      savedTokensEst: built.savedTokens,
      durationMs: 0,
    },
  });

  return {
    decision: "allow",
    overwrite: {
      Path: cardPath,
      StartLine: 1,
      EndLine: 800,
    },
  };
}

function handlePreInvocation(payload, config) {
  const transcriptPath = payload?.transcriptPath;
  const convId = payload?.conversationId || "default";
  if (!transcriptPath || !existsSync(transcriptPath)) return {};

  const root = shadowRootDir();
  const dir = sessionShadowDir(root, convId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const statePath = join(dir, "watermark.json");

  let prev = {
    warnedTiers: [],
    lastByteOffset: 0,
    plannerSteps: 0,
    peakContext: 0,
    totalInput: 0,
    totalCacheRead: 0,
    latest: null,
  };
  if (existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8"));
      prev = { ...prev, ...parsed, warnedTiers: Array.isArray(parsed?.warnedTiers) ? parsed.warnedTiers : [] };
    } catch {}
  }

  let fileSize = 0;
  try {
    fileSize = statSync(transcriptPath).size;
  } catch {
    return {};
  }

  // Incremental byte-offset scan: only read newly appended complete lines so
  // multi-megabyte transcripts never slow down PreInvocation.
  let startOffset = Number.isInteger(prev.lastByteOffset) && prev.lastByteOffset >= 0 ? prev.lastByteOffset : 0;
  let plannerSteps = Number(prev.plannerSteps) || 0;
  let peakContext = Number(prev.peakContext) || 0;
  let totalInput = Number(prev.totalInput) || 0;
  let totalCacheRead = Number(prev.totalCacheRead) || 0;
  let latest = prev.latest || null;

  if (fileSize < startOffset || prev.scanVersion !== 2) {
    // File was truncated/rotated or state predates incremental scan -> clean rescan.
    startOffset = 0;
    plannerSteps = 0;
    peakContext = 0;
    totalInput = 0;
    totalCacheRead = 0;
    latest = null;
  }

  let nextOffset = startOffset;
  if (fileSize > startOffset) {
    const deltaLen = fileSize - startOffset;
    let chunkBuf = null;
    let fd;
    try {
      fd = openSync(transcriptPath, "r");
      chunkBuf = Buffer.allocUnsafe(deltaLen);
      let readTotal = 0;
      while (readTotal < deltaLen) {
        const n = readSync(fd, chunkBuf, readTotal, deltaLen - readTotal, startOffset + readTotal);
        if (n <= 0) break;
        readTotal += n;
      }
      chunkBuf = chunkBuf.subarray(0, readTotal);
    } catch {
      return {};
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
    }

    const lastNl = chunkBuf.lastIndexOf(0x0a); // '\n'
    let completeBuf = chunkBuf;
    if (lastNl >= 0) {
      completeBuf = chunkBuf.subarray(0, lastNl + 1);
      nextOffset = startOffset + lastNl + 1;
    } else {
      const single = chunkBuf.toString("utf8").trim();
      if (single) {
        try {
          JSON.parse(single);
          nextOffset = startOffset + chunkBuf.length;
        } catch {
          completeBuf = Buffer.alloc(0);
          nextOffset = startOffset;
        }
      } else {
        completeBuf = Buffer.alloc(0);
        nextOffset = startOffset + chunkBuf.length;
      }
    }

    if (completeBuf.length > 0) {
      const text = completeBuf.toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec?.type !== "PLANNER_RESPONSE") continue;
        const inp = Number(rec.input_tokens) || 0;
        const cache = Number(rec.cache_read_tokens) || 0;
        const ctx = inp + cache;
        plannerSteps += 1;
        totalInput += inp;
        totalCacheRead += cache;
        if (ctx > peakContext) peakContext = ctx;
        latest = {
          stepIndex: rec.step_index,
          inputTokens: inp,
          cacheReadTokens: cache,
          contextTokens: ctx,
          model: rec.model || payload.modelName || "",
        };
      }
    }
  }

  if (!latest) return {};

  const totalPrompt = totalInput + totalCacheRead;
  const cacheHitRate = totalPrompt > 0 ? Number((totalCacheRead / totalPrompt).toFixed(4)) : 0;

  const tiers = [config.watermarkTokens, Math.round(config.watermarkTokens * 1.7)];
  let advisory = null;
  for (const tier of tiers) {
    if (latest.contextTokens >= tier && !prev.warnedTiers.includes(tier)) {
      prev.warnedTiers.push(tier);
      advisory = `[Live Compact · Watermark Advisory] Context reached ~${latest.contextTokens.toLocaleString()} tokens (peak ${peakContext.toLocaleString()}, cache hit ${(cacheHitRate * 100).toFixed(1)}%). Keep reads bounded (StartLine/EndLine) or run /compact after the current milestone.`;
      break;
    }
  }

  try {
    writeFileSync(
      statePath,
      JSON.stringify(
        {
          scanVersion: 2,
          conversationId: convId,
          updatedAt: new Date().toISOString(),
          lastByteOffset: nextOffset,
          plannerSteps,
          latest,
          peakContext,
          totalInput,
          totalCacheRead,
          cacheHitRate,
          warnedTiers: prev.warnedTiers,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {}

  if (!advisory) return {};

  // Inject at most once per watermark tier so KV prefix cache is never disturbed on normal turns.
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: advisory,
          metadata: { source: "live-compact-watermark" },
        },
      },
    ],
  };
}

function handleSessionStart(_payload, _config) {
  const notice = evaluateUpdateNotice();
  if (!notice.showNotice || !notice.userMarkdown) return {};
  // Inject a UI-only inline markdown tip (systemMessage="" sends zero tokens to the model).
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: "",
          metadata: {
            source: "live-compact-update",
            user_markdown: notice.userMarkdown,
          },
        },
      },
    ],
  };
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    process.stdout.write("{}");
    return;
  }

  const config = readConfig();
  const event = payload.hookEventName || "";

  if (config.disabled) {
    process.stdout.write(event === "PreToolUse" ? '{"decision":"allow"}' : "{}");
    return;
  }

  try {
    if (event === "SessionStart") {
      process.stdout.write(JSON.stringify(handleSessionStart(payload, config)));
      return;
    }

    if (event === "PreToolUse") {
      const name = payload?.toolCall?.name || "";
      if (name === "run_command") {
        process.stdout.write(JSON.stringify(handleRunCommand(payload, config)));
        return;
      }
      if (name === "read_file") {
        process.stdout.write(JSON.stringify(handleReadFile(payload, config)));
        return;
      }
      process.stdout.write('{"decision":"allow"}');
      return;
    }

    if (event === "PreInvocation") {
      process.stdout.write(JSON.stringify(handlePreInvocation(payload, config)));
      return;
    }

    process.stdout.write("{}");
  } catch {
    // Fail-open on hook internal error so agent execution is never blocked.
    process.stdout.write(event === "PreToolUse" ? '{"decision":"allow"}' : "{}");
  }
}

main();
