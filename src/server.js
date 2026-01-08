/**
 * Local File Agent MCP Bridge (ALB + Streamable HTTP + GPT Agent MCP Compatibility)
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

    // ✅ OpenAI/GPT 에이전트 모드 디버깅용 카운터
    reqCounters: {
        total: 0,
        mcp: { get: 0, post: 0 },
        sse: { get: 0, post: 0 },
        wellKnown: { authServer: 0, protectedResource: 0 },
        oauthToken: { post: 0 },
        debug: { echo: 0, pingLfa: 0, state: 0, lastRpc: 0 },
    },

    // ✅ 마지막으로 관측한 "MCP 메시지/RPC" 단서(실제로는 SDK 내부라 제한적)
    lastRpc: {
        at: "",
        ip: "",
        ua: "",
        method: "",
        path: "",
        headersHint: {},
        bodyPreview: "",
        bodyBytes: 0,
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
 * ✅ 디버깅: "마지막 RPC/메시지" 스냅샷(최대 N bytes)
 * - StreamableHTTPServerTransport 내부 payload는 SDK가 처리하므로,
 *   여기서는 POST 요청이 들어왔는지, 대략 어떤 바디인지 정도만 기록한다.
 * ========================= */
async function snapshotIncomingBodyIfAny(req, { pathname, ip }) {
    // GET은 바디가 거의 없으니 스킵
    const method = (req.method || "GET").toUpperCase();
    if (method !== "POST" && method !== "PUT" && method !== "PATCH") return;

    // content-type 힌트가 JSON-ish일 때만 캡처(보안/노이즈 줄이기)
    const ct = String(req.headers["content-type"] || "");
    const looksJson = ct.includes("application/json") || ct.includes("json") || ct.includes("text/plain");

    if (!looksJson) return;

    const bodyBuf = await readBody(req);
    const max = 8192; // 8KB 프리뷰 제한
    const previewBuf = bodyBuf.slice(0, max);
    const preview = previewBuf.toString("utf-8");

    // 민감정보 마스킹(아주 기본)
    const masked = preview
        .replace(/"authorization"\s*:\s*"[^"]*"/gi, `"authorization":"****"`)
        .replace(/"access_token"\s*:\s*"[^"]*"/gi, `"access_token":"****"`)
        .replace(/"x-agent-token"\s*:\s*"[^"]*"/gi, `"x-agent-token":"****"`)
        .replace(/bearer\s+[a-z0-9\-\._~\+\/]+=*/gi, "bearer ****");

    state.lastRpc = {
        at: nowIso(),
        ip,
        ua: String(req.headers["user-agent"] || ""),
        method,
        path: pathname,
        headersHint: pickHeaders(req.headers),
        bodyPreview: masked,
        bodyBytes: bodyBuf.length,
        note:
            bodyBuf.length > max
                ? `bodyPreview truncated to ${max} bytes`
                : "bodyPreview captured",
    };
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
const mcp = new McpServer({ name: "lfa-bridge", version: "1.4.0" });

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
    const method = (req.method || "GET").toUpperCase();
    const rawUrl = req.url || "/";

    // ✅ pathname 기반 라우팅(쿼리/프리픽스/startsWith 사고 방지)
    const parsed = new URL(rawUrl, `http://${req.headers.host || "localhost"}`);
    const pathname = parsed.pathname;

    state.reqCounters.total += 1;

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
                transport: "/sse",
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
            {
                ok: true,
                method,
                url: rawUrl,
                pathname,
                headers: pickHeaders(req.headers),
                body: body.length ? body.toString("utf-8") : "",
            },
            { "cache-control": "no-store" }
        );
    }

    if (pathname.startsWith("/debug/ping-lfa")) {
        state.reqCounters.debug.pingLfa += 1;
        try {
            const token = extractToken(req);
            const r = await lfaFetch("/index/summary", { method: "GET", token });
            return writeJson(
                res,
                200,
                {
                    ok: true,
                    token: maskToken(token),
                    lfa: r,
                },
                { "cache-control": "no-store" }
            );
        } catch (e) {
            log("ERROR", reqId, "DEBUG_PING_LFA_FAIL", {
                message: e?.message,
                status: e?.status,
                ms: e?.ms,
                payload: e?.payload,
            });
            return writeJson(
                res,
                500,
                {
                    ok: false,
                    message: e?.message,
                    status: e?.status,
                    ms: e?.ms,
                    payload: e?.payload,
                },
                { "cache-control": "no-store" }
            );
        }
    }

    /** =========================
     * ✅ OAuth / Well-known (JSON로 반드시 선처리)
     * ========================= */
    // 1) Authorization Server Metadata
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

    // 2) Protected Resource Metadata
    if (pathname === "/mcp/.well-known/oauth-protected-resource" && method === "GET") {
        state.reqCounters.wellKnown.protectedResource += 1;

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
        state.reqCounters.oauthToken.post += 1;

        // body는 필요하면 읽어서 grant_type 검증도 가능하지만, 여기선 최소 구현
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
     * - GPT/에이전트 호환성을 위해 sseEndpoint(상대), endpoints.sse(절대),
     *   sseUrl(절대 별칭), endpoints.messages(POST 대상 힌트) 모두 제공
     * ========================= */
    if (pathname === "/mcp" && (method === "GET" || method === "POST")) {
        if (method === "GET") state.reqCounters.mcp.get += 1;
        else state.reqCounters.mcp.post += 1;

        state.lastDiscoveryAt = nowIso();
        state.lastAgentIp = ip;
        state.lastAgentUa = (req.headers["user-agent"] || "").toString();

        const base = `${getProto(req)}://${getHost(req)}`;
        const payload = {
            protocol: "mcp",
            transport: "streamable-http",

            // ✅ 상대 경로(일부 구현이 이 값을 사용)
            sseEndpoint: "/sse",

            // ✅ 절대 URL 별칭(일부 구현이 절대 URL을 선호/요구)
            sseUrl: `${base}/sse`,

            endpoints: {
                // ✅ SSE 채널
                sse: `${base}/sse`,

                // ✅ 메시지 전송(POST) 대상 힌트: 같은 엔드포인트로 POST가 들어오도록 유도
                messages: `${base}/sse`,

                health: `${base}/health`,
                debugEcho: `${base}/debug/echo`,
                debugPingLfa: `${base}/debug/ping-lfa`,
                debugState: `${base}/debug/state`,
                debugLastRpc: `${base}/debug/last-rpc`,

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
     * ✅ Transport Endpoint (/sse)
     * - /mcp/.well-known/* 를 절대 잡아먹지 않게 경로를 완전히 분리
     * - GET: SSE 채널
     * - POST: (일부 구현에서) 메시지 전송에 사용될 수 있음 → 관측 위해 바디 스냅샷 기록
     * ========================= */
    if (pathname === "/sse") {
        // ✅ GPT 클라이언트가 POST로 메시지를 보낼 수 있어, 바디를 먼저 스냅샷(필요한 경우)
        //    단, 이 readBody는 스트림을 소비하므로 "항상" 하면 SDK와 충돌할 수 있다.
        //    따라서 "관측 목적"으로만 제한적으로 수행한다:
        //    - content-type이 JSON-ish이고
        //    - method가 POST일 때만
        //
        // ⚠️ 중요: POST 바디를 여기서 읽어버리면 SDK가 바디를 못 읽을 수 있다.
        //         그래서 POST일 때는 "스냅샷"을 포기하고, 대신 헤더/메서드만 기록하는 모드로 변경.
        //
        // 결론: 안전 최우선으로 POST 바디는 읽지 않고, 힌트만 기록한다.
        state.lastSseAt = nowIso();

        if (method === "GET") state.reqCounters.sse.get += 1;
        else if (method === "POST") state.reqCounters.sse.post += 1;

        // ✅ 최소 관측(바디는 읽지 않음: SDK와 충돌 방지)
        state.lastRpc = {
            at: nowIso(),
            ip,
            ua: String(req.headers["user-agent"] || ""),
            method,
            path: pathname,
            headersHint: pickHeaders(req.headers),
            bodyPreview: "",
            bodyBytes: 0,
            note:
                method === "POST"
                    ? "POST received on /sse (body not captured to avoid consuming stream before SDK)"
                    : "SSE channel connected (GET)",
        };

        const token = extractToken(req);
        log("INFO", reqId, "SSE_ENTER", { token: maskToken(token) });

        // ✅ 프록시 버퍼링 힌트 (바디는 SDK가 관리)
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
                    return writeJson(res, 500, { ok: false, message: e?.message, reqId }, { "cache-control": "no-store" });
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
    console.log(`Debug lastRpc : http://localhost:${PORT}/debug/last-rpc`);
});
