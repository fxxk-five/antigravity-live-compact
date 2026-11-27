#!/usr/bin/env node
/**
 * Zero-dependency background update checker & one-command updater for Antigravity Live Compact.
 *
 * Design goals:
 * - Zero latency on SessionStart: reads a small local JSON cache (<2ms) and spawns a
 *   detached background refresh only when TTL (default 12h) has expired.
 * - Zero LLM token cost: SessionStart injects a UI-only `metadata.user_markdown` tip
 *   with empty `systemMessage: ""`, so the model never sees the update banner.
 * - Dual-source check: GitHub Releases API (`/releases/latest`) with automatic fallback
 *   to `raw.githubusercontent.com/<owner>/<repo>/main/plugin.json`.
 * - Works for both git-cloned and copied/installed plugin directories (`--apply`).
 */
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..");
const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const RETRY_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes on transient network error
const DEFAULT_REPO = "fxxk-five/antigravity-live-compact";

export function compareVersions(a, b) {
  const parse = (v) =>
    String(v || "")
      .trim()
      .match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i += 1) {
    const left = Number(x[i]);
    const right = Number(y[i]);
    if (left !== right) return left > right ? 1 : -1;
  }
  if (!x[4] && !y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  const lp = x[4].split(".");
  const rp = y[4].split(".");
  for (let i = 0; i < Math.max(lp.length, rp.length); i += 1) {
    if (lp[i] === undefined) return -1;
    if (rp[i] === undefined) return 1;
    if (lp[i] === rp[i]) continue;
    const ln = /^\d+$/.test(lp[i]);
    const rn = /^\d+$/.test(rp[i]);
    if (ln && rn) return Number(lp[i]) > Number(rp[i]) ? 1 : -1;
    if (ln !== rn) return ln ? -1 : 1;
    return lp[i] > rp[i] ? 1 : -1;
  }
  return 0;
}

export function parseGitHubRepo(repoField) {
  const raw =
    typeof repoField === "string"
      ? repoField
      : typeof repoField?.url === "string"
        ? repoField.url
        : "";
  const m = raw.trim().match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  return DEFAULT_REPO;
}

export function readLocalPluginMeta(pluginRoot = PLUGIN_ROOT) {
  try {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8"));
    return {
      name: manifest.name || "live-compact",
      displayName: manifest.displayName || "Live Compact",
      version: String(manifest.version || "0.0.0").trim(),
      repo: parseGitHubRepo(manifest.repository),
      pluginRoot,
    };
  } catch {
    return {
      name: "live-compact",
      displayName: "Live Compact",
      version: "0.0.0",
      repo: DEFAULT_REPO,
      pluginRoot,
    };
  }
}

export function updateCachePath(env = process.env) {
  if (env.AGY_LIVE_COMPACT_UPDATE_CACHE && env.AGY_LIVE_COMPACT_UPDATE_CACHE.trim()) {
    return resolve(env.AGY_LIVE_COMPACT_UPDATE_CACHE.trim());
  }
  if (env.AGY_LIVE_COMPACT_SHADOW_DIR && env.AGY_LIVE_COMPACT_SHADOW_DIR.trim()) {
    return join(dirname(resolve(env.AGY_LIVE_COMPACT_SHADOW_DIR.trim())), "update-check.json");
  }
  return join(homedir(), ".gemini", "antigravity", "live-compact", "update-check.json");
}

export function loadUpdateCache(cachePath = updateCachePath()) {
  try {
    if (!existsSync(cachePath)) return null;
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function saveUpdateCache(cachePath, data) {
  try {
    mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tmp, cachePath);
  } catch {}
}

function summarizeReleaseBody(body) {
  if (typeof body !== "string" || !body.trim()) return "";
  for (const line of body.split(/\r?\n/)) {
    const clean = line
      .replace(/^#+\s*/, "")
      .replace(/^[-*]\s+/, "")
      .replace(/\*\*/g, "")
      .trim();
    if (clean && clean.length >= 6) {
      return clean.length > 140 ? `${clean.slice(0, 140)}…` : clean;
    }
  }
  return "";
}

function fetchJsonViaSystemProxy(url, ua, timeoutMs = 5000) {
  const timeoutSec = Math.max(2, Math.ceil(timeoutMs / 1000));
  const curlBin = process.platform === "win32" ? "curl.exe" : "curl";
  try {
    const res = spawnSync(
      curlBin,
      ["-fsSL", "--max-time", String(timeoutSec), "-H", `User-Agent: ${ua}`, "-H", "Accept: application/vnd.github+json", url],
      { encoding: "utf8", timeout: timeoutMs + 1500, windowsHide: true },
    );
    if (res.status === 0 && res.stdout && res.stdout.trim()) {
      return JSON.parse(res.stdout);
    }
  } catch {}

  // On Windows, PowerShell Invoke-RestMethod honors WinINET / Clash system proxy even when HTTP_PROXY env vars are unset.
  if (process.platform === "win32") {
    try {
      const psCmd =
        "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; " +
        "(Invoke-RestMethod -Uri $env:__LC_FETCH_URL -Headers @{'User-Agent'=$env:__LC_FETCH_UA;'Accept'='application/vnd.github+json'} -TimeoutSec " +
        timeoutSec +
        ") | ConvertTo-Json -Depth 5 -Compress";
      const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCmd], {
        encoding: "utf8",
        timeout: timeoutMs + 3000,
        windowsHide: true,
        env: { ...process.env, __LC_FETCH_URL: url, __LC_FETCH_UA: ua },
      });
      if (res.status === 0 && res.stdout && res.stdout.trim()) {
        return JSON.parse(res.stdout);
      }
    } catch {}
  }
  return null;
}

export async function fetchLatestVersion({ repo = DEFAULT_REPO, currentVersion = "0.0.0", timeoutMs = 5000, fetcher = fetch, allowShellFallback = fetcher === fetch } = {}) {
  const ua = `antigravity-live-compact/${currentVersion}`;
  const releaseApiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  const rawManifestUrl = `https://raw.githubusercontent.com/${repo}/main/plugin.json`;

  const parseRelease = (rel) => {
    if (!rel || rel.draft || rel.prerelease || typeof rel.tag_name !== "string") return null;
    const version = rel.tag_name.replace(/^v/i, "").trim();
    if (compareVersions(version, "0.0.0") === null) return null;
    return {
      ok: true,
      source: "github-release",
      latestVersion: version,
      releaseUrl: rel.html_url || `https://github.com/${repo}/releases/tag/${encodeURIComponent(rel.tag_name)}`,
      summary: summarizeReleaseBody(rel.body),
    };
  };

  const parseManifest = (manifest) => {
    const version = String(manifest?.version || "").replace(/^v/i, "").trim();
    if (compareVersions(version, "0.0.0") === null) return null;
    return {
      ok: true,
      source: "github-main-manifest",
      latestVersion: version,
      releaseUrl: `https://github.com/${repo}`,
      summary: "",
    };
  };

  // 1. Primary: GitHub Releases latest API via fetch
  try {
    const res = await fetcher(releaseApiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": ua,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const parsed = parseRelease(await res.json());
      if (parsed) return parsed;
    }
  } catch {}

  // 2. Fallback: raw main plugin.json via fetch
  try {
    const res = await fetcher(rawManifestUrl, {
      headers: { "User-Agent": ua },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const parsed = parseManifest(await res.json());
      if (parsed) return parsed;
    }
  } catch {}

  // 3. Proxy-aware fallback (curl / Windows WinINET Invoke-RestMethod) when Node fetch cannot reach GitHub directly.
  if (allowShellFallback) {
    const rel = fetchJsonViaSystemProxy(releaseApiUrl, ua, timeoutMs);
    const parsedRel = parseRelease(rel);
    if (parsedRel) return parsedRel;
    const manifest = fetchJsonViaSystemProxy(rawManifestUrl, ua, timeoutMs);
    const parsedMan = parseManifest(manifest);
    if (parsedMan) return parsedMan;
  }

  return { ok: false, error: "network-unavailable" };
}

export function formatUpdateMarkdown({
  currentVersion,
  latestVersion,
  releaseUrl,
  summary = "",
  pluginRoot = PLUGIN_ROOT,
}) {
  const updaterScript = join(pluginRoot, "scripts", "update-check.mjs");
  const lines = [
    "> [!TIP]",
    `> **Live Compact 插件有新版本可用**：\`v${currentVersion}\` → **\`v${latestVersion}\`**（[查看更新说明](${releaseUrl})）`,
  ];
  if (summary) {
    lines.push(`> 更新摘要：${summary}`);
  }
  lines.push(
    `> 升级方式：直接让我帮你升级 Live Compact，或在终端运行 \`node "${updaterScript}" --apply\`（设置 \`AGY_LIVE_COMPACT_NO_UPDATE_CHECK=1\` 可关闭提醒）`,
  );
  return lines.join("\n");
}

function defaultSpawnRefresh(cachePath) {
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--refresh", cachePath], {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronous, <2ms SessionStart evaluator.
 * Reads cached latest version; triggers detached refresh if stale; never blocks on network.
 */
export function evaluateUpdateNotice({
  env = process.env,
  pluginRoot = PLUGIN_ROOT,
  cachePath = updateCachePath(env),
  nowMs = Date.now(),
  ttlMs = Number(env.AGY_LIVE_COMPACT_UPDATE_TTL_MS) > 0 ? Number(env.AGY_LIVE_COMPACT_UPDATE_TTL_MS) : DEFAULT_TTL_MS,
  spawnRefresh = defaultSpawnRefresh,
} = {}) {
  const meta = readLocalPluginMeta(pluginRoot);
  if (env.AGY_LIVE_COMPACT_DISABLED === "1" || env.AGY_LIVE_COMPACT_NO_UPDATE_CHECK === "1") {
    return { showNotice: false, reason: "disabled", currentVersion: meta.version };
  }

  const cache = loadUpdateCache(cachePath);
  const checkedAtMs = Number(cache?.checkedAtMs) || 0;
  const stale = !checkedAtMs || nowMs - checkedAtMs >= ttlMs;

  if (stale) {
    // Stamp attempt timestamp lightly only inside the background worker, so hook stays read-only & fast.
    spawnRefresh(cachePath);
  }

  const latestVersion = typeof cache?.latestVersion === "string" ? cache.latestVersion.trim() : "";
  if (!latestVersion) {
    return { showNotice: false, reason: stale ? "refreshing" : "no-remote-version", currentVersion: meta.version };
  }

  const cmp = compareVersions(latestVersion, meta.version);
  if (cmp === null || cmp <= 0) {
    return {
      showNotice: false,
      reason: "up-to-date",
      currentVersion: meta.version,
      latestVersion,
    };
  }

  const releaseUrl = cache?.releaseUrl || `https://github.com/${meta.repo}`;
  const summary = typeof cache?.summary === "string" ? cache.summary : "";
  return {
    showNotice: true,
    currentVersion: meta.version,
    latestVersion,
    releaseUrl,
    summary,
    userMarkdown: formatUpdateMarkdown({
      currentVersion: meta.version,
      latestVersion,
      releaseUrl,
      summary,
      pluginRoot: meta.pluginRoot,
    }),
  };
}

export function getCachedUpdateStatus({ env = process.env, pluginRoot = PLUGIN_ROOT, cachePath = updateCachePath(env) } = {}) {
  const meta = readLocalPluginMeta(pluginRoot);
  const cache = loadUpdateCache(cachePath);
  const latestVersion = typeof cache?.latestVersion === "string" ? cache.latestVersion : null;
  const cmp = latestVersion ? compareVersions(latestVersion, meta.version) : null;
  const updateAvailable = cmp !== null && cmp > 0;
  return {
    currentVersion: meta.version,
    latestVersion,
    updateAvailable,
    releaseUrl: cache?.releaseUrl || (latestVersion ? `https://github.com/${meta.repo}` : null),
    checkedAt: cache?.checkedAt || null,
    updateCommand: `node "${join(meta.pluginRoot, "scripts", "update-check.mjs")}" --apply`,
  };
}

export async function refreshUpdateCache({ cachePath = updateCachePath(), pluginRoot = PLUGIN_ROOT, fetcher = fetch } = {}) {
  const meta = readLocalPluginMeta(pluginRoot);
  const prev = loadUpdateCache(cachePath) || {};
  const result = await fetchLatestVersion({ repo: meta.repo, currentVersion: meta.version, fetcher });
  const now = Date.now();
  if (result.ok) {
    const next = {
      checkedAtMs: now,
      checkedAt: new Date(now).toISOString(),
      repo: meta.repo,
      source: result.source,
      latestVersion: result.latestVersion,
      releaseUrl: result.releaseUrl,
      summary: result.summary || "",
    };
    saveUpdateCache(cachePath, next);
    return { ...result, currentVersion: meta.version, cache: next };
  }
  // Keep previous known latestVersion if transient network failure occurs, and back off 1 hour.
  const backoff = {
    ...prev,
    checkedAtMs: now - Math.max(0, DEFAULT_TTL_MS - RETRY_BACKOFF_MS),
    checkedAt: new Date(now).toISOString(),
    lastError: result.error || "network-unavailable",
  };
  saveUpdateCache(cachePath, backoff);
  return { ...result, currentVersion: meta.version, cache: backoff };
}

function runGit(args, cwd) {
  const cleanEnv = { ...process.env };
  let res = spawnSync("git", args, { cwd, env: cleanEnv, encoding: "utf8" });
  if (res.status !== 0 && /Failed to connect|Could not resolve proxy|proxy/i.test(`${res.stderr || ""}${res.stdout || ""}`)) {
    delete cleanEnv.HTTP_PROXY;
    delete cleanEnv.HTTPS_PROXY;
    delete cleanEnv.ALL_PROXY;
    delete cleanEnv.http_proxy;
    delete cleanEnv.https_proxy;
    delete cleanEnv.all_proxy;
    res = spawnSync("git", ["-c", "http.proxy=", "-c", "https.proxy=", ...args], {
      cwd,
      env: cleanEnv,
      encoding: "utf8",
    });
  }
  return res;
}

const SYNC_ENTRIES = [
  "plugin.json",
  "hooks.json",
  "mcp_config.json",
  "README.md",
  "LICENSE",
  ".gitignore",
  "assets",
  "contrib",
  "rules",
  "skills",
  "scripts",
];

function applySelfUpdate({ pluginRoot = PLUGIN_ROOT, cachePath = updateCachePath() } = {}) {
  const meta = readLocalPluginMeta(pluginRoot);
  const beforeVer = meta.version;
  const repoUrl = `https://github.com/${meta.repo}.git`;

  if (existsSync(join(pluginRoot, ".git"))) {
    const pull = runGit(["pull", "--ff-only"], pluginRoot);
    if (pull.status !== 0) {
      throw new Error(`git pull failed: ${(pull.stderr || pull.stdout || "").trim()}`);
    }
  } else {
    const staging = mkdtempSync(join(tmpdir(), "agy-lc-upgrade-"));
    try {
      const clone = runGit(["clone", "--depth", "1", "--branch", "main", repoUrl, staging], tmpdir());
      if (clone.status !== 0) {
        throw new Error(`git clone failed: ${(clone.stderr || clone.stdout || "").trim()}`);
      }
      for (const rel of SYNC_ENTRIES) {
        const src = join(staging, rel);
        if (!existsSync(src)) continue;
        cpSync(src, join(pluginRoot, rel), { recursive: true, force: true });
      }
    } finally {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {}
    }
  }

  const afterMeta = readLocalPluginMeta(pluginRoot);
  const testRun = spawnSync(process.execPath, [join(pluginRoot, "scripts", "self-test.mjs")], {
    cwd: pluginRoot,
    encoding: "utf8",
  });
  if (testRun.status !== 0) {
    throw new Error(`self-test failed after upgrade:\n${testRun.stdout}\n${testRun.stderr}`);
  }

  const now = Date.now();
  saveUpdateCache(cachePath, {
    checkedAtMs: now,
    checkedAt: new Date(now).toISOString(),
    repo: afterMeta.repo,
    source: "self-update",
    latestVersion: afterMeta.version,
    releaseUrl: `https://github.com/${afterMeta.repo}/releases/tag/v${afterMeta.version}`,
    summary: "",
  });

  return { beforeVersion: beforeVer, afterVersion: afterMeta.version, pluginRoot };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--refresh") {
    const targetCache = args[1] || updateCachePath();
    await refreshUpdateCache({ cachePath: targetCache });
    return;
  }

  if (args[0] === "--check") {
    const res = await refreshUpdateCache();
    const cmp = res.latestVersion ? compareVersions(res.latestVersion, res.currentVersion) : null;
    console.log(
      JSON.stringify(
        {
          ok: res.ok,
          currentVersion: res.currentVersion,
          latestVersion: res.latestVersion || null,
          updateAvailable: cmp !== null && cmp > 0,
          source: res.source || null,
          releaseUrl: res.releaseUrl || null,
          summary: res.summary || "",
        },
        null,
        2,
      ),
    );
    return;
  }

  if (args[0] === "--apply") {
    const res = applySelfUpdate();
    console.log(
      `Live Compact updated successfully: v${res.beforeVersion} -> v${res.afterVersion} (${res.pluginRoot})\nRestart or open a new session for updated hooks/MCP to reload.`,
    );
    return;
  }

  console.log("Usage: node scripts/update-check.mjs [--check | --apply | --refresh <cachePath>]");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    process.stderr.write(`live-compact update-check error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
