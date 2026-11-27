#!/usr/bin/env node
/**
 * Antigravity Baton-Relay Helper (scripts/relay-session.mjs)
 *
 * Calls local Connect HTTP+JSON `ConversationService/CreateConversation` directly
 * via `node:http` (bypasses HTTP_PROXY and Windows PowerShell UTF-8 CLI mangling),
 * inherits `$ANTIGRAVITY_PROJECT_ID`, links `$ANTIGRAVITY_CONVERSATION_ID`, and
 * prints `{ ok, conversationId, link, markdownLink }`.
 *
 * Usage:
 *   1. Pipe JSON via stdin (recommended):
 *      @'
 *      {"title":"Next phase title","model":"pro","prompt":"Structured handoff brief..."}
 *      '@ | node "$HOME/.gemini/config/plugins/live-compact/scripts/relay-session.mjs"
 *
 *   2. Pipe plain-text handoff prompt via stdin:
 *      @' ... '@ | node "$HOME/.gemini/config/plugins/live-compact/scripts/relay-session.mjs" --title "Phase 2"
 *
 *   3. Self-test (ephemeral mock server, zero side effects):
 *      node "$HOME/.gemini/config/plugins/live-compact/scripts/relay-session.mjs" --self-test
 */

import http from "node:http";
import fs from "node:fs";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = { selfTest: false, title: "", model: "", projectId: "", prompt: "", file: "", tags: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--self-test") out.selfTest = true;
    else if (a === "--title" && i + 1 < argv.length) out.title = argv[++i];
    else if (a === "--model" && i + 1 < argv.length) out.model = argv[++i];
    else if (a === "--project-id" && i + 1 < argv.length) out.projectId = argv[++i];
    else if (a === "--prompt" && i + 1 < argv.length) out.prompt = argv[++i];
    else if ((a === "--file" || a === "--json-file" || a === "--prompt-file") && i + 1 < argv.length) out.file = argv[++i];
    else if (a === "--tag" && i + 1 < argv.length) out.tags.push(argv[++i]);
  }
  return out;
}

function readStdinUtf8() {
  return new Promise((resolveDone, reject) => {
    if (process.stdin.isTTY) {
      resolveDone("");
      return;
    }
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    process.stdin.on("end", () => resolveDone(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function normalizePromptItems(rawPrompt, parentConversationId) {
  let text = "";
  if (Array.isArray(rawPrompt)) {
    const items = rawPrompt
      .map((item) => (typeof item === "string" ? { text: item } : item && typeof item.text === "string" ? { text: item.text } : null))
      .filter(Boolean);
    if (items.length === 0) return [];
    if (parentConversationId && !items.some((x) => x.text.includes(parentConversationId))) {
      items[0] = {
        text: `Prior session: [${parentConversationId.slice(0, 8)}](conversation://${parentConversationId})\n\n${items[0].text}`,
      };
    }
    return items;
  }
  if (typeof rawPrompt === "string") {
    text = rawPrompt.trim();
  }
  if (!text) return [];
  if (parentConversationId && !text.includes(parentConversationId)) {
    text = `Prior session: [${parentConversationId.slice(0, 8)}](conversation://${parentConversationId})\n\n${text}`;
  }
  return [{ text }];
}

export function buildCreatePayload(input, env = process.env) {
  const projectId = (input.projectId || env.ANTIGRAVITY_PROJECT_ID || "").trim();
  const parentId = (input.parentConversationId ?? env.ANTIGRAVITY_CONVERSATION_ID ?? "").trim();
  const model = (input.model || "pro").trim();
  const title = (input.title || "").trim();
  const tags = Array.isArray(input.tags) && input.tags.length > 0 ? input.tags : ["relay"];
  const promptItems = normalizePromptItems(input.prompt, parentId);

  const body = { model, tags };
  if (projectId) body.projectId = projectId;
  if (input.environmentId) body.environmentId = String(input.environmentId).trim();
  if (title) body.title = title;
  if (promptItems.length > 0) body.prompt = promptItems;
  return body;
}

export function postCreateConversation({ lsAddress, csrfToken, body }) {
  return new Promise((resolveDone, reject) => {
    if (!lsAddress) {
      reject(new Error("Missing ANTIGRAVITY_LS_ADDRESS in environment."));
      return;
    }
    if (!csrfToken) {
      reject(new Error("Missing ANTIGRAVITY_CSRF_TOKEN in environment."));
      return;
    }
    const targetUrl = new URL(
      lsAddress.startsWith("http://") || lsAddress.startsWith("https://")
        ? `${lsAddress.replace(/\/+$/, "")}/product.v1.ConversationService/CreateConversation`
        : `http://${lsAddress}/product.v1.ConversationService/CreateConversation`
    );
    const bodyBuf = Buffer.from(JSON.stringify(body), "utf8");

    const req = http.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname.replace(/^\[|\]$/g, ""),
        port: targetUrl.port,
        path: targetUrl.pathname,
        method: "POST",
        agent: false,
        timeout: 15000,
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "x-antigravity-csrf-token": csrfToken,
          "Content-Length": String(bodyBuf.length),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            const sandboxBlocked =
              status === 403 || /not allowed for HTTP|sandbox|EPERM|EACCES/i.test(raw);
            const err = new Error(`CreateConversation HTTP ${status}: ${raw.slice(0, 500)}`);
            err.statusCode = status;
            err.sandboxBlocked = sandboxBlocked;
            reject(err);
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            const conv = parsed?.conversation || parsed;
            const id = conv?.id || "";
            if (!id) {
              reject(new Error(`CreateConversation succeeded but returned no conversation.id: ${raw.slice(0, 300)}`));
              return;
            }
            resolveDone({
              ok: true,
              conversationId: id,
              projectId: body.projectId || null,
              model: body.model,
              title: body.title || null,
              link: `conversation://${id}`,
              markdownLink: `[点击进入接力会话](conversation://${id})`,
            });
          } catch (parseErr) {
            reject(new Error(`Invalid JSON from CreateConversation: ${parseErr.message}; raw=${raw.slice(0, 300)}`));
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("CreateConversation request timed out after 15s"));
    });
    req.on("error", (err) => {
      err.sandboxBlocked = ["EPERM", "EACCES", "ECONNREFUSED"].includes(err.code || "");
      reject(err);
    });

    req.write(bodyBuf);
    req.end();
  });
}

export async function runSelfTest() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(bodyText),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ conversation: { id: "11111111-2222-3333-4444-555555555555" } }));
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const lsAddress = `127.0.0.1:${addr.port}`;
  try {
    const body = buildCreatePayload(
      {
        title: "接力：验证中文 UTF-8 与项目继承",
        prompt: "## 已完成\n- 规则升级\n## 下一步\n- 继续验证",
      },
      {
        ANTIGRAVITY_PROJECT_ID: "proj-test-001",
        ANTIGRAVITY_CONVERSATION_ID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      }
    );
    const result = await postCreateConversation({
      lsAddress,
      csrfToken: "csrf-test-token",
      body,
    });

    assert.equal(result.ok, true);
    assert.equal(result.conversationId, "11111111-2222-3333-4444-555555555555");
    assert.equal(result.markdownLink, "[点击进入接力会话](conversation://11111111-2222-3333-4444-555555555555)");
    assert.equal(received.length, 1);
    assert.equal(received[0].url, "/product.v1.ConversationService/CreateConversation");
    assert.equal(received[0].headers["connect-protocol-version"], "1");
    assert.equal(received[0].headers["x-antigravity-csrf-token"], "csrf-test-token");
    assert.equal(received[0].body.projectId, "proj-test-001");
    assert.equal(received[0].body.model, "pro");
    assert.equal(received[0].body.title, "接力：验证中文 UTF-8 与项目继承");
    assert.ok(received[0].body.prompt[0].text.includes("conversation://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
    assert.ok(received[0].body.prompt[0].text.includes("验证"));

    return { ok: true, selfTest: "PASSED", sampleResult: result };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    const res = await runSelfTest();
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  let rawInput = "";
  if (args.file) {
    rawInput = fs.readFileSync(args.file, "utf8");
  } else {
    rawInput = await readStdinUtf8();
  }

  let parsed = {};
  const trimmed = rawInput.replace(/^\uFEFF/, "").trim();
  if (trimmed.startsWith("{")) {
    parsed = JSON.parse(trimmed);
  } else if (trimmed) {
    parsed = { prompt: trimmed };
  }

  const merged = {
    ...parsed,
    title: args.title || parsed.title || "",
    model: args.model || parsed.model || "pro",
    projectId: args.projectId || parsed.projectId || "",
    prompt: args.prompt || parsed.prompt || "",
    tags: args.tags.length > 0 ? args.tags : parsed.tags,
  };

  if (!merged.prompt || (Array.isArray(merged.prompt) && merged.prompt.length === 0)) {
    throw new Error("Empty relay prompt: pass JSON {\"title\",\"prompt\"} on stdin or --prompt \"...\".");
  }

  const body = buildCreatePayload(merged, process.env);
  const res = await postCreateConversation({
    lsAddress: process.env.ANTIGRAVITY_LS_ADDRESS,
    csrfToken: process.env.ANTIGRAVITY_CSRF_TOKEN,
    body,
  });
  console.log(JSON.stringify(res, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: err.message || String(err),
          sandboxBlocked: Boolean(err.sandboxBlocked),
          hint: err.sandboxBlocked
            ? "Local ConversationService port was blocked by sandbox; rerun this exact command outside the sandbox."
            : undefined,
        },
        null,
        2
      )
    );
    process.exit(1);
  });
}
