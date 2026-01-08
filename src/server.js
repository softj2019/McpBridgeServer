/**
 * Local File Agent MCP Bridge (ALB + Streamable HTTP + OpenAI MCP Client Compatible)
 *
 * ✅ 수정해야 할 부분
 * 1) LOCAL_FILE_AGENT_BASE_URL: local-file-agent 주소
 * 2) DEFAULT_AGENT_TOKEN 또는 LFA_TOKEN(env): Agent Builder가 토큰을 안 보내면 fallback
 * 3) PORT: 서비스 포트
 *
 * 실행:
 *   node server.js
 *
 * ENV:
 *   PORT=8787
 *   LOCAL_FILE_AGENT_BASE_URL=http://127.0.0.1:4312
 *   LFA_TOKEN=xxxx
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

// Agent Builder가 x-agent-token을 안 보낼 때 대비 (ENV 우선)
const DEFAULT_AGENT_TOKEN = (process.env.LFA_TOKEN || "73025532").trim();

/** =========================
 * 상태 저장(관측)
 * ========================= */
const state = {
    startedAt: new Date().toISOString(),
    activeSse: 0,

    lastDiscoveryAt: "",
    lastSseAt: "",
    lastTokenIssuedAt: "",

    lastAgentIp: "",
    lastAgentUa: "",

    reqCounters: {
        total: 0,
        mcp: { get: 0, post: 0, getSse: 0, getJson: 0 },
        sse: { get: 0, post: 0 },
        wellKnown: { authServer: 0, protectedResource: 0 },
        oauthToken: { post: 0 },
        debug: { echo: 0, pingLfa: 0, state: 0, lastRpc: 0 },
    },

    lastRpc: {
        at: "",
        ip: "",
        ua: "",
        method: "",
        path: "",
        headersHint: {},
        note: "",
    },
};

/** =========================
 * 유틸
 * ========================= */
function nowIso() {
    return new Date().toISOString();
}

function maskToken(t) {
    if (!t) return "";
    if (t.length <= 6) return "***";
    return `${t.slice(0, 3)}***${t.slice(-3)}`;
}

function safeJson(v) {
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
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

function pickHeaders(headers) {
    const keys = [
        "host",
        "x-forwarded-for",
        "x-forwarded-proto",
        "x-forwarded-host",
        "x-forwarded-port",
        "user-agent",
        "content-type",
        "accept",
        "origin",
        "referer",
        "authorization",
        "x-agent-token",
    ];

    const out = {};
    for (const k of keys) {
        const v = headers[k];
        out[k] = Array.isArray(v) ? v[0] : (v ?? "");
    }

    if (out["authorization"]) out["authorization"] = "****";
    if (out["x-agent-token"]) out["x-agent-token"] = maskToken(String(out["x-agent-token"] || ""));
    return out;
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

function writeJson(res, status, payload, extraHeaders = {}) {
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        ...extraHeaders,
    });
    res.end(JSON.stringify(payload));
}

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", () => resolve(Buffer.from("")));
    });
}

function log(level, reqId, msg, obj) {
    const line = `[${nowIso()}] [${level}] [${reqId}] ${msg}`;
    if (obj === undefined) console.log(line);
    else console.log(`${line} ${safeJson(obj)}`);
}

function wantsEventStream(req) {
    const a = String(req.headers["accept"] || "");
    return a.includes("text/event-stream");
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
const mcp = new McpServer({ name: "lfa-bridge", version: "1.5.0" });

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
 * Transport 연결 공통 처리
 * - /mcp (Accept:text/event-stream 이거나 POST) /sse 모두 지원
 * ========================= */
async function handleTransport(req, res, { reqId, ip, pathname }) {
    state.lastSseAt = nowIso();

    if (pathname === "/sse") {
        if (req.method === "GET") state.reqCounters.sse.get += 1;
        else if (req.method === "POST") state.reqCounters.sse.post += 1;
    } else if (pathname === "/mcp") {
        if (req.method === "GET") state.reqCounters.mcp.getSse += 1;
        else if (req.method === "POST") state.reqCounters.mcp.post += 1;
    }

    // 안전한 최소 관측 (바디는 읽지 않음: SDK와 충돌 방지)
    state.lastRpc = {
        at: nowIso(),
        ip,
        ua: String(req.headers["user-agent"] || ""),
        method: String(req.method || "GET").toUpperCase(),
        path: pathname,
        headersHint: pickHeaders(req.headers),
        note:
            pathname === "/mcp"
                ? "Transport on /mcp (OpenAI content-negotiation compatible)"
                : "Transport on /sse",
    };

    const token = extractToken(req);
    log("INFO", reqId, "SSE_ENTER", { token: maskToken(token) });

    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

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
        log("INFO", reqId, "SSE_ACTIVE_INC", { activeSse: state.activeSse });

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
        return;
    } catch (e) {
        decActive();
        log("ERROR", reqId, "SSE_CONNECT_FAIL", { message: e?.message, stack: e?.stack });

        try {
            if (!res.headersSent) {
                return writeJson(res, 500, { ok: false, message: e?.message, reqId }, { "cache-control": "no-store" });
            }
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

    state.reqCounters.total += 1;

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
        headers: pickHeaders(req.headers),
    });

    req.on("aborted", () => log("WARN", reqId, "REQ_ABORTED_BY_CLIENT"));
    req.on("error", (e) => log("ERROR", reqId, "REQ_STREAM_ERROR", { message: e?.message }));
    res.on("close", () => log("INFO", reqId, "RES_CLOSE"));
    res.on("finish", () => log("INFO", reqId, "RES_FINISH"));

    /** health/debug */
    if (pathname === "/health" && method === "GET") {
        return writeJson(
            res,
            200,
            {
                ok: true,
                name: "lfa-bridge",
                time: nowIso(),
                state,
                lfaBase: LOCAL_FILE_AGENT_BASE_URL,
                tokenFallback: maskToken(DEFAULT_AGENT_TOKEN),
                discovery: "/mcp",
                transport: ["/mcp (SSE via Accept)", "/sse (alt)"],
            },
            { "cache-control": "no-store" }
        );
    }

    if (pathname === "/debug/state" && method === "GET") {
        state.reqCounters.debug.state += 1;
        return writeJson(res, 200, { ok: true, state }, { "cache-control": "no-store" });
    }

    if (pathname === "/debug/last-rpc" && method === "GET") {
        state.reqCounters.debug.lastRpc += 1;
        return writeJson(res, 200, { ok: true, lastRpc: state.lastRpc }, { "cache-control": "no-store" });
    }

    if (pathname.startsWith("/debug/echo")) {
        state.reqCounters.debug.echo += 1;
        const body = await readBody(req);
        return writeJson(
            res,
            200,
            { ok: true, method, url: rawUrl, pathname, headers: pickHeaders(req.headers), body: body.toString("utf-8") },
            { "cache-control": "no-store" }
        );
    }

    if (pathname.startsWith("/debug/ping-lfa")) {
        state.reqCounters.debug.pingLfa += 1;
        try {
            const token = extractToken(req);
            const r = await lfaFetch("/index/summary", { method: "GET", token });
            return writeJson(res, 200, { ok: true, token: maskToken(token), lfa: r }, { "cache-control": "no-store" });
        } catch (e) {
            return writeJson(
                res,
                500,
                { ok: false, message: e?.message, status: e?.status, payload: e?.payload },
                { "cache-control": "no-store" }
            );
        }
    }

    /** OAuth well-known */
    if (pathname === "/mcp/.well-known/oauth-authorization-server" && method === "GET") {
        state.reqCounters.wellKnown.authServer += 1;
        const base = `${getProto(req)}://${getHost(req)}`;
        const issuer = `${base}/mcp`;
        state.lastDiscoveryAt = nowIso();
        return writeJson(
            res,
            200,
            {
                issuer,
                token_endpoint: `${issuer}/oauth/token`,
                token_endpoint_auth_methods_supported: ["none"],
                grant_types_supported: ["client_credentials"],
            },
            { "cache-control": "no-store" }
        );
    }

    if (pathname === "/mcp/.well-known/oauth-protected-resource" && method === "GET") {
        state.reqCounters.wellKnown.protectedResource += 1;
        const base = `${getProto(req)}://${getHost(req)}`;
        const resource = `${base}/mcp`;
        state.lastDiscoveryAt = nowIso();
        return writeJson(
            res,
            200,
            { resource, authorization_servers: [resource] },
            { "cache-control": "no-store" }
        );
    }

    if (pathname === "/mcp/oauth/token" && method === "POST") {
        state.reqCounters.oauthToken.post += 1;
        const token = extractToken(req);
        state.lastTokenIssuedAt = nowIso();
        return writeJson(
            res,
            200,
            { access_token: token, token_type: "Bearer", expires_in: 3600 },
            { "cache-control": "no-store" }
        );
    }

    /** =========================
     * ✅ 핵심: /mcp 콘텐츠 네고시에이션
     * - GET /mcp + Accept:text/event-stream  => Transport(SSE)
     * - GET /mcp + 그 외                    => Discovery(JSON)
     * - POST /mcp                           => Transport(메시지 전송)
     * ========================= */

    if (pathname === "/mcp" && method === "GET") {
        state.reqCounters.mcp.get += 1;

        if (wantsEventStream(req)) {
            // ✅ OpenAI가 여기로 SSE를 기대함
            return handleTransport(req, res, { reqId, ip, pathname });
        }

        // ✅ Discovery(JSON)
        state.reqCounters.mcp.getJson += 1;

        state.lastDiscoveryAt = nowIso();
        state.lastAgentIp = ip;
        state.lastAgentUa = String(req.headers["user-agent"] || "");

        const base = `${getProto(req)}://${getHost(req)}`;
        const payload = {
            protocol: "mcp",
            transport: "streamable-http",

            // 상대/절대 모두 제공
            sseEndpoint: "/mcp", // ✅ OpenAI 스타일: 같은 엔드포인트에서 Accept로 SSE
            sseUrl: `${base}/mcp`,

            endpoints: {
                // OpenAI는 /mcp 자체를 SSE로 씀
                sse: `${base}/mcp`,
                messages: `${base}/mcp`,

                // 다른 클라이언트 호환용 대체 엔드포인트도 유지
                altSse: `${base}/sse`,

                health: `${base}/health`,
                debugEcho: `${base}/debug/echo`,
                debugPingLfa: `${base}/debug/ping-lfa`,
                debugState: `${base}/debug/state`,
                debugLastRpc: `${base}/debug/last-rpc`,

                oauthAuthorizationServer: `${base}/mcp/.well-known/oauth-authorization-server`,
                oauthProtectedResource: `${base}/mcp/.well-known/oauth-protected-resource`,
                oauthToken: `${base}/mcp/oauth/token`,
            },
        };

        log("INFO", reqId, "MCP_DISCOVERY_OK", payload);
        return writeJson(res, 200, payload, { "cache-control": "no-store" });
    }

    if (pathname === "/mcp" && method === "POST") {
        // ✅ OpenAI가 여기로도 POST를 보낼 수 있음(메시지 전송)
        return handleTransport(req, res, { reqId, ip, pathname });
    }

    /** 대체 /sse 엔드포인트도 지원 */
    if (pathname === "/sse" && (method === "GET" || method === "POST")) {
        return handleTransport(req, res, { reqId, ip, pathname: "/sse" });
    }

    /** 404 */
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Bridge started :${PORT}`);
    console.log(`LFA base      : ${LOCAL_FILE_AGENT_BASE_URL}`);
    console.log(`MCP endpoint  : http://localhost:${PORT}/mcp (GET: discovery or SSE via Accept, POST: messages)`);
    console.log(`Alt transport : http://localhost:${PORT}/sse`);
    console.log(`Health        : http://localhost:${PORT}/health`);
    console.log(`Debug state   : http://localhost:${PORT}/debug/state`);
    console.log(`Debug lastRpc : http://localhost:${PORT}/debug/last-rpc`);
});
