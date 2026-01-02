/**
 * server.js — Local File Agent MCP Bridge (PURE JS)
 *
 * Node.js v18+에서 바로 실행 가능
 * Agent Builder Remote MCP 대응 (/mcp + /sse)
 */

import http from "node:http";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/* =========================
 * 설정 (환경변수 권장)
 * ========================= */
const LOCAL_FILE_AGENT_BASE_URL =
    process.env.LOCAL_FILE_AGENT_BASE_URL || "http://58.121.142.180:4312";

const PORT = Number(process.env.PORT || 8787);

// Agent Builder에서 헤더 전달 안 될 때 fallback
const DEFAULT_AGENT_TOKEN = process.env.DEFAULT_AGENT_TOKEN || "73025532";

const CORS_ALLOW_ORIGIN = "*";

/* =========================
 * 유틸
 * ========================= */
function now() {
    return new Date().toISOString();
}

function logReq(req) {
    const ip =
        req.headers["x-forwarded-for"] ||
        req.socket.remoteAddress ||
        "";
    console.log(
        `[${now()}] ${ip} ${req.method} ${req.url}`
    );
}

function sendJson(res, status, payload) {
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": CORS_ALLOW_ORIGIN,
        "access-control-allow-headers": "content-type, x-agent-token, authorization",
        "access-control-allow-methods": "GET,POST,OPTIONS",
    });
    res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
    res.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "access-control-allow-origin": CORS_ALLOW_ORIGIN,
        "access-control-allow-headers": "content-type, x-agent-token, authorization",
        "access-control-allow-methods": "GET,POST,OPTIONS",
    });
    res.end(text);
}

function extractToken(headers) {
    // 1) x-agent-token
    const t = headers["x-agent-token"];
    if (typeof t === "string" && t.trim()) return t.trim();
    if (Array.isArray(t) && t[0]) return t[0].trim();

    // 2) Authorization: Bearer
    const auth = headers["authorization"];
    if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
        return auth.slice(7).trim();
    }

    // 3) fallback
    if (DEFAULT_AGENT_TOKEN) return DEFAULT_AGENT_TOKEN;

    return undefined;
}

/* =========================
 * local-file-agent fetch
 * ========================= */
async function lfaFetch(path, opts = {}) {
    const url = `${LOCAL_FILE_AGENT_BASE_URL}${path}`;
    const method = (opts.method || "GET").toUpperCase();
    const token = opts.token;

    const headers = {};
    if (token) headers["x-agent-token"] = token;

    let body;
    if (opts.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, { method, headers, body });
    const text = await res.text();

    let json;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = { raw: text };
    }

    if (!res.ok) {
        const err = new Error(`local-file-agent ${res.status}`);
        err.payload = json;
        throw err;
    }

    return json;
}

/* =========================
 * MCP Server
 * ========================= */
const mcp = new McpServer({
    name: "local-file-agent-bridge",
    version: "1.0.0",
});

/* ---------- Tools ---------- */

// index summary
mcp.tool(
    "lfa_index_summary",
    "Get index summary",
    z.object({}),
    async (_args, ctx) => {
        const token = extractToken(ctx?.request?.headers || {});
        const data = await lfaFetch("/index/summary", { token });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
);

// build index
mcp.tool(
    "lfa_index_build",
    "Build index",
    z.object({}),
    async (_args, ctx) => {
        const token = extractToken(ctx?.request?.headers || {});
        const data = await lfaFetch("/index", {
            method: "POST",
            token,
            body: {},
        });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
);

// search index
mcp.tool(
    "lfa_index_search",
    "Search index",
    z.object({
        pathContains: z.string().optional(),
        exportName: z.string().optional(),
        importContains: z.string().optional(),
        limit: z.number().optional(),
    }),
    async (args, ctx) => {
        const token = extractToken(ctx?.request?.headers || {});
        const qs = new URLSearchParams();
        if (args.pathContains) qs.set("pathContains", args.pathContains);
        if (args.exportName) qs.set("exportName", args.exportName);
        if (args.importContains) qs.set("importContains", args.importContains);
        if (args.limit) qs.set("limit", String(args.limit));

        const data = await lfaFetch(`/index/search?${qs.toString()}`, { token });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
);

// read file
mcp.tool(
    "lfa_file_read",
    "Read file",
    z.object({ path: z.string() }),
    async (args, ctx) => {
        const token = extractToken(ctx?.request?.headers || {});
        const qs = new URLSearchParams({ path: args.path });
        const data = await lfaFetch(`/file?${qs.toString()}`, { token });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
);

// patch batch
mcp.tool(
    "lfa_patch_batch",
    "Patch files",
    z.object({
        dryRun: z.boolean(),
        patches: z.array(
            z.object({
                path: z.string(),
                patch: z.string(),
            })
        ),
    }),
    async (args, ctx) => {
        const token = extractToken(ctx?.request?.headers || {});
        const data = await lfaFetch("/patch-batch", {
            method: "POST",
            token,
            body: args,
        });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
);

/* =========================
 * HTTP Server
 * ========================= */
const server = http.createServer(async (req, res) => {
    logReq(req);

    // CORS preflight
    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "access-control-allow-origin": CORS_ALLOW_ORIGIN,
            "access-control-allow-headers": "content-type, x-agent-token, authorization",
            "access-control-allow-methods": "GET,POST,OPTIONS",
        });
        res.end();
        return;
    }

    if (req.url === "/health") {
        sendJson(res, 200, { ok: true });
        return;
    }

    if (req.url === "/mcp") {
        sendJson(res, 200, {
            protocol: "mcp",
            transport: "streamable-http",
            sseEndpoint: "/sse",
        });
        return;
    }

    if (req.url.startsWith("/sse")) {
        const transport = new StreamableHTTPServerTransport(req, res, {
            requestContext: {
                headers: req.headers,
            },
        });
        await mcp.connect(transport);
        return;
    }

    sendText(res, 404, "Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`MCP Bridge listening on :${PORT}`);
    console.log(`Discovery : http://localhost:${PORT}/mcp`);
    console.log(`SSE       : http://localhost:${PORT}/sse`);
    console.log(`LFA       : ${LOCAL_FILE_AGENT_BASE_URL}`);
});
