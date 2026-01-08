/**
 * MCP Bridge Server (Streamable HTTP + OAuth well-known + ALB friendly)
 *
 * ✅ 수정해야 할 부분(필수)
 * 1) LOCAL_FILE_AGENT_BASE_URL : local-file-agent 주소
 * 2) DEFAULT_AGENT_TOKEN       : LFA 토큰(클라이언트가 토큰 안 보내면 fallback)
 * 3) PORT                      : 서비스 포트
 *
 * ✅ 운영 팁(권장)
 * - ALB 앞단이면 "X-Forwarded-Proto/Host" 기반으로 baseUrl 구성
 * - CORS에서 "Mcp-Session-Id" 헤더를 반드시 expose 해야 클라이언트가 세션 유지 가능
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
import { URL } from "node:url";

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/** =========================
 * ✅ 수정해야 할 부분
 * ========================= */
const LOCAL_FILE_AGENT_BASE_URL =
    process.env.LOCAL_FILE_AGENT_BASE_URL || "http://58.121.142.180:4312";

const PORT = Number(process.env.PORT || 8787);

// Agent Builder/OpenAI가 x-agent-token 안 보내면 fallback
const DEFAULT_AGENT_TOKEN = (process.env.LFA_TOKEN || "73025532").trim();

/** =========================
 * 상태(관측)
 * ========================= */
const state = {
    startedAt: new Date().toISOString(),
    activeSessions: 0,
    activeSse: 0,
    lastDiscoveryAt: "",
    lastSessionInitAt: "",
    lastSessionId: "",
    lastAgentIp: "",
    lastAgentUa: "",
    lastRpcAt: "",
    lastRpc: null,
};

/** =========================
 * 유틸
 * ========================= */
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
function maskToken(t) {
    if (!t) return "";
    if (t.length <= 6) return "***";
    return `${t.slice(0, 3)}***${t.slice(-3)}`;
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
function getHeader(req, name) {
    const v = req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
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
        "content-length",
        "accept",
        "origin",
        "referer",
        "authorization",
        "x-agent-token",
        "mcp-session-id",
        "x-mcp-session-id",
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
function log(level, reqId, msg, obj) {
    const line = `[${nowIso()}] [${level}] [${reqId}] ${msg}`;
    if (obj === undefined) console.log(line);
    else console.log(`${line} ${safeJson(obj)}`);
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
function extractAgentToken(req) {
    const x = getHeader(req, "x-agent-token");
    if (x && String(x).trim()) return String(x).trim();

    const a = getHeader(req, "authorization");
    if (a && String(a).toLowerCase().startsWith("bearer ")) {
        const t = String(a).slice("bearer ".length).trim();
        if (t) return t;
    }
    return DEFAULT_AGENT_TOKEN;
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
const mcp = new McpServer({ name: "lfa-bridge", version: "2.0.0" });

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
 * Streamable HTTP 세션 관리
 * ========================= *
 * 핵심 포인트:
 * - GET (Accept: text/event-stream)  => SSE 스트림(Content-Type: text/event-stream)
 * - POST (application/json)          => JSON-RPC 요청 처리(application/json 또는 SSE로 스트리밍)
 * - 세션이 시작되면 서버가 Mcp-Session-Id 헤더로 내려주고,
 *   클라이언트는 이후 요청에 Mcp-Session-Id를 다시 넣어야 함.
 *
 * 반드시 CORS에서 Mcp-Session-Id 헤더를 expose 해줘야 브라우저/프록시 클라이언트가 읽을 수 있음.
 */
const transports = new Map(); // sessionId -> transport

function getSessionIdFromReq(req) {
    return (
        (getHeader(req, "mcp-session-id") || "").toString().trim() ||
        (getHeader(req, "x-mcp-session-id") || "").toString().trim()
    );
}

function createTransport(req, res, reqId, ip) {
    const token = extractAgentToken(req);

    const transport = new StreamableHTTPServerTransport(req, res, {
        // 세션 생성/종료 훅 (SDK가 sessionId 생성)
        onsessioninitialized: async (sessionId) => {
            transports.set(sessionId, transport);
            state.activeSessions = transports.size;
            state.lastSessionInitAt = nowIso();
            state.lastSessionId = sessionId;
            log("INFO", reqId, "SESSION_INITIALIZED", { sessionId, activeSessions: state.activeSessions });
        },
        onsessionclosed: async (sessionId) => {
            transports.delete(sessionId);
            state.activeSessions = transports.size;
            log("INFO", reqId, "SESSION_CLOSED", { sessionId, activeSessions: state.activeSessions });
        },
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

    // 이 transport를 MCP 서버에 연결
    // (중요) connect는 transport가 들어오는 요청을 처리할 준비를 하도록 묶어주는 역할
    mcp.connect(transport).catch((e) => {
        log("ERROR", reqId, "MCP_CONNECT_FAIL", { message: e?.message, stack: e?.stack });
    });

    return transport;
}

function getOrCreateTransport(req, res, reqId, ip) {
    const sessionId = getSessionIdFromReq(req);
    if (sessionId && transports.has(sessionId)) {
        return transports.get(sessionId);
    }
    // 세션이 없거나(초기) / 모르는 세션이면 새로 생성(초기화 요청/새 SSE에 대응)
    return createTransport(req, res, reqId, ip);
}

/** =========================
 * HTTP Server
 * ========================= */
const server = http.createServer(async (req, res) => {
    const reqId = randomUUID();
    const ip = getClientIp(req);

    const rawUrl = req.url || "/";
    const u = new URL(rawUrl, `http://${req.headers.host || "localhost"}`);
    const pathname = u.pathname;

    const method = (req.method || "GET").toUpperCase();
    const accept = (getHeader(req, "accept") || "").toString();

    // ---- CORS ----
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, x-agent-token, Mcp-Session-Id, mcp-session-id, x-mcp-session-id"
    );
    // ✅ 여기 중요: 세션 헤더를 클라이언트가 읽어야 함
    res.setHeader(
        "Access-Control-Expose-Headers",
        "x-agent-token, Mcp-Session-Id, mcp-session-id, x-mcp-session-id"
    );

    if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    // 공통 요청 로그
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

    // health (ALB 헬스체크)
    if (pathname === "/health" && method === "GET") {
        return writeJson(res, 200, {
            ok: true,
            name: "lfa-bridge",
            time: nowIso(),
            state,
            lfaBase: LOCAL_FILE_AGENT_BASE_URL,
            tokenFallback: maskToken(DEFAULT_AGENT_TOKEN),
        });
    }

    // debug state
    if (pathname === "/debug/state" && method === "GET") {
        return writeJson(res, 200, { ok: true, state });
    }

    // debug last rpc
    if (pathname === "/debug/last-rpc" && method === "GET") {
        return writeJson(res, 200, { ok: true, lastRpcAt: state.lastRpcAt, lastRpc: state.lastRpc });
    }

    // debug echo
    if (pathname === "/debug/echo") {
        const body = await readBody(req);
        return writeJson(res, 200, {
            ok: true,
            method,
            url: rawUrl,
            headers: pickHeaders(req.headers),
            body: body.length ? body.toString("utf-8") : "",
        });
    }

    // debug ping lfa
    if (pathname === "/debug/ping-lfa") {
        try {
            const token = extractAgentToken(req);
            const r = await lfaFetch("/index/summary", { method: "GET", token });
            return writeJson(res, 200, { ok: true, token: maskToken(token), lfa: r });
        } catch (e) {
            log("ERROR", reqId, "DEBUG_PING_LFA_FAIL", {
                message: e?.message,
                status: e?.status,
                ms: e?.ms,
                payload: e?.payload,
            });
            return writeJson(res, 500, {
                ok: false,
                message: e?.message,
                status: e?.status,
                ms: e?.ms,
                payload: e?.payload,
            });
        }
    }

    /**
     * OAuth well-known endpoints
     * (지금 네 curl 결과와 동일하게 응답)
     */
    if (pathname === "/mcp/.well-known/oauth-authorization-server" && method === "GET") {
        const base = `${getProto(req)}://${getHost(req)}`;
        return writeJson(
            res,
            200,
            {
                issuer: `${base}/mcp`,
                token_endpoint: `${base}/mcp/oauth/token`,
                token_endpoint_auth_methods_supported: ["none"],
                grant_types_supported: ["client_credentials"],
            },
            { "cache-control": "no-store" }
        );
    }

    if (pathname === "/mcp/.well-known/oauth-protected-resource" && method === "GET") {
        const base = `${getProto(req)}://${getHost(req)}`;
        return writeJson(
            res,
            200,
            {
                resource: `${base}/mcp`,
                authorization_servers: [`${base}/mcp`],
            },
            { "cache-control": "no-store" }
        );
    }

    // (옵션) 토큰 엔드포인트: 현재는 "none + client_credentials"만 광고하므로,
    // 실제 토큰 발급이 필요 없으면 501로 두고, 필요하면 여기 구현하면 됨.
    if (pathname === "/mcp/oauth/token") {
        return writeJson(res, 501, { ok: false, message: "oauth token endpoint not implemented" }, { "cache-control": "no-store" });
    }

    /**
     * Discovery(JSON)
     * - 사람들이 curl로 확인할 수 있도록 GET /mcp 에서 JSON으로 제공
     * - 단, Accept 가 text/event-stream 이면 절대 JSON을 주면 안 됨(지금 네가 겪은 에러 원인)
     */
    if (pathname === "/mcp" && method === "GET" && !accept.includes("text/event-stream")) {
        state.lastDiscoveryAt = nowIso();
        state.lastAgentIp = ip;
        state.lastAgentUa = (getHeader(req, "user-agent") || "").toString();

        const base = `${getProto(req)}://${getHost(req)}`;
        const payload = {
            protocol: "mcp",
            transport: "streamable-http",
            // 표준적으로는 단일 엔드포인트(/mcp)가 GET+POST를 모두 처리 가능
            // 하지만 너는 /sse도 열어두고 싶어하니 둘 다 제공
            sseEndpoint: "/mcp",
            endpoints: {
                // streamable-http 는 보통 동일 엔드포인트를 사용
                mcp: `${base}/mcp`,
                sse: `${base}/mcp`,
                // 호환/테스트용으로 /sse도 제공(동일 handler로 연결)
                sseCompat: `${base}/sse`,
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

    /**
     * Streamable HTTP 실제 처리
     * - /mcp   : GET(SSE) + POST(JSON-RPC) + DELETE(세션 종료) 모두 지원
     * - /sse   : (호환) /mcp 와 동일 동작
     *
     * ✅ 가장 중요한 변화:
     * - GET에서 Accept:text/event-stream 이면 Content-Type:text/event-stream 으로 응답해야 한다.
     * - 이걸 SDK transport.handleRequest()가 알아서 해주므로, 우리가 임의로 JSON을 내리면 안 된다.
     */
    if (pathname === "/mcp" || pathname === "/sse") {
        const transport = getOrCreateTransport(req, res, reqId, ip);

        // body 파싱 (POST/DELETE에서 필요)
        const bodyBuf = await readBody(req);
        let bodyJson = null;

        if (bodyBuf.length) {
            const s = bodyBuf.toString("utf-8");
            try {
                bodyJson = JSON.parse(s);
            } catch {
                bodyJson = null;
            }
        }

        // 관측(마지막 RPC 저장)
        if (bodyJson && typeof bodyJson === "object") {
            state.lastRpcAt = nowIso();
            state.lastRpc = bodyJson;
        }

        // activeSse 카운트는 "SSE 요청"일 때만 올림
        const isSse = method === "GET" && accept.includes("text/event-stream");
        if (isSse) {
            state.activeSse += 1;
            log("INFO", reqId, "SSE_OPEN", { activeSse: state.activeSse, path: pathname });
            res.on("close", () => {
                state.activeSse = Math.max(0, state.activeSse - 1);
                log("INFO", reqId, "SSE_CLOSE", { activeSse: state.activeSse, path: pathname });
            });
        }

        try {
            // SDK가 method/accept/body를 보고
            // - GET이면 text/event-stream으로 스트림 열고
            // - POST이면 application/json 또는 스트리밍 응답을 처리한다.
            await transport.handleRequest(req, res, bodyJson);
            return;
        } catch (e) {
            log("ERROR", reqId, "TRANSPORT_HANDLE_FAIL", { message: e?.message, stack: e?.stack });
            // 헤더 이미 나갔을 수 있으니 안전 처리
            try {
                if (!res.headersSent) {
                    return writeJson(res, 500, { ok: false, message: e?.message, reqId });
                }
            } catch {}
            try {
                res.end();
            } catch {}
            return;
        }
    }

    // 그 외: 404
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Bridge started :${PORT}`);
    console.log(`LFA base      : ${LOCAL_FILE_AGENT_BASE_URL}`);
    console.log(`Discovery     : http://localhost:${PORT}/mcp`);
    console.log(`Health        : http://localhost:${PORT}/health`);
    console.log(`Debug state   : http://localhost:${PORT}/debug/state`);
});
