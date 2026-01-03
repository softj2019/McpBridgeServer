/**
 * Local File Agent MCP Bridge (Streamable HTTP) - Pure JavaScript
 *
 * ✅ 수정해야 할 부분
 * 1) LOCAL_FILE_AGENT_BASE_URL
 * 2) DEFAULT_AGENT_TOKEN (옵션)
 * 3) 운영 프록시(Nginx/ALB)에서 /sse 스트리밍 타임아웃/버퍼링 해제 필요
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// =========================
// ✅ 수정해야 할 부분 (환경변수 권장)
// =========================
const LOCAL_FILE_AGENT_BASE_URL =
    process.env.LOCAL_FILE_AGENT_BASE_URL || "http://58.121.142.180:4312";
const PORT = Number(process.env.PORT || 8787);

// (옵션) Agent Builder가 토큰을 안 보내는 경우 fallback
const DEFAULT_AGENT_TOKEN = process.env.AGENT_TOKEN || "73025532";

// 로그 레벨: error | info | debug
const LOG_LEVEL = String(process.env.LOG_LEVEL || "info").toLowerCase();

// =========================
// Logging utils
// =========================
function nowISO() {
    return new Date().toISOString();
}
function isDebug() {
    return LOG_LEVEL === "debug";
}
function isInfo() {
    return LOG_LEVEL === "info" || LOG_LEVEL === "debug";
}
function safeStr(v) {
    if (v === undefined || v === null) return "";
    if (Array.isArray(v)) return v[0] || "";
    return String(v);
}
function redact(s) {
    if (!s) return "";
    if (s.length <= 6) return "***";
    return s.slice(0, 3) + "***" + s.slice(-3);
}
function getClientIp(req) {
    const xf = safeStr(req.headers["x-forwarded-for"]);
    if (xf) return xf.split(",")[0].trim();
    return req.socket.remoteAddress || "unknown";
}
function getProto(req) {
    const xfProto = safeStr(req.headers["x-forwarded-proto"]);
    if (xfProto) return xfProto;
    return req.socket.encrypted ? "https" : "http";
}
function getHost(req) {
    return (
        safeStr(req.headers["x-forwarded-host"]) ||
        safeStr(req.headers["host"]) ||
        `localhost:${PORT}`
    );
}
function pickHeaders(req) {
    const ua = safeStr(req.headers["user-agent"]);
    const origin = safeStr(req.headers["origin"]);
    const referer = safeStr(req.headers["referer"]);
    const auth = safeStr(req.headers["authorization"]);
    const token = safeStr(req.headers["x-agent-token"]);
    const xfFor = safeStr(req.headers["x-forwarded-for"]);
    const xfProto = safeStr(req.headers["x-forwarded-proto"]);
    const xfHost = safeStr(req.headers["x-forwarded-host"]);
    const xfPort = safeStr(req.headers["x-forwarded-port"]);

    return {
        "user-agent": ua,
        origin,
        referer,
        authorization: auth ? redact(auth) : "",
        "x-agent-token": token ? redact(token) : "",
        "x-forwarded-for": xfFor,
        "x-forwarded-proto": xfProto,
        "x-forwarded-host": xfHost,
        "x-forwarded-port": xfPort,
    };
}

function logInfo(reqId, msg, obj) {
    if (!isInfo()) return;
    console.log(
        `[${nowISO()}] [INFO] [${reqId}] ${msg}${obj ? " " + JSON.stringify(obj) : ""}`
    );
}
function logDebug(reqId, msg, obj) {
    if (!isDebug()) return;
    console.log(
        `[${nowISO()}] [DEBUG] [${reqId}] ${msg}${obj ? " " + JSON.stringify(obj) : ""}`
    );
}
function logError(reqId, msg, obj) {
    console.error(
        `[${nowISO()}] [ERROR] [${reqId}] ${msg}${obj ? " " + JSON.stringify(obj) : ""}`
    );
}

// =========================
// HTTP helpers
// =========================
function withCors(res) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type,authorization,x-agent-token");
    res.setHeader("cache-control", "no-store");
}

function json(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...extraHeaders,
    });
    res.end(payload);
}

function extractToken(req) {
    const token = safeStr(req.headers["x-agent-token"]).trim();
    if (token) return token;

    const auth = safeStr(req.headers["authorization"]).trim();
    if (auth.toLowerCase().startsWith("bearer ")) {
        const t = auth.slice(7).trim();
        if (t) return t;
    }
    return DEFAULT_AGENT_TOKEN;
}

// =========================
// local-file-agent fetch (logged)
// =========================
async function lfaFetch(path, args = {}) {
    const method = args.method || "GET";
    const token = args.token || "";
    const url = `${LOCAL_FILE_AGENT_BASE_URL}${path}`;
    const reqId = args.reqId || "no-reqid";

    const headers = {};
    if (method === "POST") headers["content-type"] = "application/json";
    if (token) headers["x-agent-token"] = token;

    const start = Date.now();
    logDebug(reqId, "LFA_REQUEST", { method, url, token: token ? redact(token) : "" });

    const res = await fetch(url, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(args.body || {}) : undefined,
    });

    const elapsedMs = Date.now() - start;
    const text = await res.text();

    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = { raw: text };
    }

    logDebug(reqId, "LFA_RESPONSE", { status: res.status, elapsedMs });

    if (!res.ok) {
        logError(reqId, "LFA_ERROR", { status: res.status, elapsedMs, payload: parsed });
        const err = new Error(`local-file-agent error ${res.status}: ${text}`);
        err.status = res.status;
        err.payload = parsed;
        throw err;
    }

    return parsed;
}

// =========================
// MCP server definition
// =========================
const mcp = new McpServer({
    name: "local-file-agent-bridge",
    version: "1.0.0",
});

// Tool: index summary
mcp.tool(
    "lfa_index_summary",
    "Get index cache summary from local-file-agent",
    z.object({}),
    async (_args, ctx) => {
        const reqId = (ctx && ctx.requestContext && ctx.requestContext.reqId) || "no-reqid";
        const token =
            (ctx && ctx.requestContext && ctx.requestContext.headers && ctx.requestContext.headers["x-agent-token"]) ||
            "";
        const data = await lfaFetch("/index/summary", { method: "GET", token, reqId });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
);

// Tool: build index
mcp.tool(
    "lfa_index_build",
    "Build/refresh index cache (POST /index)",
    z.object({}),
    async (_args, ctx) => {
        const reqId = (ctx && ctx.requestContext && ctx.requestContext.reqId) || "no-reqid";
        const token =
            (ctx && ctx.requestContext && ctx.requestContext.headers && ctx.requestContext.headers["x-agent-token"]) ||
            "";
        const data = await lfaFetch("/index", { method: "POST", token, reqId, body: {} });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
);

// Tool: search index
mcp.tool(
    "lfa_index_search",
    "Search index (GET /index/search?...)",
    z.object({
        pathContains: z.string().optional(),
        exportName: z.string().optional(),
        importContains: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
    }),
    async (args, ctx) => {
        const reqId = (ctx && ctx.requestContext && ctx.requestContext.reqId) || "no-reqid";
        const token =
            (ctx && ctx.requestContext && ctx.requestContext.headers && ctx.requestContext.headers["x-agent-token"]) ||
            "";

        const qs = new URLSearchParams();
        if (args.pathContains) qs.set("pathContains", args.pathContains);
        if (args.exportName) qs.set("exportName", args.exportName);
        if (args.importContains) qs.set("importContains", args.importContains);
        if (args.limit) qs.set("limit", String(args.limit));

        const data = await lfaFetch(`/index/search?${qs.toString()}`, { method: "GET", token, reqId });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
);

// Tool: list files
mcp.tool(
    "lfa_files",
    "List files by glob (GET /files?glob=...)",
    z.object({ glob: z.string() }),
    async (args, ctx) => {
        const reqId = (ctx && ctx.requestContext && ctx.requestContext.reqId) || "no-reqid";
        const token =
            (ctx && ctx.requestContext && ctx.requestContext.headers && ctx.requestContext.headers["x-agent-token"]) ||
            "";

        const qs = new URLSearchParams({ glob: args.glob });
        const data = await lfaFetch(`/files?${qs.toString()}`, { method: "GET", token, reqId });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
);

// Tool: read file
mcp.tool(
    "lfa_file_read",
    "Read file by path (GET /file?path=...)",
    z.object({ path: z.string() }),
    async (args, ctx) => {
        const reqId = (ctx && ctx.requestContext && ctx.requestContext.reqId) || "no-reqid";
        const token =
            (ctx && ctx.requestContext && ctx.requestContext.headers && ctx.requestContext.headers["x-agent-token"]) ||
            "";

        const qs = new URLSearchParams({ path: args.path });
        const data = await lfaFetch(`/file?${qs.toString()}`, { method: "GET", token, reqId });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
);

// Tool: patch batch
mcp.tool(
    "lfa_patch_batch",
    "Apply unified diff patches (POST /patch-batch)",
    z.object({
        dryRun: z.boolean(),
        patches: z.array(z.object({ path: z.string(), patch: z.string() })),
    }),
    async (args, ctx) => {
        const reqId = (ctx && ctx.requestContext && ctx.requestContext.reqId) || "no-reqid";
        const token =
            (ctx && ctx.requestContext && ctx.requestContext.headers && ctx.requestContext.headers["x-agent-token"]) ||
            "";

        const data = await lfaFetch("/patch-batch", { method: "POST", token, reqId, body: args });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
);

// =========================
// HTTP server routes
// =========================
const httpServer = http.createServer(async (req, res) => {
    withCors(res);

    const reqId = randomUUID();
    const ip = getClientIp(req);
    const url = req.url || "/";
    const method = req.method || "GET";

    // preflight
    if (method === "OPTIONS") {
        logDebug(reqId, "OPTIONS_PRELIGHT", { ip, url });
        res.writeHead(204);
        res.end();
        return;
    }

    logInfo(reqId, "REQ", {
        ip,
        method,
        url,
        proto: getProto(req),
        host: getHost(req),
        headers: pickHeaders(req),
    });

    req.on("aborted", () => logError(reqId, "REQ_ABORTED"));
    req.on("close", () => logDebug(reqId, "REQ_CLOSE"));
    res.on("close", () => logDebug(reqId, "RES_CLOSE"));
    res.on("finish", () => logDebug(reqId, "RES_FINISH"));

    // Discovery endpoint
    if (url === "/mcp" || url === "/mcp/") {
        const proto = getProto(req);
        const host = getHost(req);
        const base = `${proto}://${host}`;

        const body = {
            protocol: "mcp",
            transport: "streamable-http",
            sseEndpoint: "/sse",
            endpoints: {
                sse: `${base}/sse`,
                health: `${base}/health`,
                debugEcho: `${base}/debug/echo`,
                debugPingLfa: `${base}/debug/ping-lfa`,
            },
        };

        logInfo(reqId, "MCP_DISCOVERY_OK", body);
        json(res, 200, body);
        return;
    }

    // Health
    if (url === "/health") {
        json(res, 200, { ok: true, name: "local-file-agent-bridge", time: nowISO() });
        return;
    }

    // Debug: echo headers
    if (url === "/debug/echo") {
        json(res, 200, {
            ok: true,
            time: nowISO(),
            ip,
            method,
            url,
            headers: req.headers,
        });
        return;
    }

    // Debug: ping local-file-agent
    if (url === "/debug/ping-lfa") {
        try {
            const token = extractToken(req);
            const data = await lfaFetch("/index/summary", { method: "GET", token, reqId });
            json(res, 200, { ok: true, lfa: data });
        } catch (e) {
            json(res, 500, { ok: false, error: e.message || String(e), payload: e.payload });
        }
        return;
    }

    // MCP streamable HTTP endpoint
    if (url.startsWith("/sse")) {
        try {
            const token = extractToken(req);
            logInfo(reqId, "SSE_ENTER", { token: token ? redact(token) : "(none)" });

            const transport = new StreamableHTTPServerTransport(req, res, {
                requestContext: {
                    reqId,
                    headers: {
                        "x-agent-token": token,
                    },
                },
            });

            logInfo(reqId, "SSE_TRANSPORT_CREATED");
            await mcp.connect(transport);
            logInfo(reqId, "SSE_MCP_CONNECTED");
            return;
        } catch (e) {
            logError(reqId, "SSE_ERROR", { msg: e.message || String(e) });
            if (!res.headersSent) {
                json(res, 500, { ok: false, error: e.message || String(e) });
            } else {
                res.end();
            }
            return;
        }
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
});

httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`MCP Bridge listening on :${PORT}`);
    console.log(`Discovery: http://localhost:${PORT}/mcp`);
    console.log(`MCP endpoint: http://localhost:${PORT}/sse`);
    console.log(`Debug echo: http://localhost:${PORT}/debug/echo`);
    console.log(`Debug ping lfa: http://localhost:${PORT}/debug/ping-lfa`);
});
