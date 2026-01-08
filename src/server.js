/**
 * Local File Agent MCP Bridge (OpenAI MCP Client 호환 최종본)
 *
 * ✅ 수정해야 할 부분
 * 1) LOCAL_FILE_AGENT_BASE_URL
 * 2) LFA_TOKEN(env) 또는 DEFAULT_AGENT_TOKEN
 * 3) PORT
 *
 * 핵심 라우팅 규칙(중요):
 * - /mcp.json : Discovery(JSON) 전용
 * - /mcp      : OpenAI가 실제로 호출하는 엔드포인트
 *    - GET /mcp (Accept: text/event-stream) => Transport(SSE)
 *    - GET /mcp (그 외)                    => Discovery(JSON)
 *    - POST /mcp:
 *        - 세션 식별자 없음 => Discovery(JSON)  (★ 현재 네 로그의 첫 POST 케이스 대응)
 *        - 세션 식별자 있음 => Transport(Messages)
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
        health: 0,
        discovery: { mcpjson: 0, mcpGet: 0, mcpPost: 0 },
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
function wantsEventStream(req) {
    return String(req.headers["accept"] || "").includes("text/event-stream");
}

/**
 * ✅ 세션/연결 식별자 감지
 * - OpenAI/프록시/SDK 버전에 따라 헤더명이 달라질 수 있어 후보를 넓게 잡음
 * - "없으면" 초기 단계로 보고 discovery로 응답(POST /mcp에서도!)
 */
function getSessionId(req) {
    const h = req.headers;

    const candidates = [
        "mcp-session-id",
        "x-mcp-session-id",
        "mcp-session",
        "x-mcp-session",
        "mcp-connection-id",
        "x-mcp-connection-id",
    ];

    for (const k of candidates) {
        const v = h[k];
        const s = Array.isArray(v) ? v[0] : v;
        if (s && String(s).trim()) return String(s).trim();
    }

    // 쿼리로 세션을 보내는 구현도 가끔 있어서 보조로 체크
    try {
        const u = new URL(req.url || "/", `http://${h.host || "localhost"}`);
        const qs = u.searchParams.get("session") || u.searchParams.get("mcpSessionId") || "";
        if (qs.trim()) return qs.trim();
    } catch {}

    return "";
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
const mcp = new McpServer({ name: "lfa-bridge", version: "2.3.0" });

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
        },
    };
}

/** =========================
 * Transport handler
 * ========================= */
async function handleTransport(req, res, { reqId, ip, pathname }) {
    state.lastSseAt = nowIso();

    // GET은 event-stream 강제
    if ((req.method || "GET").toUpperCase() === "GET") {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    }
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const token = extractToken(req);
    log("INFO", reqId, "SSE_ENTER", { token: maskToken(token), path: pathname });

    const startMs = Date.now();
    let counted = false;

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

    const sessionId = getSessionId(req);

    log("INFO", reqId, "REQ", {
        ip,
        method,
        url: rawUrl,
        pathname,
        proto: getProto(req),
        host: getHost(req),
        accept: req.headers["accept"] || "",
        contentType: req.headers["content-type"] || "",
        ua: req.headers["user-agent"] || "",
        sessionId: sessionId ? `${sessionId.slice(0, 6)}...` : "",
    });

    // health
    if (pathname === "/health" && method === "GET") {
        state.counters.health += 1;
        return writeJson(res, 200, { ok: true, time: nowIso(), state }, { "cache-control": "no-store" });
    }

    // discovery 전용
    if (pathname === "/mcp.json" && method === "GET") {
        state.counters.discovery.mcpjson += 1;
        state.lastDiscoveryAt = nowIso();
        state.lastAgentIp = ip;
        state.lastAgentUa = String(req.headers["user-agent"] || "");
        return writeJson(res, 200, buildDiscovery(req), { "cache-control": "no-store" });
    }

    /**
     * ✅ /mcp 처리
     */
    if (pathname === "/mcp" && method === "GET") {
        // GET은 Accept를 보고 분기
        if (wantsEventStream(req)) {
            state.counters.transport.mcpGet += 1;
            return handleTransport(req, res, { reqId, ip, pathname: "/mcp" });
        }

        state.counters.discovery.mcpGet += 1;
        state.lastDiscoveryAt = nowIso();
        state.lastAgentIp = ip;
        state.lastAgentUa = String(req.headers["user-agent"] || "");
        return writeJson(res, 200, buildDiscovery(req), { "cache-control": "no-store" });
    }

    if (pathname === "/mcp" && method === "POST") {
        /**
         * ★ 여기(가장 중요)
         * - 지금 네 로그의 첫 요청은 POST /mcp 이고 세션이 없음
         * - 이걸 transport로 처리하면 20초 후 aborted가 재현됨
         * - 따라서 세션이 없으면 무조건 discovery JSON 반환
         */
        if (!sessionId) {
            state.counters.discovery.mcpPost += 1;
            state.lastDiscoveryAt = nowIso();
            state.lastAgentIp = ip;
            state.lastAgentUa = String(req.headers["user-agent"] || "");
            return writeJson(res, 200, buildDiscovery(req), { "cache-control": "no-store" });
        }

        // 세션이 있으면 transport message로 처리
        state.counters.transport.mcpPost += 1;
        return handleTransport(req, res, { reqId, ip, pathname: "/mcp" });
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Bridge started :${PORT}`);
    console.log(`LFA base      : ${LOCAL_FILE_AGENT_BASE_URL}`);
    console.log(`Discovery     : http://localhost:${PORT}/mcp.json`);
    console.log(`MCP endpoint  : http://localhost:${PORT}/mcp`);
    console.log(`Health        : http://localhost:${PORT}/health`);
});
