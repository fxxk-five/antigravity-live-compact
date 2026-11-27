#!/usr/bin/env node
/**
 * Zero-dependency stdio MCP server for Antigravity Live Compact shadow recall.
 * Implements JSON-RPC 2.0 over newline-delimited stdio (with Content-Length fallback).
 */
import { readShadowLines, readShadowStats, searchShadow, shadowRootDir } from "./shadow.mjs";

const SERVER_INFO = {
  name: "live-compact-shadow",
  version: "1.0.0",
};

const TOOLS = [
  {
    name: "shadow_search",
    description:
      "Search omitted original tool output archived by Live Compact using a keyword or regular expression. Returns matching line numbers and optional surrounding context lines without loading the entire backup into context.",
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
];

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

function handleToolCall(name, args = {}) {
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
    const moreHint = res.hasMore
      ? ` (more lines available; nextStartLine=${res.nextStartLine}${res.byteCapped ? ", capped <=8.5KB inline" : ""})`
      : "";
    const header = `[Shadow Read] ${res.shadowId} | lines ${res.startLine}-${res.endLine} of ${res.totalLines}${moreHint}\nSource: ${res.sourceLabel}`;
    return {
      content: [{ type: "text", text: `${header}\n${res.content}` }],
    };
  }

  if (name === "shadow_stats") {
    const res = readShadowStats({
      root,
      conversationId: args.conversationId || "",
    });
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
    };
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
}

function handleRequest(req) {
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

  if (method === "tools/call") {
    try {
      const result = handleToolCall(params?.name, params?.arguments || {});
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
    // Detect Content-Length header framing vs NDJSON
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
      try { handleRequest(JSON.parse(body)); } catch {}
      continue;
    }

    const nl = buffer.indexOf("\n");
    if (nl < 0) return;
    const line = buffer.subarray(0, nl).toString("utf8").trim();
    buffer = buffer.subarray(nl + 1);
    if (!line) continue;
    try { handleRequest(JSON.parse(line)); } catch {}
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

process.stdin.on("end", () => {
  process.exit(0);
});
