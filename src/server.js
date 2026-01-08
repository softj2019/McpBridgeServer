/**
 * Local File Agent MCP Bridge (OpenAI MCP 호환 최종 안정판)
 *
 * ✅ 수정해야 할 부분
 * 1) LOCAL_FILE_AGENT_BASE_URL: local-file-agent 주소
 * 2) DEFAULT_AGENT_TOKEN 또는 LFA_TOKEN(env)
 * 3) PORT
 * 4) (선택) DISCOVERY_MAX_LEN
 *
 * 핵심 포인트:
 * - OpenAI(openai-mcp/1.0.0)는 POST /mcp 를 discovery로도 쓰고,
 *   실제 MCP transport(JSON-RPC initialize 등)로도 쓸 수 있음.
 * - req body를 읽으면(Stream 소비) StreamableHTTPServerTransport가 깨질 수 있으므로
 *   Content-Length 기반으로만 분기한다.
 * - Accept에 text/event-stream 이 포함되면 GET/POST 상관없이
 *   응답 Content-Type을 text/event-stream으로 강제 + flushHeaders() 수행.
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

// Agent Builder/OpenAI가 토큰을 안 보내는 경우 fallback
const DEFAULT_AGENT_TOKEN = (process.env.LFA_TOKEN || "73025532").trim();

// POST /mcp discovery 판단 기준(본문 없는 POST가 discovery일 때)
const DISCOVERY_MAX_LEN = Number(process.env.DISCOVERY_MAX_LEN || 2);

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
        root: 0,
        favicon: 0,
        discovery: { mcpGet: 0, mcpPost: 0, mcpJson: 0 },
        oauth: { authServer: 0, protectedResource: 0, token: 0 },
        transport: { mcpGet: 0, mcpPost: 0 },
        debug: { state: 0, lastRpc: 0, pingLfa: 0 },
    },
};

// ✅ 마지막 transport 진입 기록(“어디까지 갔는지” 확인용)
const lastRpc = {
    at: "",
    reqId: "",
    ip: "",
    path: "",
    ua: "",
    accept: "",
    contentType: "",
    contentLength: 0,
    sessionId: "",
    tokenMasked: "",
    note: "",
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
function wantsEventStream(req) {
    return String(req.headers["accept"] || "").includes("text/event-stream");
}
function writeJson(res, status, payload, extra = {}) {
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        ...extra,
    });
    res.end(JSON.stringify(payload));
}
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
const mcp = new McpServer({ name: "lfa-bridge", version: "2.8.0" });

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
 * Discovery & OAuth payload
 * ========================= */
function buildBase(req) {
    return `${getProto(req)}://${getHost(req)}`;
}

function buildDiscovery(req) {
    const base = buildBase(req);
    return {
        protocol: "mcp",
        transport: "streamable-http",

        // OpenAI가 /mcp 하나로 운영하는 패턴에 최적화
        sseEndpoint: "/mcp",
        sseUrl: `${base}/mcp`,
        endpoints: {
            sse: `${base}/mcp`,
            messages: `${base}/mcp`,
            health: `${base}/health`,
            oauthAuthorizationServer: `${base}/mcp/.well-known/oauth-authorization-server`,
            oauthProtectedResource: `${base}/mcp/.well-known/oauth-protected-resource`,
            oauthToken: `${base}/mcp/oauth/token`,
            debugState: `${base}/debug/state`,
            debugLastRpc: `${base}/debug/last-rpc`,
            debugPingLfa: `${base}/debug/ping-lfa`,
        },
    };
}

function buildOAuthAuthorizationServer(req) {
    const base = buildBase(req);
    return {
        issuer: `${base}/mcp`,
        token_endpoint: `${base}/mcp/oauth/token`,
        token_endpoint_auth_methods_supported: ["none"],
        grant_types_supported: ["client_credentials"],
    };
}

function buildOAuthProtectedResource(req) {
    const base = buildBase(req);
    return {
        resource: `${base}/mcp`,
        authorization_servers: [`${base}/mcp`],
    };
}

/** =========================
 * Transport handler
 * ========================= */
async function handleTransport(req, res, meta) {
    const { reqId, ip, pathname, ua, accept, contentType, sessionId, contentLength } = meta;

    state.lastSseAt = nowIso();

    // ✅ (핵심) Accept에 text/event-stream이 있으면 GET/POST 상관없이 event-stream 강제
    if (wantsEventStream(req)) {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    }

    // 프록시/ALB 버퍼링 방지
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // ✅ 헤더 즉시 flush
    try {
        res.flushHeaders?.();
    } catch {}

    const token = extractToken(req);

    // lastRpc 기록
    lastRpc.at = nowIso();
    lastRpc.reqId = reqId;
    lastRpc.ip = ip;
    lastRpc.path = pathname;
    lastRpc.ua = ua;
    lastRpc.accept = accept;
    lastRpc.contentType = contentType;
    lastRpc.contentLength = contentLength;
    lastRpc.sessionId = sessionId;
    lastRpc.tokenMasked = maskToken(token);
    lastRpc.note = "transport-enter";

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

        lastRpc.at = nowIso();
        lastRpc.note = "mcp.connect(start)";

        await mcp.connect(transport);

        lastRpc.at = nowIso();
        lastRpc.note = "mcp.connect(done)";

        log("INFO", reqId, "SSE_MCP_CONNECTED");
    } catch (e) {
        decActive();
        lastRpc.at = nowIso();
        lastRpc.note = `mcp.connect(error): ${e?.message || "unknown"}`;

        log("ERROR", reqId, "SSE_CONNECT_FAIL", { message: e?.message, stack: e?.stack });

        // transport가 응답을 잡고 있을 수 있으니 안전 종료만
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

    // 공통 응답 로그
    res.on("finish", () => log("INFO", reqId, "RES_FINISH"));
    res.on("close", () => log("INFO", reqId, "RES_CLOSE"));

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
    const contentLength = Number(req.headers["content-length"] || 0);
    const accept = String(req.headers["accept"] || "");
    const contentType = String(req.headers["content-type"] || "");
    const ua = String(req.headers["user-agent"] || "");

    log("INFO", reqId, "REQ", {
        ip,
        method,
        url: rawUrl,
        pathname,
        proto: getProto(req),
        host: getHost(req),
        accept,
        contentType,
        ua,
        sessionId,
        contentLength,
    });

    // root
    if (pathname === "/" && method === "GET") {
        state.counters.root += 1;
        return writeJson(
            res,
            200,
            { ok: true, name: "lfa-bridge", time: nowIso(), discovery: "/mcp.json", mcp: "/mcp" },
            { "cache-control": "no-store" }
        );
    }

    // favicon들(불필요하지만 깔끔하게 204)
    if (pathname.startsWith("/favicon") && method === "GET") {
        state.counters.favicon += 1;
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
    }

    // health
    if (pathname === "/health" && method === "GET") {
        state.counters.health += 1;
        return writeJson(res, 200, { ok: true, time: nowIso(), state }, { "cache-control": "no-store" });
    }

    // debug state
    if (pathname === "/debug/state" && method === "GET") {
        state.counters.debug.state += 1;
        return writeJson(res, 200, { ok: true, state }, { "cache-control": "no-store" });
    }

    // debug last rpc
    if (pathname === "/debug/last-rpc" && method === "GET") {
        state.counters.debug.lastRpc += 1;
        return writeJson(res, 200, { ok: true, lastRpc }, { "cache-control": "no-store" });
    }

    // debug ping lfa
    if (pathname === "/debug/ping-lfa" && method === "GET") {
        state.counters.debug.pingLfa += 1;
        try {
            const token = extractToken(req);
            const r = await lfaFetch("/index/summary", { method: "GET", token });
            return writeJson(
                res,
                200,
                { ok: true, token: maskToken(token), lfa: r },
                { "cache-control": "no-store" }
            );
        } catch (e) {
            return writeJson(
                res,
                500,
                { ok: false, message: e?.message, status: e?.status, payload: e?.payload },
                { "cache-control": "no-store" }
            );
        }
    }

    // OAuth well-known
    if (pathname === "/mcp/.well-known/oauth-authorization-server" && method === "GET") {
        state.counters.oauth.authServer += 1;
        return writeJson(res, 200, buildOAuthAuthorizationServer(req), { "cache-control": "no-store" });
    }
    if (pathname === "/mcp/.well-known/oauth-protected-resource" && method === "GET") {
        state.counters.oauth.protectedResource += 1;
        return writeJson(res, 200, buildOAuthProtectedResource(req), { "cache-control": "no-store" });
    }
    if (pathname === "/mcp/oauth/token" && method === "POST") {
        state.counters.oauth.token += 1;
        const token = `mcp_${randomUUID().replaceAll("-", "")}`;
        return writeJson(
            res,
            200,
            { access_token: token, token_type: "Bearer", expires_in: 3600 },
            { "cache-control": "no-store" }
        );
    }

    // discovery 전용 endpoint
    if (pathname === "/mcp.json" && method === "GET") {
        state.counters.discovery.mcpJson += 1;
        state.lastDiscoveryAt = nowIso();
        state.lastAgentIp = ip;
        state.lastAgentUa = ua;
        return writeJson(res, 200, buildDiscovery(req), { "cache-control": "no-store" });
    }

    /**
     * /mcp : discovery + transport 혼합
     */
    if (pathname === "/mcp" && method === "GET") {
        // Accept가 event-stream이면 transport
        if (wantsEventStream(req)) {
            state.counters.transport.mcpGet += 1;
            return handleTransport(req, res, {
                reqId,
                ip,
                pathname,
                ua,
                accept,
                contentType,
                sessionId,
                contentLength,
            });
        }

        // 그 외는 discovery
        state.counters.discovery.mcpGet += 1;
        state.lastDiscoveryAt = nowIso();
        state.lastAgentIp = ip;
        state.lastAgentUa = ua;
        return writeJson(res, 200, buildDiscovery(req), { "cache-control": "no-store" });
    }

    if (pathname === "/mcp" && method === "POST") {
        // body를 읽지 않는다(transport 깨짐 방지)
        // Content-Length로만 안전 분기
        if (contentLength <= DISCOVERY_MAX_LEN) {
            state.counters.discovery.mcpPost += 1;
            state.lastDiscoveryAt = nowIso();
            state.lastAgentIp = ip;
            state.lastAgentUa = ua;
            return writeJson(res, 200, buildDiscovery(req), { "cache-control": "no-store" });
        }

        // 바디가 있으면: initialize/도구호출 등 transport
        state.counters.transport.mcpPost += 1;
        return handleTransport(req, res, {
            reqId,
            ip,
            pathname,
            ua,
            accept,
            contentType,
            sessionId,
            contentLength,
        });
    }

    // 404
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Bridge started :${PORT}`);
    console.log(`LFA base      : ${LOCAL_FILE_AGENT_BASE_URL}`);
    console.log(`MCP endpoint  : http://localhost:${PORT}/mcp`);
    console.log(`Discovery     : http://localhost:${PORT}/mcp.json`);
    console.log(`Debug state   : http://localhost:${PORT}/debug/state`);
    console.log(`Debug lastRpc : http://localhost:${PORT}/debug/last-rpc`);
    console.log(`Debug pingLfa : http://localhost:${PORT}/debug/ping-lfa`);
    console.log(`OAuth authsrv : http://localhost:${PORT}/mcp/.well-known/oauth-authorization-server`);
    console.log(`OAuth protect : http://localhost:${PORT}/mcp/.well-known/oauth-protected-resource`);
    console.log(`OAuth token   : http://localhost:${PORT}/mcp/oauth/token`);
    console.log(`Health        : http://localhost:${PORT}/health`);
});
