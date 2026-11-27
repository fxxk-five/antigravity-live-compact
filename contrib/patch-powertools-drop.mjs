#!/usr/bin/env node
/**
 * Idempotent installer, verifier & restore tool for Agy Powertools Smart Composer Drop/Paste Guard.
 *
 * Converts all non-image local files (code, logs, .jsonl, .md, PDF, Office, archives, binaries),
 * local folders, and >4MB images dropped OR Ctrl+V pasted into Antigravity's chat composer into
 * lightweight `@file` / `@directory` URI mentions (~20 tokens) instead of full inline Media Uploads,
 * while keeping <=4MB screenshots/images uploading inline as normal (hold Alt while dropping to bypass).
 * Also sets `contextLimit: 256000` in Agy Powertools settings if currently 0 (unlimited).
 *
 * Usage:
 *   node contrib/patch-powertools-drop.mjs --apply
 *   node contrib/patch-powertools-drop.mjs --check
 *   node contrib/patch-powertools-drop.mjs --restore
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const PATCH_MARKER = "AGY_SAFE_COMPOSER_DROP_V1";

const PATCHED_COMPOSER_DROP_MJS = `// ${PATCH_MARKER}: Smart local file drag-and-drop & paste guard -> insert native @file/@directory mention in chat composer.
// NOTE: Only \`export function\` declarations are used here because native-host.mjs strips \`export function\` -> \`function\` when bundling.

const COMPOSER_OVERSIZED_THRESHOLD_BYTES = 20 * 1024 * 1024;
const COMPOSER_INLINE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const COMPOSER_INLINE_IMAGE_EXT_RE = /\\.(?:png|jpe?g|gif|webp|bmp)$/i;
const COMPOSER_INLINE_IMAGE_MIME_RE = /^image\\/(?:png|jpeg|gif|webp|bmp)$/i;
const COMPOSER_SIDEBAR_SELECTOR = 'aside, [role="navigation"][aria-label="Sidebar"], [role="navigation"][data-agy-original-aria-label="Sidebar"], [data-testid="sidebar-navigation-items"], [data-testid="agy-management-trigger"], .bg-sidebar';
const COMPOSER_DIRECT_SELECTOR = '[data-testid="agent-input-box"], [aria-label="Message input"], [data-agy-original-aria-label="Message input"], [data-testid="agy-inline-edit-host"]';
const COMPOSER_VIEW_SELECTOR = '[data-testid="conversation-view"]';
const COMPOSER_EXCLUDED_SELECTOR = '.xterm, .monaco-editor, .monaco-diff-editor, [role="tree"], [role="treeitem"], [data-testid="overview-panel-host"], [data-testid="agy-powertools-page"], [data-agy-powertools-root]';
const COMPOSER_DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"]';

export function composerOversizedThresholdBytes() {
  return COMPOSER_INLINE_IMAGE_MAX_BYTES;
}

function composerDecodeSafe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function composerBasename(rawPath) {
  const clean = String(rawPath || '').replace(/[\\\\/]+$/, '');
  if (!clean) return '';
  const parts = clean.split(/[\\\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

export function composerPathToFileUri(rawPath) {
  const input = String(rawPath || '').trim();
  if (!input || /[\\x00-\\x1f\\x7f]/.test(input) || /^(?:\\\\\\\\|\\/\\/)[?.][\\\\/]/.test(input)) return '';

  if (/^file:\\/\\//i.test(input)) {
    const clean = input.split('#')[0].split('?')[0];
    try {
      const u = new URL(clean);
      let host = (u.hostname || '').toLowerCase();
      if (host === 'localhost') host = '';
      const decodedPath = composerDecodeSafe(u.pathname || '/').replace(/^\\/([A-Za-z]):(?=\\/|$)/, (_, d) => \`/\${d.toLowerCase()}:\`);
      const rawSegs = decodedPath.split('/').filter(Boolean);
      if (!rawSegs.length) return '';
      if (/^[a-z]:$/i.test(rawSegs[0])) {
        const drive = rawSegs[0][0].toLowerCase();
        const rest = rawSegs.slice(1).map(encodeURIComponent);
        return rest.length ? \`file:///\${drive}%3A/\${rest.join('/')}\` : '';
      }
      const encodedSegs = rawSegs.map(encodeURIComponent);
      const hostPart = host ? encodeURIComponent(host) : '';
      return \`file://\${hostPart}/\${encodedSegs.join('/')}\`;
    } catch {
      return '';
    }
  }

  // UNC path: \\\\server\\share\\file.bin or //server/share/file.bin
  if (/^(?:\\\\\\\\|\\/\\/)[^\\\\/]+[\\\\/][^\\\\/]+/.test(input)) {
    const normalized = input.replace(/\\\\/g, '/').replace(/^\\/+/, '');
    const slash = normalized.indexOf('/');
    const host = slash === -1 ? normalized : normalized.slice(0, slash);
    const rest = slash === -1 ? '' : normalized.slice(slash + 1);
    const segs = rest.split('/').filter(Boolean).map(encodeURIComponent);
    if (!host || !segs.length) return '';
    return \`file://\${encodeURIComponent(host.toLowerCase())}/\${segs.join('/')}\`;
  }

  if (input.startsWith('//')) return '';

  // Windows drive path: C:\\Users\\name\\big file #1.mp4 or C:/Users/name/big.mp4
  const winDrive = /^([A-Za-z]):[\\\\/](.*)$/.exec(input);
  if (winDrive) {
    const drive = winDrive[1].toLowerCase();
    const segs = String(winDrive[2] || '').replace(/\\\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent);
    return segs.length ? \`file:///\${drive}%3A/\${segs.join('/')}\` : '';
  }

  // POSIX absolute path: /Users/name/big file #1.mp4
  if (input.startsWith('/')) {
    const segs = input.split('/').filter(Boolean).map(encodeURIComponent);
    return segs.length ? \`file:///\${segs.join('/')}\` : '';
  }

  return '';
}

export function isComposerExternalFileDrag(dataTransfer, internalDragActive = false) {
  if (!dataTransfer || internalDragActive) return false;
  const types = dataTransfer.types;
  if (types) {
    if (typeof types.contains === 'function' && types.contains('Files')) return true;
    try {
      if (Array.from(types).includes('Files')) return true;
    } catch {}
  }
  return Boolean(dataTransfer.files?.length);
}

export function composerIsInlineSafeImage(file, rawPath = '', maxImageBytes = COMPOSER_INLINE_IMAGE_MAX_BYTES) {
  if (!file) return false;
  const name = String(file.name || composerBasename(rawPath) || '').trim();
  const mime = String(file.type || '').trim();
  const isRasterImage = COMPOSER_INLINE_IMAGE_EXT_RE.test(name) || COMPOSER_INLINE_IMAGE_MIME_RE.test(mime);
  if (!isRasterImage) return false;
  const size = Number(file.size);
  if (!Number.isFinite(size) || size < 0) return true;
  return size <= maxImageBytes;
}

function composerPointInElement(el, event) {
  if (!el || !event || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return false;
  if (typeof el.getBoundingClientRect !== 'function') return false;
  const rect = el.getBoundingClientRect();
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return false;
  const right = Number.isFinite(rect.right) ? rect.right : (rect.left + rect.width);
  const bottom = Number.isFinite(rect.bottom) ? rect.bottom : (rect.top + rect.height);
  return (
    event.clientX >= rect.left && event.clientX <= right &&
    event.clientY >= rect.top && event.clientY <= bottom
  );
}

export function isComposerSidebarTarget(doc, target, event) {
  if (target?.closest?.(COMPOSER_SIDEBAR_SELECTOR)) return true;
  if (!doc) return false;
  const sidebar = doc.querySelector?.('[role="navigation"][aria-label="Sidebar"], [role="navigation"][data-agy-original-aria-label="Sidebar"], aside')
    || doc.querySelector?.('[data-testid="sidebar-navigation-items"], [data-testid="agy-management-trigger"]')?.closest?.('[role="navigation"], .bg-sidebar, aside')
    || null;
  if (sidebar && composerPointInElement(sidebar, event)) return true;
  return false;
}

export function findComposerDropTarget(doc, target, event) {
  if (!doc) return null;
  if (isComposerSidebarTarget(doc, target, event)) return null;

  const direct = target?.closest?.(COMPOSER_DIRECT_SELECTOR);
  if (direct) return direct;

  if (target?.closest?.(COMPOSER_EXCLUDED_SELECTOR)) return null;

  const dialog = target?.closest?.(COMPOSER_DIALOG_SELECTOR);
  if (dialog) {
    return dialog.querySelector?.(COMPOSER_DIRECT_SELECTOR) || null;
  }

  const view = target?.closest?.(COMPOSER_VIEW_SELECTOR);
  if (view) {
    return view.querySelector?.(COMPOSER_DIRECT_SELECTOR) || view;
  }

  const main = target?.closest?.('main');
  if (main) {
    const input = main.querySelector?.(COMPOSER_DIRECT_SELECTOR);
    if (input) return input;
  }

  if (event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
    const candidates = typeof doc.querySelectorAll === 'function'
      ? [...doc.querySelectorAll(\`\${COMPOSER_DIRECT_SELECTOR}, \${COMPOSER_VIEW_SELECTOR}\`)]
      : [doc.querySelector?.(COMPOSER_DIRECT_SELECTOR), doc.querySelector?.(COMPOSER_VIEW_SELECTOR)].filter(Boolean);
    for (const el of candidates) {
      if (composerPointInElement(el, event)) {
        return el.querySelector?.(COMPOSER_DIRECT_SELECTOR) || el;
      }
    }
  }

  return null;
}

export function partitionDroppedComposerFiles(dataTransfer, { getPathForFile, maxBytes = COMPOSER_INLINE_IMAGE_MAX_BYTES } = {}) {
  const oversizedRefs = [];
  const normalFiles = [];
  const unresolvedOversized = [];
  if (!dataTransfer) return { oversizedRefs, normalFiles, unresolvedOversized };

  const imageThreshold = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
    ? Number(maxBytes)
    : COMPOSER_INLINE_IMAGE_MAX_BYTES;
  const files = Array.from(dataTransfer.files || []);
  const fileItems = Array.from(dataTransfer.items || []).filter(item => !item?.kind || item.kind === 'file');
  const count = Math.max(files.length, fileItems.length);
  const seenUris = new Set();

  for (let i = 0; i < count; i++) {
    const item = fileItems[i] || null;
    let file = files[i] || null;
    if (!file && typeof item?.getAsFile === 'function') {
      try { file = item.getAsFile() || null; } catch {}
    }
    if (!file) continue;

    let entry = null;
    if (typeof item?.webkitGetAsEntry === 'function') {
      try { entry = item.webkitGetAsEntry() || null; } catch {}
    }
    const isDir = Boolean(entry?.isDirectory);
    const size = Number(file.size);

    let rawPath = '';
    if (typeof getPathForFile === 'function') {
      try { rawPath = String(getPathForFile(file) || ''); } catch {}
    }
    if (!rawPath && typeof file.path === 'string') rawPath = file.path;
    rawPath = rawPath.trim();

    // Pure in-memory clipboard images (e.g. Win+Shift+S screenshot with no disk path) or <=4MB local images stay inline.
    if (!isDir && (!rawPath || composerIsInlineSafeImage(file, rawPath, imageThreshold))) {
      if (!rawPath && Number.isFinite(size) && size > COMPOSER_OVERSIZED_THRESHOLD_BYTES) {
        unresolvedOversized.push(file);
      } else {
        normalFiles.push(file);
      }
      continue;
    }

    const uri = rawPath ? composerPathToFileUri(rawPath) : '';
    if (!uri) {
      normalFiles.push(file);
      continue;
    }

    if (seenUris.has(uri)) continue;
    seenUris.add(uri);
    oversizedRefs.push({
      file,
      path: rawPath,
      uri,
      name: String(file.name || composerBasename(rawPath) || '').trim(),
      size: Number.isFinite(size) ? size : 0,
      isDirectory: isDir
    });
  }

  return { oversizedRefs, normalFiles, unresolvedOversized };
}

function composerDismissNativeOverlay(target, doc) {
  if (!target || typeof target.dispatchEvent !== 'function') return;
  const view = doc?.defaultView || (typeof window !== 'undefined' ? window : null);
  const DragEvt = view?.DragEvent || (typeof DragEvent === 'function' ? DragEvent : null);
  const Evt = view?.Event || (typeof Event === 'function' ? Event : null);
  const DT = view?.DataTransfer || (typeof DataTransfer === 'function' ? DataTransfer : null);
  try {
    if (DragEvt) {
      const emptyDt = DT ? new DT() : undefined;
      target.dispatchEvent(new DragEvt('dragleave', { bubbles: true, cancelable: true, relatedTarget: null, ...(emptyDt ? { dataTransfer: emptyDt } : {}) }));
      target.dispatchEvent(new DragEvt('dragend', { bubbles: true, cancelable: false, ...(emptyDt ? { dataTransfer: emptyDt } : {}) }));
      if (emptyDt) {
        target.dispatchEvent(new DragEvt('drop', { bubbles: true, cancelable: true, dataTransfer: emptyDt }));
      }
    } else if (Evt) {
      target.dispatchEvent(new Evt('dragleave', { bubbles: true, cancelable: true }));
      target.dispatchEvent(new Evt('dragend', { bubbles: true }));
    }
  } catch {}
}

function composerForwardViaSyntheticDrop(target, doc, files) {
  if (!target || typeof target.dispatchEvent !== 'function' || !files?.length) return false;
  const view = doc?.defaultView || (typeof window !== 'undefined' ? window : null);
  const DragEvt = view?.DragEvent || (typeof DragEvent === 'function' ? DragEvent : null);
  const DT = view?.DataTransfer || (typeof DataTransfer === 'function' ? DataTransfer : null);
  if (!DragEvt || !DT) return false;
  try {
    const dt = new DT();
    for (const file of files) dt.items.add(file);
    target.dispatchEvent(new DragEvt('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  } catch {
    return false;
  }
}

export function installComposerOversizedDrop(document, {
  enabled,
  isSupported,
  maxBytes = COMPOSER_INLINE_IMAGE_MAX_BYTES,
  getPathForFile,
  canInsertReference,
  insertReferences,
  forwardNormalFiles,
  text,
  notify,
  signal
} = {}) {
  if (!document?.addEventListener) return;
  let internalDragActive = false;
  let bypassingSyntheticDrop = false;

  const label = (zh, en) => typeof text === 'function' ? text(zh, en) : en;

  const runBypassing = fn => {
    bypassingSyntheticDrop = true;
    try { return fn(); }
    finally { bypassingSyntheticDrop = false; }
  };

  const onDragStart = () => {
    internalDragActive = true;
  };
  const onDragEnd = () => {
    internalDragActive = false;
  };

  const notifyConverted = (oversizedRefs, forwardedError) => {
    const names = oversizedRefs.map(item => item.name || item.path).filter(Boolean).join(', ');
    const allDirs = oversizedRefs.every(item => item.isDirectory);
    notify?.({
      title: oversizedRefs.length === 1
        ? (allDirs
            ? label('目录已作为安全引用插入', 'Folder inserted as safe reference')
            : label('已转为安全文件引用（按住 Alt 拖入可直传）', 'Inserted as safe file reference (hold Alt to upload raw)'))
        : label('已批量转为安全文件引用', 'Inserted as safe file references'),
      message: names,
      tag: 'agy-composer-oversized-drop'
    });
    if (forwardedError) {
      notify?.({
        title: label('引用到输入框失败', 'Failed to attach file'),
        message: String(forwardedError?.message || ''),
        tag: 'agy-composer-oversized-drop-error'
      });
    }
  };

  const onDrop = async event => {
    if (bypassingSyntheticDrop) return;
    const wasInternal = internalDragActive;
    internalDragActive = false;
    if (event?.defaultPrevented) return;
    // Escape hatch: holding Alt allows explicit native raw media upload when desired.
    if (event?.altKey) return;
    if (typeof enabled === 'function' && !enabled()) return;
    if (typeof isSupported === 'function' && !isSupported()) return;
    if (!isComposerExternalFileDrag(event?.dataTransfer, wasInternal)) return;

    const composerTarget = findComposerDropTarget(document, event.target, event);
    if (!composerTarget) return;

    // Must read DataTransfer files and paths synchronously before any await.
    const { oversizedRefs, normalFiles, unresolvedOversized } = partitionDroppedComposerFiles(event.dataTransfer, {
      getPathForFile,
      maxBytes
    });
    if (!oversizedRefs.length) return;
    if (typeof canInsertReference === 'function' && !canInsertReference(composerTarget)) return;

    event.preventDefault?.();
    event.stopPropagation?.();

    const passthroughFiles = [...normalFiles, ...unresolvedOversized];
    const overlayTarget = event.target || composerTarget;
    let forwardedError = null;

    if (!passthroughFiles.length) {
      runBypassing(() => composerDismissNativeOverlay(overlayTarget, document));
    } else {
      let forwarded = false;
      if (typeof forwardNormalFiles === 'function') {
        try {
          const res = await forwardNormalFiles(passthroughFiles, composerTarget);
          forwarded = res !== false && res?.ok !== false;
        } catch (error) {
          forwardedError = error;
        }
      }
      if (!forwarded && !forwardedError) {
        const syntheticSent = runBypassing(() => composerForwardViaSyntheticDrop(overlayTarget, document, passthroughFiles));
        if (!syntheticSent) runBypassing(() => composerDismissNativeOverlay(overlayTarget, document));
      } else {
        runBypassing(() => composerDismissNativeOverlay(overlayTarget, document));
      }
    }

    if (signal?.aborted) return;

    try {
      await insertReferences?.(oversizedRefs, composerTarget);
      if (signal?.aborted) return;
      notifyConverted(oversizedRefs, forwardedError);
    } catch (error) {
      if (signal?.aborted) return;
      notify?.({
        title: label('引用到输入框失败', 'Failed to attach file'),
        message: String(error?.message || ''),
        tag: 'agy-composer-oversized-drop-error'
      });
    }
  };

  const onPaste = async event => {
    if (event?.defaultPrevented) return;
    if (typeof enabled === 'function' && !enabled()) return;
    if (typeof isSupported === 'function' && !isSupported()) return;
    const cb = event?.clipboardData;
    if (!cb?.files?.length) return;

    // Only intercept file paste directly inside the chat composer input box (never terminal or code editor).
    const composerTarget = event.target?.closest?.(COMPOSER_DIRECT_SELECTOR) || null;
    if (!composerTarget) return;
    if (event.target?.closest?.(COMPOSER_EXCLUDED_SELECTOR)) return;

    const { oversizedRefs, normalFiles, unresolvedOversized } = partitionDroppedComposerFiles(cb, {
      getPathForFile,
      maxBytes
    });
    if (!oversizedRefs.length) return;
    if (typeof canInsertReference === 'function' && !canInsertReference(composerTarget)) return;

    event.preventDefault?.();
    event.stopPropagation?.();

    const passthroughFiles = [...normalFiles, ...unresolvedOversized];
    let forwardedError = null;
    if (passthroughFiles.length && typeof forwardNormalFiles === 'function') {
      try {
        await forwardNormalFiles(passthroughFiles, composerTarget);
      } catch (error) {
        forwardedError = error;
      }
    }

    if (signal?.aborted) return;

    try {
      await insertReferences?.(oversizedRefs, composerTarget);
      if (signal?.aborted) return;
      notifyConverted(oversizedRefs, forwardedError);
    } catch (error) {
      if (signal?.aborted) return;
      notify?.({
        title: label('引用到输入框失败', 'Failed to attach file'),
        message: String(error?.message || ''),
        tag: 'agy-composer-oversized-drop-error'
      });
    }
  };

  document.addEventListener('dragstart', onDragStart, { capture: true, signal });
  document.addEventListener('dragend', onDragEnd, { capture: true, signal });
  document.addEventListener('drop', onDrop, { capture: true, signal });
  document.addEventListener('paste', onPaste, { capture: true, signal });
  const win = document.defaultView || (typeof window !== 'undefined' ? window : null);
  win?.addEventListener?.('blur', onDragEnd, { signal });
}
`;

const UI_TARGET_ORIG = `            await adapter.attachFileToComposer?.({
              mode: 'mention',
              kind: 'file',
              uri: entry.uri,`;

const UI_REPLACEMENT = `            await adapter.attachFileToComposer?.({
              mode: 'mention',
              kind: entry.isDirectory ? 'directory' : 'file',
              isDirectory: Boolean(entry.isDirectory),
              uri: entry.uri,`;

function resolvePaths(home = homedir()) {
  const ptRoot = join(resolve(home), ".gemini", "config", "plugins", "agy-powertools");
  const ptData = join(resolve(home), ".gemini", "antigravity", "plugin_data", "agy-powertools");
  return {
    ptRoot,
    composerDropPath: join(ptRoot, "lib", "native-composer-drop.mjs"),
    nativeUiPath: join(ptRoot, "lib", "native-ui.js"),
    nativeHostPath: join(ptRoot, "lib", "native-host.mjs"),
    settingsPath: join(ptData, "settings.json"),
  };
}

function atomicWriteUtf8(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

async function runVerificationTests(paths) {
  const mod = await import(`${pathToFileURL(paths.composerDropPath).href}?t=${Date.now()}`);

  // 1. 2KB .jsonl / .log / .pdf / .zip from Explorer -> MUST convert to safe @file reference!
  const makeDt = (items) => ({
    types: ["Files"],
    files: items.map((x) => x.file),
    items: items.map((x) => ({
      kind: "file",
      getAsFile: () => x.file,
      webkitGetAsEntry: () => ({ isDirectory: Boolean(x.isDir) }),
    })),
  });

  const dtDangerous = makeDt([
    { file: { name: "transcript.jsonl", size: 2048, type: "application/json", path: "D:\\logs\\transcript.jsonl" } },
    { file: { name: "report.pdf", size: 500 * 1024, type: "application/pdf", path: "D:\\docs\\report.pdf" } },
    { file: { name: "bundle.zip", size: 3 * 1024 * 1024, type: "application/zip", path: "D:\\build\\bundle.zip" } },
    { file: { name: "my-folder", size: 0, type: "", path: "D:\\code\\my-folder" }, isDir: true },
  ]);
  const r1 = mod.partitionDroppedComposerFiles(dtDangerous, { getPathForFile: (f) => f.path || "" });
  assert.equal(r1.oversizedRefs.length, 4, "all 3 non-image files + 1 folder must convert to safe references");
  assert.equal(r1.normalFiles.length, 0, "no non-image local files should pass through as raw media upload");
  assert.equal(r1.oversizedRefs[3].isDirectory, true, "folder drop must preserve isDirectory=true");

  // 2. <=4MB local screenshot (.png) + Win+Shift+S clipboard screenshot (no path) -> MUST stay normal inline image!
  const dtImages = makeDt([
    { file: { name: "ui-shot.png", size: 350 * 1024, type: "image/png", path: "C:\\Users\\test\\Desktop\\ui-shot.png" } },
    { file: { name: "image.png", size: 600 * 1024, type: "image/png", path: "" } },
    { file: { name: "raw-4k.bmp", size: 12 * 1024 * 1024, type: "image/bmp", path: "C:\\Users\\test\\Desktop\\raw-4k.bmp" } },
  ]);
  const r2 = mod.partitionDroppedComposerFiles(dtImages, { getPathForFile: (f) => f.path || "" });
  assert.equal(r2.normalFiles.length, 2, "normal <=4MB screenshot + clipboard screenshot must upload inline");
  assert.equal(r2.oversizedRefs.length, 1, ">4MB huge bitmap must convert to @file reference");
  assert.equal(r2.oversizedRefs[0].name, "raw-4k.bmp");

  // 3. Verify no `export const` / `export let` exists (native-host.mjs only strips `export function`)
  const rawSrc = readFileSync(paths.composerDropPath, "utf8");
  assert.equal(/^\s*export\s+(?!function\b)/m.test(rawSrc), false, "must only use `export function` for native-host bundler compatibility");

  // 4. Compile full nativeSource() browser bundle via Node vm.Script to guarantee 0 SyntaxError in Electron renderer!
  if (existsSync(paths.nativeHostPath)) {
    const hostMod = await import(`${pathToFileURL(paths.nativeHostPath).href}?t=${Date.now()}`);
    const bundleCode = hostMod.nativeSource("vscode-file://vscode-app", []);
    new vm.Script(bundleCode, { filename: "agy-powertools-native-bundle.js" });
  }
}

function checkStatus(paths) {
  const dropOk = existsSync(paths.composerDropPath) && readFileSync(paths.composerDropPath, "utf8").includes(PATCH_MARKER);
  const uiTxt = existsSync(paths.nativeUiPath) ? readFileSync(paths.nativeUiPath, "utf8") : "";
  const uiOk = uiTxt.includes("kind: entry.isDirectory ? 'directory' : 'file'");
  let contextLimit = null;
  if (existsSync(paths.settingsPath)) {
    try { contextLimit = JSON.parse(readFileSync(paths.settingsPath, "utf8")).contextLimit; } catch {}
  }
  return { installed: existsSync(paths.ptRoot), dropPatched: dropOk, uiPatched: uiOk, contextLimit };
}

async function applyPatch(paths) {
  if (!existsSync(paths.composerDropPath) || !existsSync(paths.nativeUiPath)) {
    throw new Error(`agy-powertools not found at ${paths.ptRoot}`);
  }

  // Backup originals once (.orig.bak)
  const dropBak = `${paths.composerDropPath}.orig.bak`;
  const uiBak = `${paths.nativeUiPath}.orig.bak`;
  if (!existsSync(dropBak)) {
    copyFileSync(paths.composerDropPath, dropBak);
  }
  if (!existsSync(uiBak)) {
    copyFileSync(paths.nativeUiPath, uiBak);
  }

  atomicWriteUtf8(paths.composerDropPath, PATCHED_COMPOSER_DROP_MJS);

  const uiContent = readFileSync(paths.nativeUiPath, "utf8");
  const normalizedUi = uiContent.replace(/\r\n/g, "\n");
  if (!normalizedUi.includes("kind: entry.isDirectory ? 'directory' : 'file'")) {
    if (!normalizedUi.includes(UI_TARGET_ORIG)) {
      throw new Error("native-ui.js insertReferences target block not found; agy-powertools structure may have changed");
    }
    const updatedUi = normalizedUi.replace(UI_TARGET_ORIG, UI_REPLACEMENT);
    atomicWriteUtf8(paths.nativeUiPath, uiContent.includes("\r\n") ? updatedUi.replace(/\n/g, "\r\n") : updatedUi);
  }

  // Configure contextLimit = 256000 if currently 0 / unset
  let prevLimit = 0;
  let nextLimit = 256000;
  if (existsSync(paths.settingsPath)) {
    const settings = JSON.parse(readFileSync(paths.settingsPath, "utf8"));
    prevLimit = settings.contextLimit ?? 0;
    if (!settings.contextLimit || settings.contextLimit === 0) {
      settings.contextLimit = 256000;
      atomicWriteUtf8(paths.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    } else {
      nextLimit = settings.contextLimit;
    }
  } else {
    atomicWriteUtf8(paths.settingsPath, `${JSON.stringify({ enabled: true, contextLimit: 256000 }, null, 2)}\n`);
  }

  await runVerificationTests(paths);
  return { ...checkStatus(paths), prevContextLimit: prevLimit, activeContextLimit: nextLimit, verifiedBundleSyntax: true };
}

function restorePatch(paths) {
  const dropBak = `${paths.composerDropPath}.orig.bak`;
  const uiBak = `${paths.nativeUiPath}.orig.bak`;
  let restored = 0;
  if (existsSync(dropBak)) {
    copyFileSync(dropBak, paths.composerDropPath);
    restored++;
  }
  if (existsSync(uiBak)) {
    copyFileSync(uiBak, paths.nativeUiPath);
    restored++;
  }
  return { restoredFiles: restored, ...checkStatus(paths) };
}

const mode = process.argv[2] || "--check";
const paths = resolvePaths();

if (mode === "--apply") {
  const res = await applyPatch(paths);
  console.log(JSON.stringify({ action: "apply", ok: true, ...res }, null, 2));
} else if (mode === "--restore") {
  const res = restorePatch(paths);
  console.log(JSON.stringify({ action: "restore", ok: true, ...res }, null, 2));
} else {
  const st = checkStatus(paths);
  if (st.dropPatched) await runVerificationTests(paths);
  console.log(JSON.stringify({ action: "check", ok: true, ...st }, null, 2));
}
