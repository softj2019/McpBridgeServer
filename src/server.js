/**
 * Local File Agent MCP Bridge (ALB & Streamable-HTTP OAuth/.well-known FIXED)
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
    lastAgentIp: "",
    lastAgentUa: "",
    lastTokenIssuedAt: "",
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
    // ALB 환경에서 x-forwarded-host가 비는 경우도 있어 host fallback
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

/** =========================
 * local-file-agent fetch
 * ========================= */
async function lfaFetch(path, opts = {}) {
    const { method = "GET", token = "", body } = opts;
    const url = `${LOCAL_FILE_AGENT_BASE_URL}${path}`;

    const headers = {
        "content-type": "application/json",
    };
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
const mcp = new McpServer({ name: "lfa-bridge", version: "1.3.0" });

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

mcp.tool(
    "lfa_file_read",
    "Read file by path",
    z.object({ path: z.string() }),
    async (args, ctx) => {
        const headers = (ctx?.requestContext?.headers || {});
        const token = (headers["x-agent-token"] || DEFAULT_AGENT_TOKEN).toString();

        const qs = new URLSearchParams({ path: args.path });
        const r = await lfaFetch(`/file?${qs.toString()}`, { method: "GET", token });
        return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    }
);

/** =========================
 * HTTP Server
 * ========================= */
const server = http.createServer(async (req, res) => {
    const reqId = randomUUID();
    const ip = getClientIp(req);
    const method = req.method || "GET";
    const rawUrl = req.url || "/";

    // ✅ pathname 기반 라우팅(쿼리/프리픽스/startsWith 사고 방지)
    const parsed = new URL(rawUrl, `http://${req.headers.host || "localhost"}`);
    const pathname = parsed.pathname;

    // CORS (원격 디버깅/브라우저 확인용)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-agent-token");
    res.setHeader("Access-Control-Expose-Headers", "x-agent-token");

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

    // 연결/에러 이벤트(관측 강화)
    req.on("aborted", () => log("WARN", reqId, "REQ_ABORTED_BY_CLIENT"));
    req.on("error", (e) => log("ERROR", reqId, "REQ_STREAM_ERROR", { message: e?.message }));
    res.on("close", () => log("INFO", reqId, "RES_CLOSE"));
    res.on("finish", () => log("INFO", reqId, "RES_FINISH"));

    /** =========================
     * Basic Endpoints
     * ========================= */
    if (pathname === "/health" && method === "GET") {
        return writeJson(res, 200, {
            ok: true,
            name: "lfa-bridge",
            time: nowIso(),
            state,
            lfaBase: LOCAL_FILE_AGENT_BASE_URL,
            tokenFallback: maskToken(DEFAULT_AGENT_TOKEN),
            discovery: "/mcp",
            transport: "/sse",
        });
    }

    if (pathname === "/debug/state" && method === "GET") {
        return writeJson(res, 200, { ok: true, state });
    }

    if (pathname.startsWith("/debug/echo")) {
        const body = await readBody(req);
        return writeJson(res, 200, {
            ok: true,
            method,
            url: rawUrl,
            pathname,
            headers: pickHeaders(req.headers),
            body: body.length ? body.toString("utf-8") : "",
        });
    }

    if (pathname.startsWith("/debug/ping-lfa")) {
        try {
            const token = extractToken(req);
            const r = await lfaFetch("/index/summary", { method: "GET", token });
            return writeJson(res, 200, {
                ok: true,
                token: maskToken(token),
                lfa: r,
            });
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

    /** =========================
     * ✅ OAuth / Well-known (JSON로 반드시 선처리)
     * ========================= */
    // 1) Authorization Server Metadata
    if (pathname === "/mcp/.well-known/oauth-authorization-server" && method === "GET") {
        // issuer는 /mcp로 두는 형태(지금 요청 경로와 일관)
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

    // 2) Protected Resource Metadata
    if (pathname === "/mcp/.well-known/oauth-protected-resource" && method === "GET") {
        const base = `${getProto(req)}://${getHost(req)}`;
        const resource = `${base}/mcp`;

        state.lastDiscoveryAt = nowIso();

        return writeJson(
            res,
            200,
            {
                resource,
                authorization_servers: [resource],
            },
            { "cache-control": "no-store" }
        );
    }

    // 3) Token Endpoint (최소 구현: client_credentials)
    if (pathname === "/mcp/oauth/token" && method === "POST") {
        const token = extractToken(req);
        state.lastTokenIssuedAt = nowIso();

        return writeJson(
            res,
            200,
            {
                access_token: token,
                token_type: "Bearer",
                expires_in: 3600,
            },
            { "cache-control": "no-store" }
        );
    }

    /** =========================
     * ✅ MCP Discovery Endpoint
     * ========================= */
    if (pathname === "/mcp" && (method === "GET" || method === "POST")) {
        state.lastDiscoveryAt = nowIso();
        state.lastAgentIp = ip;
        state.lastAgentUa = (req.headers["user-agent"] || "").toString();

        const base = `${getProto(req)}://${getHost(req)}`;
        const payload = {
            protocol: "mcp",
            transport: "streamable-http",
            // ✅ transport는 /sse로 고정( /mcp/* 와 절대 충돌 금지 )
            sseEndpoint: "/sse",
            endpoints: {
                sse: `${base}/sse`,
                health: `${base}/health`,
                debugEcho: `${base}/debug/echo`,
                debugPingLfa: `${base}/debug/ping-lfa`,
                debugState: `${base}/debug/state`,
                // OAuth discovery (클라이언트가 필요시 조회)
                oauthAuthorizationServer: `${base}/mcp/.well-known/oauth-authorization-server`,
                oauthProtectedResource: `${base}/mcp/.well-known/oauth-protected-resource`,
                oauthToken: `${base}/mcp/oauth/token`,
            },
        };

        log("INFO", reqId, "MCP_DISCOVERY_OK", payload);
        return writeJson(res, 200, payload, { "cache-control": "no-store" });
    }

    /** =========================
     * ✅ Transport Endpoint (/sse만 허용)
     * - /mcp/.well-known/* 를 절대 잡아먹지 않게 경로를 완전히 분리
     * ========================= */
    if (pathname === "/sse") {
        state.lastSseAt = nowIso();

        const token = extractToken(req);
        log("INFO", reqId, "SSE_ENTER", { token: maskToken(token) });

        // ✅ 프록시 버퍼링 힌트 (프로토콜 바디는 SDK가 관리)
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        // activeSse 카운팅 안정화
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
            });
        });

        req.on("aborted", () => {
            log("WARN", reqId, "SSE_REQ_ABORTED", { aliveMs: Date.now() - startMs });
        });

        try {
            state.activeSse += 1;
            counted = true;
            log("INFO", reqId, "SSE_ACTIVE_INC", { activeSse: state.activeSse });

            // ✅ StreamableHTTPServerTransport 생성
            const transport = new StreamableHTTPServerTransport(req, res, {
                requestContext: {
                    reqId,
                    ip,
                    headers: {
                        ...Object.fromEntries(
                            Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : (v ?? "")])
                        ),
                        // tool ctx에서 토큰 바로 쓰기 좋게 정규화
                        "x-agent-token": token,
                    },
                },
            });

            log("INFO", reqId, "SSE_TRANSPORT_CREATED");

            await mcp.connect(transport);

            log("INFO", reqId, "SSE_MCP_CONNECTED");
            // 연결 유지: SDK가 스트림 수명 관리
            return;
        } catch (e) {
            decActive();
            log("ERROR", reqId, "SSE_CONNECT_FAIL", {
                message: e?.message,
                stack: e?.stack,
            });

            // transport가 이미 response를 잡고 있을 수 있으니 안전 종료
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

    /** =========================
     * 404
     * ========================= */
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Bridge started :${PORT}`);
    console.log(`LFA base      : ${LOCAL_FILE_AGENT_BASE_URL}`);
    console.log(`Discovery     : http://localhost:${PORT}/mcp`);
    console.log(`Transport     : http://localhost:${PORT}/sse`);
    console.log(`Health        : http://localhost:${PORT}/health`);
    console.log(`Debug state   : http://localhost:${PORT}/debug/state`);
});
