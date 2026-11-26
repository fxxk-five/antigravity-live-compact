/**
 * Context Doctor & Clean-Slate Session Relay Engine for Antigravity Live Compact (v2.0).
 *
 * Pure Node.js >= 22 (zero external dependencies):
 * - Millisecond-grade deterministic trajectory autopsy (`transcript_full.jsonl` / `transcript.jsonl`)
 * - Hybrid deterministic handoff brief + 3-slot semantic overlay (`hypothesis`, `redlines`, `nextAction`)
 * - Automatic governance-doc pointer extraction & `git status --porcelain` shell-edit fallback
 * - Cross-session `shadowId` cold-memory inheritance
 * - Official `ConversationService` (`GetConversation` / `CreateConversation` / `UpdateConversation`) client
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { estimateTokens } from "./plan.mjs";
import { sanitizeKey, sessionShadowDir, shadowRootDir } from "./shadow.mjs";

const HANDOFF_NOTES_FILE = "handoff-notes.json";
const HANDOFF_BRIEF_FILE = "handoff-brief.md";
const GOVERNANCE_DOC_RE =
  /(?:^|[/\\])(?:AGENTS|CONSTITUTION|CLAUDE|GEMINI|current-status|development-workflow|document-governance|frontend-ui-ux-spec|0\d{3}-[^/\\]+)\.md$/i;

export function appDataRootDir(env = process.env) {
  if (env.ANTIGRAVITY_APP_DATA_DIR && env.ANTIGRAVITY_APP_DATA_DIR.trim()) {
    return resolve(env.ANTIGRAVITY_APP_DATA_DIR.trim());
  }
  return join(homedir(), ".gemini", "antigravity");
}

function byteLen(str) {
  return str ? Buffer.byteLength(String(str), "utf8") : 0;
}

function normPath(p) {
  if (!p) return "";
  return String(p).trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

function cleanUserPrompt(raw = "") {
  const s = String(raw || "");
  const m = s.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (m) return m[1].trim();
  return s
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
    .replace(/The following is a <SYSTEM_MESSAGE>[\s\S]*$/i, "")
    .trim();
}

function stripGenericHeader(raw = "") {
  return String(raw || "")
    .replace(/^(?:Created At|Completed At):[^\r\n]*[\r\n]+/gm, "")
    .replace(/^A pre-tool hook changed the arguments[^\r\n]*[\r\n]+/gm, "")
    .trim();
}

function parseReadLineRange(args, body) {
  const m = body.match(/^Showing lines (\d+)-(\d+) of (\d+)/m);
  if (m) return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
  const s = Number(args?.StartLine) || 1;
  const lines = body ? body.split(/\r?\n/).length : 1;
  const e = Number(args?.EndLine) || s + Math.max(0, lines - 1);
  return { start: s, end: Math.max(s, e), total: null };
}

function extractEditedFiles(tc) {
  const name = tc?.name || "";
  const args = tc?.args || {};
  const results = [];
  if (["edit_file", "write_file", "replace_file_content", "multi_replace_file_content"].includes(name)) {
    const p = args.Path || args.TargetFile || args.AbsolutePath;
    if (p) results.push({ rawPath: String(p), norm: normPath(p), op: name === "write_file" ? "write" : "edit" });
  } else if (name === "call_mcp_tool" || name.startsWith("mcp_")) {
    const toolName = args.ToolName || name;
    if (/apply_edits/i.test(toolName)) {
      let edits = args.Arguments?.edits ?? args.edits;
      if (typeof edits === "string") {
        try {
          edits = JSON.parse(edits);
        } catch {}
      }
      const cwd = args.Arguments?.cwd || args.cwd || "";
      if (Array.isArray(edits)) {
        for (const e of edits) {
          if (e?.path) {
            const full = isAbsolute(e.path) || !cwd ? e.path : join(cwd, e.path);
            results.push({ rawPath: full, norm: normPath(full), op: e.create != null ? "write" : "edit" });
          }
        }
      }
    }
  }
  return results;
}

function parseCommandOutcome(outputText) {
  const body = stripGenericHeader(outputText);
  let exitCode = null;
  const mExit =
    body.match(/Command exited with code (-?\d+)/i) ||
    body.match(/\bexit[_\s-]*code[=:\s]+(-?\d+)/i) ||
    body.match(/\(exit=(-?\d+)\s+(?:OK|FAILED)\)/i);
  if (mExit) exitCode = Number(mExit[1]);

  const mBg = body.match(/background task with task id:\s*([^\s\r\n]+)/i);
  const bgTaskId = mBg ? mBg[1].trim() : null;

  const mShadow = body.match(/(?:shadowId[":=\s]+|Shadow:\s*id=)(raw-[0-9a-f]{16})/i);
  const shadowId = mShadow ? mShadow[1] : null;

  const lines = body
    .replace(/^Command exited with code -?\d+\.?\s*/im, "")
    .replace(/^Command output:\s*/im, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const errLines = lines.filter(
    (l) =>
      /(?:error|fail|exception|timeout|ERR!|AssertionError|exit=[1-9])/i.test(l) &&
      !/ErrorActionPreference/i.test(l),
  );
  const signal = (errLines.length ? errLines.slice(0, 3) : lines.slice(-3)).join(" | ").slice(0, 220);

  return { exitCode, bgTaskId, shadowId, signal };
}

function findGitRootFromPaths(paths) {
  const checked = new Set();
  for (const raw of paths) {
    if (!raw || typeof raw !== "string") continue;
    // Skip brain scratch / .gemini internal files when inferring user workspace repo
    if (/\.gemini[/\\]antigravity[/\\]brain/i.test(raw)) continue;
    let cur = dirname(resolve(raw));
    for (let depth = 0; depth < 8; depth += 1) {
      if (checked.has(cur)) break;
      checked.add(cur);
      if (existsSync(join(cur, ".git"))) return cur;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return "";
}

function readGitStatusShort(repoRoot) {
  if (!repoRoot || !existsSync(repoRoot)) return [];
  try {
    const res = spawnSync("git", ["-C", repoRoot, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 2500,
      windowsHide: true,
    });
    if (res.status !== 0 || !res.stdout) return [];
    return res.stdout
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter(Boolean)
      .slice(0, 20);
  } catch {
    return [];
  }
}

export function findTranscriptPath(conversationId, appDir = appDataRootDir()) {
  const logDir = join(appDir, "brain", conversationId, ".system_generated", "logs");
  const fullPath = join(logDir, "transcript_full.jsonl");
  if (existsSync(fullPath)) return fullPath;
  const compPath = join(logDir, "transcript.jsonl");
  if (existsSync(compPath)) return compPath;
  return "";
}

export function resolveConversationId(inputId = "", { appDir = appDataRootDir(), env = process.env } = {}) {
  const brainDir = join(appDir, "brain");
  const trimmed = String(inputId || "").trim();

  if (!trimmed) {
    if (env.ANTIGRAVITY_CONVERSATION_ID && findTranscriptPath(env.ANTIGRAVITY_CONVERSATION_ID, appDir)) {
      return env.ANTIGRAVITY_CONVERSATION_ID.trim();
    }
    if (!existsSync(brainDir)) throw new Error(`Brain directory not found: ${brainDir}`);
    let best = null;
    for (const entry of readdirSync(brainDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "tempmediaStorage") continue;
      const tp = findTranscriptPath(entry.name, appDir);
      if (!tp) continue;
      try {
        const st = statSync(tp);
        if (!best || st.mtimeMs > best.mtimeMs) {
          best = { id: entry.name, mtimeMs: st.mtimeMs };
        }
      } catch {}
    }
    if (best) return best.id;
    throw new Error("No active conversations found");
  }

  if (existsSync(join(brainDir, trimmed)) && findTranscriptPath(trimmed, appDir)) {
    return trimmed;
  }
  if (!existsSync(brainDir)) throw new Error(`Conversation "${trimmed}" not found`);
  const prefix = trimmed.toLowerCase();
  const matches = readdirSync(brainDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.toLowerCase().startsWith(prefix) && findTranscriptPath(e.name, appDir))
    .map((e) => e.name);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Ambiguous conversation prefix "${trimmed}": ${matches.slice(0, 5).join(", ")}`);
  throw new Error(`Conversation "${trimmed}" not found`);
}

export function loadHandoffNotes(conversationId, shadowRoot = shadowRootDir()) {
  try {
    const p = join(sessionShadowDir(shadowRoot, conversationId), HANDOFF_NOTES_FILE);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function saveHandoffNotes(conversationId, notes = {}, shadowRoot = shadowRootDir()) {
  const dir = sessionShadowDir(shadowRoot, conversationId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prev = loadHandoffNotes(conversationId, shadowRoot) || {};
  const merged = {
    conversationId: sanitizeKey(conversationId),
    hypothesis: typeof notes.hypothesis === "string" ? notes.hypothesis.trim() : (prev.hypothesis || ""),
    redlines: typeof notes.redlines === "string" ? notes.redlines.trim() : (prev.redlines || ""),
    nextAction: typeof notes.nextAction === "string" ? notes.nextAction.trim() : (prev.nextAction || ""),
    customBrief: typeof notes.customBrief === "string" ? notes.customBrief : (prev.customBrief || ""),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, HANDOFF_NOTES_FILE), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return merged;
}

export function analyzeConversation(
  inputId = "",
  {
    appDir = appDataRootDir(),
    shadowRoot = shadowRootDir(),
    env = process.env,
    includeGitStatus = true,
    notesOverride = null,
  } = {},
) {
  const t0 = performance.now();
  const conversationId = resolveConversationId(inputId, { appDir, env });
  const transcriptPath = findTranscriptPath(conversationId, appDir);
  if (!transcriptPath) {
    throw new Error(`Transcript not found for conversation ${conversationId}`);
  }

  const rawText = readFileSync(transcriptPath, "utf8");
  const lines = rawText.split("\n");
  const steps = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l || !l.trim()) continue;
    try {
      steps.push(JSON.parse(l));
    } catch {}
  }

  const buckets = {
    read_file_out: 0,
    run_command_out: 0,
    edit_write_args: 0,
    mcp_out: 0,
    planner_text: 0,
    system_msg: 0,
    user_and_other: 0,
  };

  let peakCtx = 0;
  let peakStep = 0;
  let latestCtx = 0;
  let totalInput = 0;
  let totalCache = 0;
  let checkpoints = 0;
  let errorCount = 0;
  let trailingErrors = 0;
  let latestModel = "unknown";
  let lastModelNote = "";

  const userPrompts = [];
  const readEvents = [];
  const editEvents = [];
  const governanceDocs = new Map();
  const fileLedger = new Map();
  const commandRecords = [];
  const bgTaskLookup = new Map();
  const gitCommits = [];
  const topSteps = [];
  const transcriptShadowIds = new Set();
  const observedPaths = [];
  let latestStepsChecklist = null;

  const epochs = [[]];
  const pairedGenerics = new Set();

  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    const stepIdx = s.step_index ?? i;

    if (typeof s.content === "string" && s.content.includes("raw-")) {
      for (const m of s.content.matchAll(/\b(raw-[a-f0-9]{16})\b/g)) {
        transcriptShadowIds.add(m[1]);
      }
    }

    if (s.type === "USER_INPUT") {
      trailingErrors = 0;
      buckets.user_and_other += byteLen(s.content);
      const cleaned = cleanUserPrompt(s.content);
      if (cleaned && !/^Error: The stream was interrupted/i.test(cleaned)) {
        userPrompts.push({ stepIndex: stepIdx, createdAt: s.created_at || "", text: cleaned });
      }
    } else if (s.type === "SYSTEM_MESSAGE" || s.type === "CHECKPOINT" || s.type === "ERROR_MESSAGE") {
      const b = byteLen(s.content) + byteLen(s.error);
      buckets.system_msg += b;
      if (b > 8000) {
        topSteps.push({ stepIndex: stepIdx, kind: s.type, label: s.type, bytes: b });
      }
      if (s.type === "CHECKPOINT") {
        checkpoints += 1;
        epochs.push([]);
      } else if (s.type === "ERROR_MESSAGE") {
        errorCount += 1;
        trailingErrors += 1;
      } else if (s.type === "SYSTEM_MESSAGE" && typeof s.content === "string") {
        for (const [taskId, rec] of bgTaskLookup.entries()) {
          if (s.content.includes(taskId)) {
            const parsed = parseCommandOutcome(s.content);
            if (parsed.exitCode !== null) rec.exitCode = parsed.exitCode;
            if (parsed.signal) rec.signal = parsed.signal;
          }
        }
      }
    } else if (s.type === "PLANNER_RESPONSE") {
      if (s.status === "ERROR") {
        errorCount += 1;
        trailingErrors += 1;
      } else {
        trailingErrors = 0;
      }
      if (s.model) latestModel = s.model;
      if (typeof s.content === "string" && s.content.trim()) {
        lastModelNote = s.content.trim();
      }
      const inp = Number(s.input_tokens) || 0;
      const cache = Number(s.cache_read_tokens) || 0;
      const ctx = inp + cache;
      if (ctx > 0) {
        if (ctx > peakCtx) {
          peakCtx = ctx;
          peakStep = stepIdx;
        }
        latestCtx = ctx;
        totalInput += inp;
        totalCache += cache;
      }

      const thinkB = byteLen(s.thinking);
      const contB = byteLen(s.content);
      buckets.planner_text += thinkB + contB;
      if (thinkB + contB > 8000) {
        topSteps.push({
          stepIndex: stepIdx,
          kind: "model_output",
          label: `Model thinking+content (${s.output_tokens || 0} out tok)`,
          bytes: thinkB + contB,
        });
      }

      const calls = Array.isArray(s.tool_calls) ? s.tool_calls : [];
      const next = steps[i + 1];
      if (next && s.created_at && next.created_at && s.status !== "ERROR" && (calls.length > 0 || next.type === "ERROR_MESSAGE")) {
        if (next.type === "GENERIC" || next.type === "ERROR_MESSAGE") {
          const dtSec = (Date.parse(next.created_at) - Date.parse(s.created_at)) / 1000;
          if (Number.isFinite(dtSec) && dtSec >= 0 && dtSec < 300) {
            epochs[epochs.length - 1].push({ stepIndex: stepIdx, ctx, sec: dtSec });
          }
        }
      }

      let gOffset = 0;
      for (let c = 0; c < calls.length; c += 1) {
        const tc = calls[c];
        const name = tc?.name || "tool";
        const args = tc?.args || {};
        const argsB = byteLen(JSON.stringify(args));

        let gen = null;
        if (i + 1 + gOffset < steps.length && steps[i + 1 + gOffset].type === "GENERIC") {
          gen = steps[i + 1 + gOffset];
          pairedGenerics.add(i + 1 + gOffset);
          gOffset += 1;
        }
        const outRaw = gen?.content || "";
        const outB = byteLen(outRaw);
        const genStepIdx = gen?.step_index ?? stepIdx;

        if (name === "update_steps" && Array.isArray(args.steps)) {
          latestStepsChecklist = { stepIndex: stepIdx, steps: args.steps };
        }

        for (const ef of extractEditedFiles(tc)) {
          observedPaths.push(ef.rawPath);
          editEvents.push({ stepIndex: stepIdx, ...ef });
          const existing = fileLedger.get(ef.norm);
          if (!existing) {
            fileLedger.set(ef.norm, {
              rawPath: ef.rawPath,
              created: ef.op === "write",
              editCount: 1,
              firstStep: stepIdx,
              lastStep: stepIdx,
            });
          } else {
            existing.editCount += 1;
            existing.lastStep = stepIdx;
          }
        }

        if (name === "read_file") {
          buckets.user_and_other += argsB;
          buckets.read_file_out += outB;
          const p = String(args.Path || "");
          if (p) observedPaths.push(p);
          if (p && GOVERNANCE_DOC_RE.test(p) && !/\.gemini[/\\]antigravity[/\\]builtin/i.test(p)) {
            governanceDocs.set(normPath(p), p);
          }
          const range = parseReadLineRange(args, stripGenericHeader(outRaw));
          readEvents.push({
            stepIndex: genStepIdx,
            plannerStep: stepIdx,
            rawPath: p,
            norm: normPath(p),
            start: range.start,
            end: range.end,
            bytes: outB,
          });
          topSteps.push({
            stepIndex: genStepIdx,
            kind: "read_file",
            label: `read_file ${basename(p)} (L${range.start}-${range.end})`,
            bytes: outB,
          });
        } else if (name === "run_command" || name === "manage_task") {
          buckets.user_and_other += argsB;
          buckets.run_command_out += outB;
          const cmdLine = String(args.CommandLine || args.Action || "").trim();
          topSteps.push({
            stepIndex: genStepIdx,
            kind: name,
            label: `${name} (${args.toolSummary || cmdLine.slice(0, 48).replace(/\s+/g, " ")})`,
            bytes: outB,
          });

          if (name === "run_command" && gen) {
            const parsed = parseCommandOutcome(outRaw);
            const rec = {
              stepIndex: stepIdx,
              resultStepIndex: genStepIdx,
              summary: args.toolSummary || "",
              command: cmdLine,
              exitCode: parsed.exitCode,
              bgTaskId: parsed.bgTaskId,
              shadowId: parsed.shadowId,
              signal: parsed.signal,
            };
            commandRecords.push(rec);
            if (parsed.bgTaskId) bgTaskLookup.set(parsed.bgTaskId, rec);

            for (const cm of cmdLine.matchAll(/git(?:\s+-C\s+\S+)?\s+commit\s+-m\s+["']([^"'\r\n]+)["']/g)) {
              gitCommits.push({ stepIndex: stepIdx, message: cm[1] });
            }
          }
        } else if (name === "edit_file" || name === "write_file") {
          buckets.edit_write_args += argsB;
          buckets.user_and_other += outB;
          topSteps.push({
            stepIndex: stepIdx,
            kind: `${name}_args`,
            label: `${name} ${basename(String(args.Path || ""))}`,
            bytes: argsB,
          });
        } else if (name === "call_mcp_tool" || name.startsWith("mcp_") || name.startsWith("shadow_")) {
          buckets.user_and_other += argsB;
          buckets.mcp_out += outB;
          const sub = name === "call_mcp_tool" ? `${args.ServerName || ""}:${args.ToolName || ""}` : name;
          topSteps.push({
            stepIndex: genStepIdx,
            kind: "mcp_out",
            label: `MCP ${sub}`,
            bytes: outB,
          });
        } else {
          buckets.user_and_other += argsB + outB;
        }
      }
    } else if (s.type === "GENERIC" && !pairedGenerics.has(i)) {
      buckets.user_and_other += byteLen(s.content);
    }
  }

  // Enrich shadow manifest from session shadow directory
  const sDir = sessionShadowDir(shadowRoot, conversationId);
  const shadowManifest = [];
  if (existsSync(sDir)) {
    for (const mf of readdirSync(sDir).filter((f) => f.endsWith(".meta.json"))) {
      try {
        const meta = JSON.parse(readFileSync(join(sDir, mf), "utf8"));
        shadowManifest.push({
          shadowId: meta.shadowId,
          toolName: meta.toolName || "",
          exitCode: meta.exitCode ?? null,
          bytes: meta.bytes || 0,
          lines: meta.lines || 0,
          label: String(meta.sourceLabel || meta.originalPath || "").replace(/\s+/g, " ").slice(0, 90),
          createdAt: meta.createdAt || "",
        });
      } catch {}
    }
  }
  shadowManifest.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const knownShadows = new Set(shadowManifest.map((x) => x.shadowId));
  for (const sid of transcriptShadowIds) {
    if (!knownShadows.has(sid)) {
      shadowManifest.push({
        shadowId: sid,
        toolName: "transcript-ref",
        exitCode: null,
        bytes: 0,
        lines: 0,
        label: "Referenced in Spine Card",
        createdAt: "",
      });
    }
  }

  const shadowById = new Map(shadowManifest.map((x) => [x.shadowId, x]));
  for (const cmd of commandRecords) {
    if (cmd.exitCode === null && cmd.shadowId && shadowById.has(cmd.shadowId)) {
      cmd.exitCode = shadowById.get(cmd.shadowId).exitCode;
    }
  }

  // Compute read redundancy & stale-snapshot waste
  const editsByPath = new Map();
  for (const e of editEvents) {
    if (!editsByPath.has(e.norm)) editsByPath.set(e.norm, []);
    editsByPath.get(e.norm).push(e.stepIndex);
  }
  const seenPathCounts = new Map();
  const seenLinesSinceEdit = new Map();
  let pathRepeatCalls = 0;
  let pathRepeatBytes = 0;
  let uneditedOverlapBytes = 0;
  let staleReadCalls = 0;
  let staleReadBytes = 0;
  let deadOrDupUnionBytes = 0;

  for (const r of readEvents) {
    if (!r.norm) continue;
    const prev = seenPathCounts.get(r.norm) || 0;
    if (prev > 0) {
      pathRepeatCalls += 1;
      pathRepeatBytes += r.bytes;
    }
    seenPathCounts.set(r.norm, prev + 1);

    const fileEdits = editsByPath.get(r.norm) || [];
    const isStale = fileEdits.some((es) => es > r.plannerStep);
    if (isStale) {
      staleReadCalls += 1;
      staleReadBytes += r.bytes;
    }

    const lastEditBefore = fileEdits.filter((es) => es <= r.plannerStep).at(-1) ?? -1;
    let st = seenLinesSinceEdit.get(r.norm);
    if (!st || st.lastEdit !== lastEditBefore) {
      st = { lastEdit: lastEditBefore, lines: new Set() };
      seenLinesSinceEdit.set(r.norm, st);
    }
    const span = Math.max(1, r.end - r.start + 1);
    let overlap = 0;
    for (let ln = r.start; ln <= r.end; ln += 1) {
      if (st.lines.has(ln)) overlap += 1;
      else st.lines.add(ln);
    }
    const dupBytes = Math.round(r.bytes * (overlap / span));
    uneditedOverlapBytes += dupBytes;
    deadOrDupUnionBytes += isStale ? r.bytes : dupBytes;
  }

  const hotReadFiles = [...seenPathCounts.entries()]
    .filter(([, c]) => c > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([p, count]) => ({ file: basename(p), count }));

  const nonEmptyEpochs = epochs.filter((ep) => ep.length >= 3);
  const activeEpoch = nonEmptyEpochs.at(-1) || [];
  const peakEpoch = nonEmptyEpochs.reduce((best, ep) => {
    const maxC = Math.max(...ep.map((x) => x.ctx), 0);
    const bestC = best ? Math.max(...best.map((x) => x.ctx), 0) : -1;
    return maxC > bestC ? ep : best;
  }, activeEpoch);

  function summarizeEpochLatency(ep) {
    if (!ep || !ep.length) return { count: 0, firstAvg: 0, lastAvg: 0, ratio: 1, startCtx: 0, endCtx: 0 };
    const k = Math.max(1, Math.floor(ep.length / 3));
    const avg = (arr) => arr.reduce((sum, x) => sum + x.sec, 0) / arr.length;
    const firstAvg = avg(ep.slice(0, k));
    const lastAvg = avg(ep.slice(-k));
    return {
      count: ep.length,
      firstAvg: Number(firstAvg.toFixed(1)),
      lastAvg: Number(lastAvg.toFixed(1)),
      ratio: firstAvg > 0 ? Number((lastAvg / firstAvg).toFixed(2)) : 1,
      startCtx: ep[0].ctx,
      endCtx: ep.at(-1).ctx,
    };
  }

  const activeLatency = summarizeEpochLatency(activeEpoch);
  const peakLatency = summarizeEpochLatency(peakEpoch);

  const totalBytes = Object.values(buckets).reduce((a, b) => a + b, 0);
  const totalReadBytes = buckets.read_file_out;
  topSteps.sort((a, b) => b.bytes - a.bytes);
  const top5Steps = topSteps.slice(0, 5);

  const reasons = [];
  let level = "OK";
  if (latestCtx >= 220_000) {
    level = "CRITICAL";
    reasons.push(`当前活跃水位已达 ${(latestCtx / 1000).toFixed(1)}k tokens（跨过 220k 高延迟拐点）`);
  } else if (peakCtx >= 350_000 && checkpoints > 0 && latestCtx >= 165_000) {
    level = "CRITICAL";
    reasons.push(`已触发 ${checkpoints} 次宿主 CHECKPOINT 压缩（峰值 ${(peakCtx / 1000).toFixed(1)}k），且二次膨胀至 ${(latestCtx / 1000).toFixed(1)}k`);
  } else if (latestCtx >= 165_000) {
    level = "WARN";
    reasons.push(`当前水位 ${(latestCtx / 1000).toFixed(1)}k 已进入 165k–220k 推荐交接窗口`);
  }

  const refLat = activeLatency.count >= 6 ? activeLatency : peakLatency;
  if (refLat.ratio >= 2.2 && refLat.lastAvg >= 32) {
    level = "CRITICAL";
    reasons.push(`单轮模型响应耗时从前 1/3 的 ${refLat.firstAvg}s 劣化至后 1/3 的 ${refLat.lastAvg}s（劣化 ${refLat.ratio}x）`);
  }
  const wasteRatio = totalReadBytes > 0 ? deadOrDupUnionBytes / totalReadBytes : 0;
  if (wasteRatio >= 0.4 && deadOrDupUnionBytes >= 120 * 1024) {
    if (level === "OK") level = "WARN";
    reasons.push(`read_file 过期/重复载荷达 ${(deadOrDupUnionBytes / 1024).toFixed(1)} KB（占读取总量的 ${(wasteRatio * 100).toFixed(1)}%）`);
  }
  if (trailingErrors >= 2 || errorCount >= 5) {
    level = "CRITICAL";
    reasons.push(`累计发生 ${errorCount} 次流错误/超时（尾部连续失败 ${trailingErrors} 次）`);
  }
  if (!reasons.length) {
    reasons.push(`当前水位 ${(latestCtx / 1000).toFixed(1)}k tokens 处于高效低延迟区间`);
  }

  const repoRoot = includeGitStatus ? findGitRootFromPaths(observedPaths) : "";
  const gitStatusLines = repoRoot ? readGitStatusShort(repoRoot) : [];
  const savedNotes = notesOverride || loadHandoffNotes(conversationId, shadowRoot) || {};

  const report = {
    conversationId,
    transcriptSource: basename(transcriptPath),
    repoRoot,
    latestModel,
    stepCount: steps.length,
    checkpoints,
    errorCount,
    trailingErrors,
    peakCtx,
    peakStep,
    latestCtx,
    cacheHitRate: totalInput + totalCache > 0 ? Number(((totalCache / (totalInput + totalCache)) * 100).toFixed(1)) : 0,
    totalBytes,
    buckets,
    redundancy: {
      totalReadCalls: readEvents.length,
      uniqueFilesRead: seenPathCounts.size,
      pathRepeatCalls,
      pathRepeatBytes,
      uneditedOverlapBytes,
      staleReadCalls,
      staleReadBytes,
      deadOrDupUnionBytes,
      hotReadFiles,
    },
    activeLatency,
    peakLatency,
    top5Steps,
    verdict: {
      recommendHandoff: level === "CRITICAL" || level === "WARN",
      level,
      reasons,
    },
    handoff: {
      userPrompts,
      governanceDocs: [...governanceDocs.values()],
      modifiedFiles: [...fileLedger.values()],
      gitStatusLines,
      gitCommits,
      last3Commands: commandRecords.slice(-3),
      lastFailedCommand: [...commandRecords].reverse().find((c) => c.exitCode !== null && c.exitCode !== 0) || null,
      checklist: latestStepsChecklist,
      shadowManifest,
      lastModelNote: lastModelNote.slice(0, 420),
      semanticNotes: {
        hypothesis: savedNotes.hypothesis || "",
        redlines: savedNotes.redlines || "",
        nextAction: savedNotes.nextAction || "",
      },
    },
  };

  const handoffBrief =
    savedNotes.customBrief && savedNotes.customBrief.trim()
      ? savedNotes.customBrief.trim()
      : renderHandoffBrief(report);
  const doctorMarkdown = renderDoctorMarkdown(report, handoffBrief);
  const elapsedMs = Number((performance.now() - t0).toFixed(2));
  const briefTokens = estimateTokens(handoffBrief);

  return {
    elapsedMs,
    report,
    handoffBrief,
    doctorMarkdown,
    metrics: {
      briefChars: handoffBrief.length,
      briefBytes: byteLen(handoffBrief),
      briefTokensEst: briefTokens,
      compressionPct: peakCtx > 0 ? Number(((1 - briefTokens / peakCtx) * 100).toFixed(2)) : 0,
      compressionRatio: briefTokens > 0 && peakCtx > 0 ? Number((peakCtx / briefTokens).toFixed(1)) : 1,
    },
  };
}

function truncateMiddle(text, maxChars = 750) {
  const s = String(text || "").trim();
  if (s.length <= maxChars) return s;
  const half = Math.floor((maxChars - 28) / 2);
  return `${s.slice(0, half)}\n...[省略 ${s.length - half * 2} 字符]...\n${s.slice(-half)}`;
}

export function renderHandoffBrief(r) {
  const h = r.handoff;
  const notes = h.semanticNotes || {};
  const lines = [];
  lines.push(`# Clean-Slate Session Relay（无损热交接契约）`);
  lines.push(
    `> 接力自源会话 \`${r.conversationId}\`（原峰值 **${(r.peakCtx / 1000).toFixed(1)}k** tok → 现已切入干净低延迟上下文池）。请基于以下确定性工程账本直接继续推进，不要盲目全仓重扫。`,
  );
  if (r.repoRoot) {
    lines.push(`> 工作区仓库: \`${r.repoRoot}\``);
  }
  lines.push("");

  // Semantic 3-slot overlay (or fallback last model note)
  if (notes.hypothesis || notes.redlines || notes.nextAction || h.lastModelNote) {
    lines.push("## 0. 核心交接判断与接手第一刀");
    if (notes.nextAction) lines.push(`- **接手第一刀 (Next Action)**: ${notes.nextAction}`);
    if (notes.hypothesis) lines.push(`- **当前进展与排障判断 (Hypothesis)**: ${notes.hypothesis}`);
    if (notes.redlines) lines.push(`- **必守红线与约束 (Redlines)**: ${notes.redlines}`);
    if (!notes.hypothesis && !notes.nextAction && h.lastModelNote) {
      lines.push(`- **源会话最后进展摘录**: ${h.lastModelNote.replace(/\s+/g, " ")}`);
    }
    lines.push("");
  }

  // 1. User prompts
  lines.push("## 1. 用户原始目标与追加指令");
  if (!h.userPrompts.length) {
    lines.push("- （未检测到显式用户输入）");
  } else {
    const selected =
      h.userPrompts.length <= 4
        ? h.userPrompts
        : [h.userPrompts[0], ...h.userPrompts.slice(-3)];
    for (let i = 0; i < selected.length; i += 1) {
      const up = selected[i];
      const label = up === h.userPrompts[0] ? "初始目标" : `追加指令 (step#${up.stepIndex})`;
      lines.push(`- **[${label}]**: ${truncateMiddle(up.text, 650).replace(/\r?\n/g, "\n  ")}`);
    }
  }
  if (h.governanceDocs.length) {
    lines.push(`- **关联规范/合同文件指针（按需分段查阅）**: ${h.governanceDocs.slice(0, 8).map((p) => `\`${p}\``).join("、")}`);
  }
  lines.push("");

  // 2. Modified files & git status
  lines.push(`## 2. 已修改/创建文件台账（共 ${h.modifiedFiles.length} 个）`);
  if (!h.modifiedFiles.length) {
    lines.push("- （源会话无 `edit_file`/`write_file` 记录）");
  } else {
    for (const f of h.modifiedFiles.slice(0, 25)) {
      const badge = f.created ? "NEW" : `EDIT x${f.editCount}`;
      lines.push(`- \`${f.rawPath}\` [${badge}, last step#${f.lastStep}]`);
    }
    if (h.modifiedFiles.length > 25) {
      lines.push(`- *（其余 ${h.modifiedFiles.length - 25} 个已修改文件略）*`);
    }
  }
  if (h.gitCommits.length) {
    lines.push(`- **已完成 Git 提交 (${h.gitCommits.length})**: ${h.gitCommits.map((c) => `\`${c.message}\``).join("；")}`);
  }
  if (h.gitStatusLines.length) {
    lines.push(`- **当前工作区未提交状态 (\`git status --porcelain\`)**:`);
    for (const gl of h.gitStatusLines.slice(0, 12)) {
      lines.push(`  - \`${gl}\``);
    }
  }
  lines.push("");

  // 3. Recent & failed commands
  lines.push("## 3. 最近关键命令与失败诊断信号");
  if (!h.last3Commands.length) {
    lines.push("- （无命令执行记录）");
  } else {
    for (const c of h.last3Commands) {
      const status = c.exitCode === null ? "running/interrupted" : c.exitCode === 0 ? "0 PASS" : `${c.exitCode} FAIL`;
      const cmdShort = c.command.replace(/\s+/g, " ").slice(0, 130);
      lines.push(`- **[step#${c.stepIndex} | exit=${status}]** \`${cmdShort}${c.command.length > 130 ? "…" : ""}\``);
      if (c.signal) lines.push(`  - 信号: \`${c.signal.replace(/`/g, "'")}\``);
    }
  }
  if (h.lastFailedCommand && !h.last3Commands.includes(h.lastFailedCommand)) {
    const fc = h.lastFailedCommand;
    lines.push(
      `- ⚠️ **最近失败命令 [step#${fc.stepIndex}, exit=${fc.exitCode}]**: \`${fc.command.replace(/\s+/g, " ").slice(0, 120)}\` → \`${(fc.signal || "").replace(/`/g, "'")}\``,
    );
  }
  lines.push("");

  // 4. Unfinished checklist
  if (h.checklist && Array.isArray(h.checklist.steps) && h.checklist.steps.length) {
    const unfinished = h.checklist.steps.filter((s) => s.status !== "done");
    const doneCount = h.checklist.steps.length - unfinished.length;
    lines.push(`## 4. 步骤进度（已完成 ${doneCount}/${h.checklist.steps.length}）`);
    if (!unfinished.length) {
      lines.push("- 既定步骤已全部标记 `done`。");
    } else {
      for (const s of unfinished) {
        lines.push(`- [ ] [${s.status}] ${s.title}`);
      }
    }
    lines.push("");
  }

  // 5. Cold memory shadowIds
  if (h.shadowManifest.length) {
    lines.push(`## 5. 跨会话继承的 Live Compact 冷记忆索引（共 ${h.shadowManifest.length} 条）`);
    lines.push(
      `> 如需查阅源会话完整测试/构建/日志细节，直接调用 \`live-compact_shadow\` 的 \`shadow_search(shadowId="...", pattern="...")\` 或 \`shadow_read(shadowId="...")\`，无需重跑慢速命令：`,
    );
    for (const sm of h.shadowManifest.slice(-8)) {
      const kbStr = sm.bytes ? `${(sm.bytes / 1024).toFixed(1)}KB/${sm.lines}L` : "ref";
      lines.push(`- \`${sm.shadowId}\` [${sm.toolName} | ${kbStr} | exit=${sm.exitCode ?? "-"}] — ${sm.label}`);
    }
  }

  return lines.join("\n");
}

export function renderDoctorMarkdown(r, briefMarkdown = "") {
  const b = r.buckets;
  const red = r.redundancy;
  const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "0.0%");
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
  const badge =
    r.verdict.level === "CRITICAL"
      ? "🔴 强烈建议立即热交接 (CRITICAL)"
      : r.verdict.level === "WARN"
        ? "🟡 建议在当前里程碑后交接 (WARN)"
        : "🟢 低水位高效运行中 (OK)";

  const lines = [
    `# Context Doctor 体检单 (\`${r.conversationId.slice(0, 8)}\`)`,
    `- **结论**: **${badge}**`,
    ...r.verdict.reasons.map((reason) => `  - ${reason}`),
    `- **水位与缓存**: 当前 **${(r.latestCtx / 1000).toFixed(1)}k** | 峰值 **${(r.peakCtx / 1000).toFixed(1)}k** | 缓存命中率 **${r.cacheHitRate}%** | 宿主压缩 **${r.checkpoints}** 次 | 错误 **${r.errorCount}** 次`,
    `- **单轮耗时趋势**: 前 1/3 均值 **${r.activeLatency.firstAvg}s** → 后 1/3 均值 **${r.activeLatency.lastAvg}s** (**${r.activeLatency.ratio}x**)`,
    `- **载荷构成 (${kb(r.totalBytes)})**: \`read_file\` ${kb(b.read_file_out)} (${pct(b.read_file_out, r.totalBytes)}) · \`edit/write\` ${kb(b.edit_write_args)} (${pct(b.edit_write_args, r.totalBytes)}) · \`run_command\` ${kb(b.run_command_out)} (${pct(b.run_command_out, r.totalBytes)}) · 模型输出 ${kb(b.planner_text)} (${pct(b.planner_text, r.totalBytes)})`,
    `- **读取冗余**: 共 ${red.totalReadCalls} 次读 / ${red.uniqueFilesRead} 个文件，过期+重复读取共 **${kb(red.deadOrDupUnionBytes)} (${pct(red.deadOrDupUnionBytes, b.read_file_out)})**${red.hotReadFiles.length ? ` | 热点: ${red.hotReadFiles.map((f) => `${f.file}×${f.count}`).join(", ")}` : ""}`,
  ];
  if (briefMarkdown) {
    lines.push("", "---", "", briefMarkdown);
  }
  return lines.join("\n");
}

/**
 * Fast lightweight list of recent active conversations for the MCP App switcher.
 */
export async function listRecentSessions({
  limit = 12,
  appDir = appDataRootDir(),
  shadowRoot = shadowRootDir(),
  env = process.env,
} = {}) {
  const brainDir = join(appDir, "brain");
  if (!existsSync(brainDir)) return [];

  // Optional enrichment from official ConversationService/ListConversations
  const lsMeta = new Map();
  if (env.ANTIGRAVITY_LS_ADDRESS && env.ANTIGRAVITY_CSRF_TOKEN) {
    try {
      const resp = await fetch(
        `http://${env.ANTIGRAVITY_LS_ADDRESS}/product.v1.ConversationService/ListConversations`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            "x-antigravity-csrf-token": env.ANTIGRAVITY_CSRF_TOKEN,
          },
          body: JSON.stringify({ pageSize: 30, includeArchived: false }),
          signal: AbortSignal.timeout(2000),
        },
      );
      if (resp.ok) {
        const data = await resp.json();
        for (const c of data.conversations || []) {
          lsMeta.set(c.id, {
            title: c.annotations?.title || c.state?.summary || "",
            projectId: c.metadata?.projectId || "",
            runState: c.state?.runState || "",
          });
        }
      }
    } catch {}
  }

  const candidates = [];
  for (const entry of readdirSync(brainDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "tempmediaStorage") continue;
    const comp = join(brainDir, entry.name, ".system_generated", "logs", "transcript.jsonl");
    const tp = existsSync(comp) ? comp : findTranscriptPath(entry.name, appDir);
    if (!tp) continue;
    try {
      const st = statSync(tp);
      candidates.push({ id: entry.name, tp, mtimeMs: st.mtimeMs, sizeBytes: st.size });
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const items = [];
  for (const c of candidates.slice(0, Math.max(1, Math.min(25, limit)))) {
    let latestCtx = 0;
    let peakCtx = 0;
    let firstPrompt = "";
    let stepCount = 0;
    try {
      const raw = readFileSync(c.tp, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        stepCount += 1;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (!firstPrompt && rec.type === "USER_INPUT") {
          firstPrompt = cleanUserPrompt(rec.content).replace(/\s+/g, " ").slice(0, 72);
        } else if (rec.type === "PLANNER_RESPONSE") {
          const ctx = (Number(rec.input_tokens) || 0) + (Number(rec.cache_read_tokens) || 0);
          if (ctx > 0) {
            latestCtx = ctx;
            if (ctx > peakCtx) peakCtx = ctx;
          }
        }
      }
    } catch {}
    if (stepCount === 0) continue;
    const meta = lsMeta.get(c.id);
    // Filter out subagent trajectories when ConversationService metadata is available and omits them, unless high context
    const level = latestCtx >= 220_000 ? "CRITICAL" : latestCtx >= 165_000 ? "WARN" : "OK";
    const sStatsPath = join(sessionShadowDir(shadowRoot, c.id), "session-stats.json");
    let cuts = 0;
    try {
      if (existsSync(sStatsPath)) cuts = JSON.parse(readFileSync(sStatsPath, "utf8")).cuts || 0;
    } catch {}

    items.push({
      conversationId: c.id,
      title: meta?.title || firstPrompt || c.id.slice(0, 8),
      projectId: meta?.projectId || "",
      runState: meta?.runState || "",
      latestCtx,
      peakCtx,
      stepCount,
      cuts,
      level,
      updatedAt: new Date(c.mtimeMs).toISOString(),
    });
  }
  return items;
}

/**
 * Prepare and persist a deterministic + semantic handoff brief, and optionally
 * launch a clean-slate conversation in the same project via ConversationService.
 */
export async function prepareAndMaybeLaunchRelay({
  conversationId = "",
  hypothesis = "",
  redlines = "",
  nextAction = "",
  customBrief = "",
  launchNewConversation = false,
  archiveSource = false,
  title = "",
  model = "",
  appDir = appDataRootDir(),
  shadowRoot = shadowRootDir(),
  env = process.env,
  fetcher = fetch,
} = {}) {
  const resolvedId = resolveConversationId(conversationId, { appDir, env });
  const hasNotesUpdate = Boolean(hypothesis || redlines || nextAction || customBrief);
  const savedNotes = hasNotesUpdate
    ? saveHandoffNotes(resolvedId, { hypothesis, redlines, nextAction, customBrief }, shadowRoot)
    : loadHandoffNotes(resolvedId, shadowRoot);

  const analysis = analyzeConversation(resolvedId, {
    appDir,
    shadowRoot,
    env,
    notesOverride: savedNotes || undefined,
  });

  const dir = sessionShadowDir(shadowRoot, resolvedId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const briefPath = join(dir, HANDOFF_BRIEF_FILE);
  writeFileSync(briefPath, `${analysis.handoffBrief}\n`, "utf8");

  const result = {
    ok: true,
    sourceConversationId: resolvedId,
    briefPath,
    handoffBrief: analysis.handoffBrief,
    verdict: analysis.report.verdict,
    metrics: analysis.metrics,
    launched: false,
    newConversationId: null,
    archivedSource: false,
    launchMethod: null,
    launchError: null,
  };

  if (!launchNewConversation) {
    return result;
  }

  const lsAddress = env.ANTIGRAVITY_LS_ADDRESS;
  const csrfToken = env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddress || !csrfToken) {
    result.launchError = "ls-env-unavailable";
    return result;
  }

  const headers = {
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
    "x-antigravity-csrf-token": csrfToken,
  };

  // Resolve source conversation metadata so the new conversation inherits exact projectId!
  let projectId = "";
  let sourceTitle = "";
  try {
    const getResp = await fetcher(
      `http://${lsAddress}/product.v1.ConversationService/GetConversation`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ conversationId: resolvedId }),
        signal: AbortSignal.timeout(4000),
      },
    );
    if (getResp.ok) {
      const convObj = await getResp.json();
      const pid = convObj?.metadata?.projectId || "";
      if (pid && pid !== "outside-of-project") projectId = pid;
      sourceTitle = convObj?.annotations?.title || convObj?.state?.summary || "";
    }
  } catch {}
  if (!projectId && env.ANTIGRAVITY_PROJECT_ID && env.ANTIGRAVITY_PROJECT_ID !== "outside-of-project") {
    projectId = env.ANTIGRAVITY_PROJECT_ID;
  }

  const relayTitle =
    title.trim() ||
    (sourceTitle ? `[Relay] ${sourceTitle.replace(/^\[Relay\]\s*/i, "").slice(0, 60)}` : `Relay from ${resolvedId.slice(0, 8)}`);

  const createBody = {
    title: relayTitle,
    tags: ["live-compact-relay"],
    prompt: [{ text: analysis.handoffBrief }],
  };
  if (projectId) createBody.projectId = projectId;
  if (model && model.trim()) createBody.model = model.trim();

  try {
    const createResp = await fetcher(
      `http://${lsAddress}/product.v1.ConversationService/CreateConversation`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(createBody),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!createResp.ok) {
      const errText = await createResp.text().catch(() => "");
      result.launchError = `HTTP ${createResp.status}: ${errText.slice(0, 200)}`;
      return result;
    }
    const created = await createResp.json();
    const newId = created?.conversation?.id || created?.id || null;
    result.launched = Boolean(newId);
    result.newConversationId = newId;
    result.launchMethod = "ConversationService/CreateConversation";

    if (archiveSource && newId) {
      try {
        const archResp = await fetcher(
          `http://${lsAddress}/product.v1.ConversationService/UpdateConversation`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              conversationId: resolvedId,
              annotations: { archived: true },
            }),
            signal: AbortSignal.timeout(4000),
          },
        );
        result.archivedSource = archResp.ok;
      } catch {}
    }
  } catch (error) {
    result.launchError = error instanceof Error ? error.message : String(error);
  }

  return result;
}
