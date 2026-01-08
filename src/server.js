/**
 * Local File Agent MCP Bridge (OpenAI MCP 호환: discovery 분리 / transport 전용화)
 *
 * ✅ 수정해야 할 부분
 * 1) LOCAL_FILE_AGENT_BASE_URL
 * 2) LFA_TOKEN(env) 또는 DEFAULT_AGENT_TOKEN
 * 3) PORT
 *
 * 설계:
 * - /mcp.json : Discovery(JSON) 전용 (연결 폼에 이 URL 입력)
 * - /mcp      : Transport 전용
 *    - GET  /mcp => SSE (text/event-stream)
 *    - POST /mcp => Streamable HTTP messages
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/** =========================
 * ✅ 수정해야 할 부분
 * ========================= */
const LOCAL_FILE_AGENT_BASE_URL =
    process.env.LOCAL_FILE_AGENT_BASE_URL || "http://58.121.142.180:4312";
const PORT = Number(process.env.PORT || 8787);
const DEFAULT_AGENT_TOKEN = (process.env.LFA_TOKEN || "73025532").trim();

/** =========================
 * 상태(관측)
 * ========================= */
const state = {
    startedAt: new Date().toISOString(),
    activeSse: 0,
    lastDiscoveryAt: "",
    lastSseAt: "",
    lastAgentIp: "",
    lastAgentUa: "",
    counters: {
        total: 0,
        discovery: { get: 0 },
        transport: { mcpGet: 0, mcpPost: 0 },
    },
};

function nowIso() {
    return new Date().toISOString();
}
function safeJson(v) {
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}
function log(level, reqId, msg, obj) {
    const line = `[${nowIso()}] [${level}] [${reqId}] ${msg}`;
    console.log(obj === undefined ? line : `${line} ${safeJson(obj)}`);
}
function getProto(req) {
    return (req.headers["x-forwarded-proto"] || "http").toString();
}
function getHost(req) {
    return (req.headers["x-forwarded-host"] || req.headers["host"] || "").toString();
}
function getClientIp(req) {
    const xff = req.headers["x-forwarded-for"];
    if (Array.isArray(xff)) return xff[0] || req.socket.remoteAddress || "";
    return (xff || req.socket.remoteAddress || "").toString();
}
function maskToken(t) {
    if (!t) return "";
    if (t.length <= 6) return "***";
    return `${t.slice(0, 3)}***${t.slice(-3)}`;
}
function extractToken(req) {
    const x = req.headers["x-agent-token"];
    const token1 = (Array.isArray(x) ? x[0] : x) || "";
    if (String(token1).trim()) return String(token1).trim();

    const a = req.headers["authorization"];
    const auth = (Array.isArray(a) ? a[0] : a) || "";
    if (auth.toLowerCase().startsWith("bearer ")) {
        const t = auth.slice("bearer ".length).trim();
        if (t) return t;
    }
    return DEFAULT_AGENT_TOKEN;
}
function writeJson(res, status, payload, extra = {}) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extra });
    res.end(JSON.stringify(payload));
}

/** =========================
 * local-file-agent fetch
 * ========================= */
async function lfaFetch(path, opts = {}) {
    const { method = "GET", token = "", body } = opts;
    const url = `${LOCAL_FILE_AGENT_BASE_URL}${path}`;

    const headers = { "content-type": "application/json" };
    if (token) headers["x-agent-token"] = token;

    const started = Date.now();
    const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = { raw: text };
    }

    const ms = Date.now() - started;
    if (!res.ok) {
        const err = new Error(`local-file-agent error ${res.status}`);
        err.status = res.status;
        err.payload = json;
        err.ms = ms;
        throw err;
    }
    return { ok: true, status: res.status, ms, data: json };
}

/** =========================
 * MCP Tools
 * ========================= */
const mcp = new McpServer({ name: "lfa-bridge", version: "2.2.0" });

mcp.tool("lfa_health", "Check local agent health", z.object({}), async (_args, ctx) => {
    const headers = (ctx?.requestContext?.headers || {});
    const token = (headers["x-agent-token"] || DEFAULT_AGENT_TOKEN).toString();
    const r = await lfaFetch("/health", { method: "GET", token });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

mcp.tool("lfa_index_summary", "Get index summary", z.object({}), async (_args, ctx) => {
    const headers = (ctx?.requestContext?.headers || {});
    const token = (headers["x-agent-token"] || DEFAULT_AGENT_TOKEN).toString();
    const r = await lfaFetch("/index/summary", { method: "GET", token });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

mcp.tool("lfa_index_build", "Build index", z.object({}), async (_args, ctx) => {
    const headers = (ctx?.requestContext?.headers || {});
    const token = (headers["x-agent-token"] || DEFAULT_AGENT_TOKEN).toString();
    const r = await lfaFetch("/index", { method: "POST", token, body: {} });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

mcp.tool("lfa_file_read", "Read file by path", z.object({ path: z.string() }), async (args, ctx) => {
    const headers = (ctx?.requestContext?.headers || {});
    const token = (headers["x-agent-token"] || DEFAULT_AGENT_TOKEN).toString();
    const qs = new URLSearchParams({ path: args.path });
    const r = await lfaFetch(`/file?${qs.toString()}`, { method: "GET", token });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

/** =========================
 * Discovery payload
 * ========================= */
function buildDiscovery(req) {
    const base = `${getProto(req)}://${getHost(req)}`;
    return {
        protocol: "mcp",
        transport: "streamable-http",
        sseEndpoint: "/mcp",
        sseUrl: `${base}/mcp`,
        endpoints: {
            sse: `${base}/mcp`,
            messages: `${base}/mcp`,
            health: `${base}/health`,
            // (선택) OAuth 엔드포인트를 계속 노출하고 싶으면 여기 추가 가능
        },
    };
}

/** =========================
 * Transport handler
 * ========================= */
async function handleTransport(req, res, { reqId, ip, pathname }) {
    state.lastSseAt = nowIso();

    // ✅ GET은 반드시 event-stream
    if ((req.method || "GET").toUpperCase() === "GET") {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    }
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const token = extractToken(req);
    log("INFO", reqId, "SSE_ENTER", { token: maskToken(token), path: pathname });

    let counted = false;
    const startMs = Date.now();
    const decActive = () => {
        if (!counted) return;
        counted = false;
        state.activeSse = Math.max(0, state.activeSse - 1);
    };

    res.on("close", () => {
        decActive();
        log("INFO", reqId, "SSE_RES_CLOSE", {
            activeSse: state.activeSse,
            aliveMs: Date.now() - startMs,
            path: pathname,
        });
    });
    req.on("aborted", () => {
        log("WARN", reqId, "SSE_REQ_ABORTED", { aliveMs: Date.now() - startMs, path: pathname });
    });

    try {
        state.activeSse += 1;
        counted = true;

        const transport = new StreamableHTTPServerTransport(req, res, {
            requestContext: {
                reqId,
                ip,
                headers: {
                    ...Object.fromEntries(
                        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : (v ?? "")])
                    ),
                    "x-agent-token": token,
                },
            },
        });

        log("INFO", reqId, "SSE_TRANSPORT_CREATED");
        await mcp.connect(transport);
        log("INFO", reqId, "SSE_MCP_CONNECTED");
    } catch (e) {
        decActive();
        log("ERROR", reqId, "SSE_CONNECT_FAIL", { message: e?.message, stack: e?.stack });
        try {
            if (!res.headersSent) writeJson(res, 500, { ok: false, message: e?.message, reqId });
        } catch {}
        try {
            res.end();
        } catch {}
    }
}

/** =========================
 * HTTP Server
 * ========================= */
const server = http.createServer(async (req, res) => {
    const reqId = randomUUID();
    const ip = getClientIp(req);
    const method = (req.method || "GET").toUpperCase();
    const rawUrl = req.url || "/";

    const parsed = new URL(rawUrl, `http://${req.headers.host || "localhost"}`);
    const pathname = parsed.pathname;

    state.counters.total += 1;

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-agent-token");
    res.setHeader("Access-Control-Expose-Headers", "x-agent-token");

    if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    log("INFO", reqId, "REQ", {
        ip,
        method,
        url: rawUrl,
        pathname,
        proto: getProto(req),
        host: getHost(req),
        headers: {
            host: req.headers["host"] || "",
            accept: req.headers["accept"] || "",
            "content-type": req.headers["content-type"] || "",
            "user-agent": req.headers["user-agent"] || "",
        },
    });

    // health
    if (pathname === "/health" && method === "GET") {
        return writeJson(res, 200, { ok: true, time: nowIso(), state }, { "cache-control": "no-store" });
    }

    /**
     * ✅ Discovery 전용: /mcp.json
     * - 연결 폼에는 반드시 https://mcp.cmstudio.app/mcp.json 을 입력
     */
    if (pathname === "/mcp.json" && method === "GET") {
        state.counters.discovery.get += 1;
        state.lastDiscoveryAt = nowIso();
        state.lastAgentIp = ip;
        state.lastAgentUa = String(req.headers["user-agent"] || "");
        return writeJson(res, 200, buildDiscovery(req), { "cache-control": "no-store" });
    }

    /**
     * ✅ Transport 전용: /mcp
     * - GET  /mcp : SSE
     * - POST /mcp : messages
     */
    if (pathname === "/mcp" && (method === "GET" || method === "POST")) {
        if (method === "GET") state.counters.transport.mcpGet += 1;
        else state.counters.transport.mcpPost += 1;
        return handleTransport(req, res, { reqId, ip, pathname: "/mcp" });
    }

    // (선택) 실수로 /mcp.json 대신 /mcp를 discovery로 호출하는 걸 막기 위해 안내
    if (pathname === "/mcp" && method === "GET") {
        res.writeHead(307, { Location: "/mcp.json" });
        res.end();
        return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Bridge started :${PORT}`);
    console.log(`LFA base      : ${LOCAL_FILE_AGENT_BASE_URL}`);
    console.log(`Discovery     : http://localhost:${PORT}/mcp.json`);
    console.log(`Transport     : http://localhost:${PORT}/mcp`);
    console.log(`Health        : http://localhost:${PORT}/health`);
});
