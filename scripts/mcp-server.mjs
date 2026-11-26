#!/usr/bin/env node
/**
 * Zero-dependency stdio MCP server + MCP App host for Antigravity Live Compact (v2.0).
 * Implements JSON-RPC 2.0 over newline-delimited stdio (with Content-Length fallback),
 * serving:
 *  - Shadow recall tools (`shadow_search`, `shadow_read`, `shadow_stats`)
 *  - Context Doctor & Clean-Slate Session Relay tools (`context_doctor`, `prepare_handoff`)
 *  - Interactive MCP App UI (`ui://live-compact/relay.html` with `aux_pane` entrypoint & app-only tools)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeConversation,
  listRecentSessions,
  prepareAndMaybeLaunchRelay,
  saveHandoffNotes,
} from "./relay.mjs";
import { readShadowLines, readShadowStats, searchShadow, shadowRootDir } from "./shadow.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..");
export const RELAY_APP_URI = "ui://live-compact/relay.html";
export const RELAY_APP_MIME = "text/html;profile=mcp-app";

const SERVER_INFO = {
  name: "live-compact-shadow",
  version: "2.0.0",
};

const TOOLS = [
  {
    name: "shadow_search",
    description:
      "Search omitted original tool output archived by Live Compact using a keyword or regular expression. Returns matching line numbers and optional surrounding context lines without loading the entire backup into context.",
    _meta: {
      ui: { visibility: ["model", "app"] },
    },
    inputSchema: {
      type: "object",
      properties: {
        shadowId: {
          type: "string",
          description: "Shadow backup ID from the Spine Card (e.g. raw-a1b2c3d4e5f60708). Optional if conversationId is given.",
        },
        conversationId: {
          type: "string",
          description: "Optional conversation UUID to search across all shadow backups in that session.",
        },
        pattern: {
          type: "string",
          description: "Keyword or regex pattern to search for.",
        },
        regex: {
          type: "boolean",
          description: "Interpret pattern as a regular expression (default false).",
        },
        ignoreCase: {
          type: "boolean",
          description: "Case-insensitive search (default true).",
        },
        contextLines: {
          type: "integer",
          description: "Number of surrounding context lines before/after each match (0-5, default 1).",
        },
        limit: {
          type: "integer",
          description: "Maximum matches to return (1-100, default 30).",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "shadow_read",
    description:
      "Read a bounded line range (max 150 lines per call) from a Live Compact shadow backup by shadowId.",
    _meta: {
      ui: { visibility: ["model", "app"] },
    },
    inputSchema: {
      type: "object",
      properties: {
        shadowId: {
          type: "string",
          description: "Shadow backup ID from the Spine Card (e.g. raw-a1b2c3d4e5f60708).",
        },
        conversationId: {
          type: "string",
          description: "Optional conversation UUID.",
        },
        startLine: {
          type: "integer",
          description: "1-based start line number (default 1).",
        },
        endLine: {
          type: "integer",
          description: "1-based inclusive end line number (capped at startLine + 149).",
        },
      },
      required: ["shadowId"],
    },
  },
  {
    name: "shadow_stats",
    description:
      "Show Live Compact compression statistics, estimated token savings, context watermark, and recent shadow backup IDs.",
    _meta: {
      ui: { visibility: ["model", "app"] },
    },
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "Optional conversation UUID (defaults to latest active session).",
        },
      },
    },
  },
  {
    name: "context_doctor",
    title: "Live Compact Relay",
    description:
      "Audit a conversation's real-time context watermark, turn-latency inflation, duplicate/stale read waste, and open the interactive Clean-Slate Session Relay panel.",
    _meta: {
      ui: {
        resourceUri: RELAY_APP_URI,
        visibility: ["model", "app"],
      },
      "com.google.antigravity/ui": {
        entrypoints: [
          {
            type: "aux_pane",
            title: "Live Compact Relay",
          },
        ],
      },
    },
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "Optional conversation UUID or prefix (defaults to current/latest active conversation).",
        },
      },
    },
  },
  {
    name: "prepare_handoff",
    title: "Prepare Clean-Slate Handoff",
    description:
      "Build a deterministic, lossless Clean-Slate Session Relay brief (<2.5k tokens, preserving modified files, git status, command exit codes, unfinished steps, and all shadowId cold-memory pointers) plus 3 concise semantic slots, and optionally launch a fresh conversation in the same project.",
    _meta: {
      ui: {
        resourceUri: RELAY_APP_URI,
        visibility: ["model", "app"],
      },
    },
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "Optional conversation UUID or prefix (defaults to current/latest active conversation).",
        },
        nextAction: {
          type: "string",
          description: "Concise immediate next step for the receiving clean-slate session (<= 2 sentences).",
        },
        hypothesis: {
          type: "string",
          description: "Key uncommitted debugging finding, root cause, or architectural state to preserve.",
        },
        redlines: {
          type: "string",
          description: "Critical project constraints or safety redlines that must not be violated.",
        },
        launchNewConversation: {
          type: "boolean",
          description: "Set true when the user asks to immediately create and start the new clean-slate conversation.",
        },
        archiveSource: {
          type: "boolean",
          description: "Optional: archive the bloated source conversation after the relay conversation is created (default false).",
        },
        title: {
          type: "string",
          description: "Optional custom title for the new relay conversation.",
        },
      },
    },
  },
  // App-only private tools (hidden from model -> zero model schema token overhead)
  {
    name: "app_list_sessions",
    description: "List recent conversations with context watermarks for the Live Compact Relay UI.",
    _meta: {
      ui: { visibility: ["app"] },
    },
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "app_inspect_session",
    description: "Inspect a conversation and return structured Context Doctor & Handoff data for the UI.",
    _meta: {
      ui: { visibility: ["app"] },
    },
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
      },
    },
  },
  {
    name: "app_save_notes",
    description: "Save 3-slot semantic notes or reset custom handoff brief from the Live Compact Relay UI.",
    _meta: {
      ui: { visibility: ["app"] },
    },
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        nextAction: { type: "string" },
        hypothesis: { type: "string" },
        redlines: { type: "string" },
        customBrief: { type: "string" },
        resetCustomBrief: { type: "boolean" },
      },
      required: ["conversationId"],
    },
  },
  {
    name: "app_launch_relay",
    description: "Persist final handoff brief and launch a new conversation via ConversationService if reachable.",
    _meta: {
      ui: { visibility: ["app"] },
    },
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        handoffBrief: { type: "string" },
        archiveSource: { type: "boolean" },
        title: { type: "string" },
      },
    },
  },
];

const RESOURCES = [
  {
    uri: RELAY_APP_URI,
    name: "Live Compact Relay",
    description: "Interactive Context Doctor & Clean-Slate Session Relay dashboard",
    mimeType: RELAY_APP_MIME,
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
];

function readRelayAppHtml() {
  const customPath = process.env.AGY_LIVE_COMPACT_APP_HTML?.trim();
  const htmlPath = customPath ? resolve(customPath) : join(PLUGIN_ROOT, "assets", "relay-app.html");
  if (!existsSync(htmlPath)) {
    return "<!DOCTYPE html><html><body><p>relay-app.html not found.</p></body></html>";
  }
  return readFileSync(htmlPath, "utf8");
}

let useContentLengthFraming = false;

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  if (useContentLengthFraming) {
    const bytes = Buffer.byteLength(json, "utf8");
    process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

async function handleToolCall(name, args = {}) {
  const root = shadowRootDir();

  if (name === "shadow_search") {
    const res = searchShadow({
      root,
      conversationId: args.conversationId || "",
      shadowId: args.shadowId || "",
      pattern: args.pattern || "",
      regex: args.regex === true,
      ignoreCase: args.ignoreCase !== false,
      contextLines: args.contextLines ?? 1,
      limit: args.limit ?? 30,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      structuredContent: res,
      isError: res.found === false,
    };
  }

  if (name === "shadow_read") {
    const res = readShadowLines({
      root,
      conversationId: args.conversationId || "",
      shadowId: args.shadowId || "",
      startLine: args.startLine ?? 1,
      endLine: args.endLine ?? 80,
    });
    if (!res.ok) {
      return {
        content: [{ type: "text", text: res.error }],
        isError: true,
      };
    }
    const header = `[Shadow Read] ${res.shadowId} | lines ${res.startLine}-${res.endLine} of ${res.totalLines}${res.hasMore ? " (more lines available)" : ""}\nSource: ${res.sourceLabel}`;
    return {
      content: [{ type: "text", text: `${header}\n${res.content}` }],
      structuredContent: res,
    };
  }

  if (name === "shadow_stats") {
    const res = readShadowStats({
      root,
      conversationId: args.conversationId || "",
    });
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      structuredContent: res,
    };
  }

  if (name === "context_doctor" || name === "app_inspect_session") {
    const sessions = await listRecentSessions({ limit: 12, shadowRoot: root });
    const targetId = args.conversationId || sessions[0]?.conversationId || "";
    const inspected = analyzeConversation(targetId, { shadowRoot: root });
    const summaryText =
      name === "app_inspect_session"
        ? `Inspected ${inspected.report.conversationId}`
        : `${inspected.doctorMarkdown}\n\n[Telemetry] Scanned in ${inspected.elapsedMs}ms | Handoff brief: ~${inspected.metrics.briefTokensEst} tok (${inspected.metrics.compressionRatio}x smaller than peak)`;
    return {
      content: [{ type: "text", text: summaryText }],
      structuredContent: {
        sessions,
        report: inspected.report,
        handoffBrief: inspected.handoffBrief,
        metrics: inspected.metrics,
        elapsedMs: inspected.elapsedMs,
      },
    };
  }

  if (name === "prepare_handoff") {
    const relayRes = await prepareAndMaybeLaunchRelay({
      conversationId: args.conversationId || "",
      hypothesis: args.hypothesis || "",
      redlines: args.redlines || "",
      nextAction: args.nextAction || "",
      launchNewConversation: args.launchNewConversation === true,
      archiveSource: args.archiveSource === true,
      title: args.title || "",
      shadowRoot: root,
    });
    const sessions = await listRecentSessions({ limit: 12, shadowRoot: root });
    const inspected = analyzeConversation(relayRes.sourceConversationId, { shadowRoot: root });
    const statusLine = relayRes.launched
      ? `✅ Clean-Slate Relay conversation created: ${relayRes.newConversationId}`
      : `✅ Clean-Slate Handoff brief prepared (~${relayRes.metrics.briefTokensEst} tokens, saved to ${relayRes.briefPath}). Click "🚀 一键新开干净会话接力" in the Live Compact Relay card/pane to launch.`;
    return {
      content: [{ type: "text", text: `${statusLine}\n\n${relayRes.handoffBrief}` }],
      structuredContent: {
        sessions,
        report: inspected.report,
        handoffBrief: relayRes.handoffBrief,
        metrics: relayRes.metrics,
        relay: relayRes,
      },
    };
  }

  if (name === "app_list_sessions") {
    const sessions = await listRecentSessions({ limit: args.limit || 12, shadowRoot: root });
    return {
      content: [{ type: "text", text: `Listed ${sessions.length} sessions` }],
      structuredContent: { sessions },
    };
  }

  if (name === "app_save_notes") {
    saveHandoffNotes(
      args.conversationId,
      {
        nextAction: args.nextAction,
        hypothesis: args.hypothesis,
        redlines: args.redlines,
        customBrief: args.resetCustomBrief ? "" : args.customBrief,
      },
      root,
    );
    const inspected = analyzeConversation(args.conversationId, { shadowRoot: root });
    return {
      content: [{ type: "text", text: "Saved notes" }],
      structuredContent: {
        report: inspected.report,
        handoffBrief: inspected.handoffBrief,
        metrics: inspected.metrics,
      },
    };
  }

  if (name === "app_launch_relay") {
    const relayRes = await prepareAndMaybeLaunchRelay({
      conversationId: args.conversationId || "",
      customBrief: args.handoffBrief || "",
      launchNewConversation: true,
      archiveSource: args.archiveSource === true,
      title: args.title || "",
      shadowRoot: root,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(relayRes) }],
      structuredContent: relayRes,
    };
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
}

async function handleRequest(req) {
  if (!req || typeof req !== "object") return;
  const { id, method, params } = req;

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return;
  }

  if (method === "initialize") {
    sendMessage({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: {
          tools: {},
          resources: {},
        },
        serverInfo: SERVER_INFO,
      },
    });
    return;
  }

  if (method === "ping") {
    sendMessage({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (method === "tools/list") {
    sendMessage({
      jsonrpc: "2.0",
      id,
      result: { tools: TOOLS },
    });
    return;
  }

  if (method === "resources/list") {
    sendMessage({
      jsonrpc: "2.0",
      id,
      result: { resources: RESOURCES },
    });
    return;
  }

  if (method === "resources/read") {
    const uri = params?.uri || "";
    if (uri === RELAY_APP_URI) {
      sendMessage({
        jsonrpc: "2.0",
        id,
        result: {
          contents: [
            {
              uri: RELAY_APP_URI,
              mimeType: RELAY_APP_MIME,
              text: readRelayAppHtml(),
              _meta: { ui: { prefersBorder: false } },
            },
          ],
        },
      });
      return;
    }
    sendMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: `Unknown resource URI: ${uri}` },
    });
    return;
  }

  if (method === "tools/call") {
    try {
      const result = await handleToolCall(params?.name, params?.arguments || {});
      sendMessage({ jsonrpc: "2.0", id, result });
    } catch (error) {
      sendMessage({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        },
      });
    }
    return;
  }

  if (id !== undefined && id !== null) {
    sendMessage({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

let buffer = Buffer.alloc(0);

function processBuffer() {
  while (buffer.length > 0) {
    const prefix = buffer.subarray(0, Math.min(32, buffer.length)).toString("ascii");
    if (/^Content-Length:/i.test(prefix)) {
      useContentLengthFraming = true;
      const sep = buffer.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const header = buffer.subarray(0, sep).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.subarray(sep + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = sep + 4;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      try {
        void handleRequest(JSON.parse(body));
      } catch {}
      continue;
    }

    const nl = buffer.indexOf("\n");
    if (nl < 0) return;
    const line = buffer.subarray(0, nl).toString("utf8").trim();
    buffer = buffer.subarray(nl + 1);
    if (!line) continue;
    try {
      void handleRequest(JSON.parse(line));
    } catch {}
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

process.stdin.on("end", () => {
  // Allow pending async tool handlers in test/CLI pipelines to flush before exit
  setTimeout(() => process.exit(0), 25);
});
