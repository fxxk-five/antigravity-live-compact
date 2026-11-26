/**
 * Atomic, fail-closed shadow backup storage, rotation, stats, and search
 * for Antigravity Live Compact.
 * Adapted from Tranquillitatis-Lab/dsh-live-compact (raw.js, shadow.js, shadow-search.js).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getCachedUpdateStatus } from "./update-check.mjs";

const STATS_FILE = "spine-stats.json";
const CUTS_FILE = "spine-cuts.jsonl";
const SESSION_STATS_FILE = "session-stats.json";
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const SHADOW_TXT_RE = /^raw-[0-9a-f]{16}\.txt$/;

export function shadowRootDir(env = process.env) {
  if (env.AGY_LIVE_COMPACT_SHADOW_DIR && env.AGY_LIVE_COMPACT_SHADOW_DIR.trim()) {
    return resolve(env.AGY_LIVE_COMPACT_SHADOW_DIR.trim());
  }
  return join(homedir(), ".gemini", "antigravity", "live-compact", "shadow");
}

export function sanitizeKey(key) {
  const safe = String(key || "default").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return safe || "default";
}

export function sessionShadowDir(root, conversationId) {
  return join(resolve(root), sanitizeKey(conversationId));
}

export function sha256Hex(content) {
  const hash = createHash("sha256");
  hash.update(typeof content === "string" ? Buffer.from(content, "utf8") : content);
  return hash.digest("hex");
}

export function makeShadowId(callId, contentSha256) {
  const digest = sha256Hex(`${callId || randomBytes(8).toString("hex")}:${contentSha256}`);
  return `raw-${digest.slice(0, 16)}`;
}

export function planShadowIdentity(callId, rawText = "") {
  const body = String(rawText ?? "");
  const buf = Buffer.from(body, "utf8");
  const sha256 = sha256Hex(buf);
  const shadowId = makeShadowId(callId, sha256);
  return { body, buf, bytes: buf.length, sha256, shadowId };
}

function atomicWrite(targetPath, data) {
  const tmpPath = `${targetPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd;
  try {
    fd = openSync(tmpPath, "wx", 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, targetPath);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(tmpPath); } catch {}
    throw error;
  }
}

function rotateIfNeeded(root, protectPath, maxBytes = DEFAULT_MAX_BYTES) {
  try {
    if (!existsSync(root)) return;
    const files = [];
    let totalBytes = 0;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      for (const file of readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile() || !SHADOW_TXT_RE.test(file.name)) continue;
        const full = join(dir, file.name);
        try {
          const st = statSync(full);
          totalBytes += st.size;
          files.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
        } catch {}
      }
    }
    if (totalBytes <= maxBytes) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const item of files) {
      if (totalBytes <= maxBytes * 0.85) break;
      if (item.path === protectPath) continue;
      try {
        unlinkSync(item.path);
        totalBytes -= item.size;
      } catch {}
      try { unlinkSync(`${item.path}.meta.json`); } catch {}
      const id = basename(item.path, ".txt");
      try { unlinkSync(join(resolve(item.path, ".."), `card-${id}.txt`)); } catch {}
    }
  } catch {}
}

/**
 * Persist full raw output atomically before any compaction card is emitted.
 * Fail-closed: returns `{ ok: false, error }` if writing or verification fails.
 */
export function saveShadowBackup({
  root = shadowRootDir(),
  conversationId = "default",
  toolName = "run_command",
  callId = "",
  sourceType = "command",
  sourceLabel = "",
  exitCode = 0,
  rawText = "",
  originalPath = "",
  maxBytes = DEFAULT_MAX_BYTES,
  identity = null,
}) {
  try {
    const dir = sessionShadowDir(root, conversationId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const planned = identity && identity.buf && identity.sha256 && identity.shadowId
      ? identity
      : planShadowIdentity(callId, rawText);
    const { body, buf, sha256, shadowId } = planned;
    const filePath = join(dir, `${shadowId}.txt`);
    const metaPath = `${filePath}.meta.json`;
    const normalizedLines = body.replace(/\r\n/g, "\n").split("\n");
    if (normalizedLines.length > 1 && normalizedLines[normalizedLines.length - 1] === "") {
      normalizedLines.pop();
    }

    if (!existsSync(filePath)) {
      atomicWrite(filePath, buf);
    }

    const meta = {
      v: 1,
      shadowId,
      conversationId: sanitizeKey(conversationId),
      toolName,
      callId: callId || "",
      sourceType,
      sourceLabel: String(sourceLabel || "").slice(0, 300),
      originalPath: originalPath || "",
      exitCode: exitCode ?? null,
      bytes: buf.length,
      lines: normalizedLines.length,
      sha256,
      createdAt: new Date().toISOString(),
    };
    atomicWrite(metaPath, JSON.stringify(meta, null, 2));

    // Read-back verification (fail-closed)
    const verify = statSync(filePath);
    if (verify.size !== buf.length) {
      return { ok: false, error: "shadow size verification mismatch" };
    }

    rotateIfNeeded(root, filePath, maxBytes);

    return {
      ok: true,
      shadowId,
      dir,
      filePath,
      metaPath,
      sha256,
      bytes: buf.length,
      lines: normalizedLines.length,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function recordCutStats({ root = shadowRootDir(), conversationId = "default", entry }) {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const dir = sessionShadowDir(root, conversationId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const record = {
      v: 1,
      ts: new Date().toISOString(),
      conversationId: sanitizeKey(conversationId),
      ...entry,
    };
    appendFileSync(join(root, CUTS_FILE), `${JSON.stringify(record)}\n`, "utf8");

    const bump = (filePath) => {
      let stats = {
        cuts: 0,
        rawBytes: 0,
        cardBytes: 0,
        rawTokensEst: 0,
        cardTokensEst: 0,
        savedTokensEst: 0,
        updatedAt: "",
      };
      if (existsSync(filePath)) {
        try {
          stats = { ...stats, ...JSON.parse(readFileSync(filePath, "utf8")) };
        } catch {}
      }
      stats.cuts += 1;
      stats.rawBytes += Number(entry.rawBytes) || 0;
      stats.cardBytes += Number(entry.cardBytes) || 0;
      stats.rawTokensEst += Number(entry.rawTokensEst) || 0;
      stats.cardTokensEst += Number(entry.cardTokensEst) || 0;
      stats.savedTokensEst += Number(entry.savedTokensEst) || 0;
      stats.updatedAt = record.ts;
      atomicWrite(filePath, JSON.stringify(stats, null, 2));
    };

    bump(join(root, STATS_FILE));
    bump(join(dir, SESSION_STATS_FILE));
  } catch {}
}

function listSessionFiles(dir) {
  if (!existsSync(dir)) return [];
  const items = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !SHADOW_TXT_RE.test(entry.name)) continue;
    const filePath = join(dir, entry.name);
    const shadowId = basename(entry.name, ".txt");
    let meta = {};
    try {
      meta = JSON.parse(readFileSync(`${filePath}.meta.json`, "utf8"));
    } catch {}
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = statSync(filePath);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {}
    items.push({ shadowId, filePath, meta, size, mtimeMs });
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items;
}

export function locateShadowFile({ root = shadowRootDir(), conversationId = "", shadowId = "" }) {
  const cleanId = String(shadowId || "").replace(/\.txt$/i, "").trim();
  if (!/^raw-[0-9a-f]{16}$/.test(cleanId)) return null;

  if (conversationId) {
    const candidate = join(sessionShadowDir(root, conversationId), `${cleanId}.txt`);
    if (existsSync(candidate)) {
      let meta = {};
      try { meta = JSON.parse(readFileSync(`${candidate}.meta.json`, "utf8")); } catch {}
      return { shadowId: cleanId, filePath: candidate, meta };
    }
  }

  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, `${cleanId}.txt`);
    if (existsSync(candidate)) {
      let meta = {};
      try { meta = JSON.parse(readFileSync(`${candidate}.meta.json`, "utf8")); } catch {}
      return { shadowId: cleanId, filePath: candidate, meta };
    }
  }
  return null;
}

function findLatestSessionDir(root) {
  if (!existsSync(root)) return null;
  let best = null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(root, entry.name);
    try {
      const st = statSync(full);
      if (!best || st.mtimeMs > best.mtimeMs) {
        best = { dir: full, conversationId: entry.name, mtimeMs: st.mtimeMs };
      }
    } catch {}
  }
  return best;
}

export function searchShadow({
  root = shadowRootDir(),
  conversationId = "",
  shadowId = "",
  pattern = "",
  regex = false,
  ignoreCase = true,
  contextLines = 1,
  limit = 30,
  maxFileBytes = 8 * 1024 * 1024,
}) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new TypeError("searchShadow: pattern is required");
  }
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 30)));
  const safeCtx = Math.min(5, Math.max(0, Math.floor(Number(contextLines) || 0)));
  const matcher = regex ? new RegExp(pattern, ignoreCase ? "i" : "") : null;
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;

  let targets = [];
  if (shadowId) {
    const found = locateShadowFile({ root, conversationId, shadowId });
    if (!found) {
      return { found: false, error: `shadowId not found: ${shadowId}`, matches: [] };
    }
    let size = 0;
    try { size = statSync(found.filePath).size; } catch {}
    targets = [{ ...found, size }];
  } else if (conversationId) {
    targets = listSessionFiles(sessionShadowDir(root, conversationId));
  } else {
    const latest = findLatestSessionDir(root);
    targets = latest ? listSessionFiles(latest.dir) : [];
  }

  const matches = [];
  let scanned = 0;
  let skipped = 0;
  let truncated = false;

  for (const target of targets) {
    if (target.size > maxFileBytes) {
      skipped += 1;
      continue;
    }
    let text;
    try {
      text = readFileSync(target.filePath, "utf8");
    } catch {
      skipped += 1;
      continue;
    }
    scanned += 1;
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const hit = matcher
        ? matcher.test(line)
        : (ignoreCase ? line.toLowerCase().includes(needle) : line.includes(needle));
      if (!hit) continue;

      const clip = (s) => (s.length > 360 ? `${s.slice(0, 360)}…` : s);
      const item = {
        shadowId: target.shadowId,
        sourceLabel: target.meta?.sourceLabel || "",
        line: i + 1,
        text: clip(line),
      };
      if (safeCtx > 0) {
        item.contextBefore = lines
          .slice(Math.max(0, i - safeCtx), i)
          .map((t, idx) => `L${Math.max(1, i - safeCtx + 1) + idx}: ${clip(t)}`);
        item.contextAfter = lines
          .slice(i + 1, Math.min(lines.length, i + 1 + safeCtx))
          .map((t, idx) => `L${i + 2 + idx}: ${clip(t)}`);
      }
      matches.push(item);
      if (matches.length >= safeLimit) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  return {
    found: true,
    scanned,
    skipped,
    truncated,
    totalMatches: matches.length,
    matches,
  };
}

export function readShadowLines({
  root = shadowRootDir(),
  conversationId = "",
  shadowId = "",
  startLine = 1,
  endLine = 80,
}) {
  const found = locateShadowFile({ root, conversationId, shadowId });
  if (!found) {
    return { ok: false, error: `shadowId not found: ${shadowId}` };
  }
  const text = readFileSync(found.filePath, "utf8").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  const totalLines = lines.length;
  const start = Math.max(1, Math.min(totalLines || 1, Math.floor(Number(startLine) || 1)));
  const requestedEnd = Math.max(start, Math.floor(Number(endLine) || start + 79));
  const cappedEnd = Math.min(totalLines, start + 149, requestedEnd);

  const slice = [];
  for (let ln = start; ln <= cappedEnd; ln += 1) {
    const raw = lines[ln - 1] ?? "";
    slice.push(`L${ln}: ${raw.length > 500 ? `${raw.slice(0, 500)}…` : raw}`);
  }

  return {
    ok: true,
    shadowId: found.shadowId,
    sourceLabel: found.meta?.sourceLabel || "",
    originalPath: found.meta?.originalPath || "",
    startLine: start,
    endLine: cappedEnd,
    totalLines,
    hasMore: cappedEnd < totalLines,
    content: slice.join("\n"),
  };
}

export function computeWatermarkFromTranscript(transcriptPath, conversationId = "") {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  let text;
  try {
    text = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  let plannerSteps = 0;
  let peakContext = 0;
  let totalInput = 0;
  let totalCacheRead = 0;
  let latest = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
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
      model: rec.model || "",
    };
  }
  if (!latest) return null;
  const totalPrompt = totalInput + totalCacheRead;
  const cacheHitRate = totalPrompt > 0 ? Number((totalCacheRead / totalPrompt).toFixed(4)) : 0;
  return {
    scanVersion: 2,
    source: "on-demand-transcript",
    conversationId: conversationId || "",
    updatedAt: new Date().toISOString(),
    plannerSteps,
    latest,
    peakContext,
    totalInput,
    totalCacheRead,
    cacheHitRate,
  };
}

export function readShadowStats({ root = shadowRootDir(), conversationId = "", transcriptPath = "" }) {
  const readJsonSafe = (p) => {
    try {
      return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
    } catch {
      return null;
    }
  };

  const globalStats = readJsonSafe(join(root, STATS_FILE)) || {
    cuts: 0,
    rawBytes: 0,
    cardBytes: 0,
    rawTokensEst: 0,
    cardTokensEst: 0,
    savedTokensEst: 0,
  };

  let targetConv = conversationId ? sanitizeKey(conversationId) : "";
  let targetDir = targetConv ? sessionShadowDir(root, targetConv) : "";
  if (!targetDir || !existsSync(targetDir)) {
    const latest = findLatestSessionDir(root);
    if (latest) {
      targetConv = latest.conversationId;
      targetDir = latest.dir;
    }
  }

  const sessionStats = targetDir ? readJsonSafe(join(targetDir, SESSION_STATS_FILE)) : null;
  let watermark = targetDir ? readJsonSafe(join(targetDir, "watermark.json")) : null;
  const candidateTranscript =
    transcriptPath ||
    (targetConv
      ? join(homedir(), ".gemini", "antigravity", "brain", targetConv, ".system_generated", "logs", "transcript_full.jsonl")
      : "");
  if (candidateTranscript && existsSync(candidateTranscript)) {
    try {
      const tMtime = statSync(candidateTranscript).mtimeMs;
      const wPath = targetDir ? join(targetDir, "watermark.json") : "";
      const wMtime = wPath && existsSync(wPath) ? statSync(wPath).mtimeMs : 0;
      if (!watermark || tMtime > wMtime) {
        const liveWm = computeWatermarkFromTranscript(candidateTranscript, targetConv);
        if (liveWm) watermark = liveWm;
      }
    } catch {}
  }
  const backups = targetDir
    ? listSessionFiles(targetDir).slice(0, 20).map((f) => ({
        shadowId: f.shadowId,
        sourceType: f.meta?.sourceType || "",
        sourceLabel: f.meta?.sourceLabel || "",
        lines: f.meta?.lines || 0,
        bytes: f.size,
        exitCode: f.meta?.exitCode ?? null,
        createdAt: f.meta?.createdAt || "",
      }))
    : [];

  return {
    shadowRoot: root,
    updateStatus: getCachedUpdateStatus(),
    globalStats,
    conversationId: targetConv || null,
    sessionStats,
    watermark,
    recentBackups: backups,
  };
}
