/**
 * Local File Agent MCP Bridge (OpenAI MCP 호환 최종본)
 *
 * ✅ 수정해야 할 부분
 * 1) LOCAL_FILE_AGENT_BASE_URL: local-file-agent 주소
 * 2) DEFAULT_AGENT_TOKEN 또는 LFA_TOKEN(env)
 * 3) PORT
 *
 * 핵심 수정:
 * - OpenAI(openai-mcp/1.0.0)는 POST /mcp 를 discovery로도 쓰고,
 *   실제 MCP transport(JSON-RPC initialize 등)로도 씀.
 * - req stream을 소비(바디를 읽기)하면 StreamableHTTPServerTransport가 깨지므로
 *   "Content-Length" 기반으로만 안전 분기:
 *    - Content-Length가 거의 0이면 discovery JSON 응답
 *    - 그 외(바디가 있으면) transport로 처리
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
        discovery: { mcpGet: 0, mcpPost: 0, mcpJson: 0 },
        oauth: { authServer: 0, protectedResource: 0, token: 0 },
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

/**
 * 세션 식별자 감지(없을 수도 있음)
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
const mcp = new McpServer({ name: "lfa-bridge", version: "2.5.0" });

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

        // OpenAI 쪽은 /mcp 를 “단일 엔드포인트”로 쓰는 경우가 많아
        // sseEndpoint도 /mcp 로 주는 게 가장 호환이 좋음
        sseEndpoint: "/mcp",
        sseUrl: `${base}/mcp`,
        endpoints: {
            sse: `${base}/mcp`,
            messages: `${base}/mcp`,
            health: `${base}/health`,
            oauthAuthorizationServer: `${base}/mcp/.well-known/oauth-authorization-server`,
            oauthProtectedResource: `${base}/mcp/.well-known/oauth-protected-resource`,
            oauthToken: `${base}/mcp/oauth/token`,
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
async function handleTransport(req, res, { reqId, ip, pathname }) {
    state.lastSseAt = nowIso();

    // ✅ GET SSE는 반드시 event-stream (OpenAI가 이걸 강하게 체크함)
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

    // 공통 응답 이벤트 로그
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

    // 안전 분기용 content-length (req stream을 소비하면 안 됨!)
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
        sessionId: sessionId ? `${sessionId.slice(0, 6)}...` : "",
        contentLength,
    });

    // health
    if (pathname === "/health" && method === "GET") {
        state.counters.health += 1;
        return writeJson(res, 200, { ok: true, time: nowIso(), state }, { "cache-control": "no-store" });
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

    // OAuth token endpoint
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

    // discovery 전용(폼/디버깅용)
    if (pathname === "/mcp.json" && method === "GET") {
        state.counters.discovery.mcpJson += 1;
        state.lastDiscoveryAt = nowIso();
        state.lastAgentIp = ip;
        state.lastAgentUa = ua;
        return writeJson(res, 200, buildDiscovery(req), { "cache-control": "no-store" });
    }

    // 루트 200
    if (pathname === "/" && method === "GET") {
        return writeJson(
            res,
            200,
            { ok: true, name: "lfa-bridge", time: nowIso(), discovery: "/mcp.json", mcp: "/mcp" },
            { "cache-control": "no-store" }
        );
    }

    /**
     * ✅ /mcp : discovery + transport 혼합 대응
     */
    if (pathname === "/mcp" && method === "GET") {
        // event-stream이면 transport
        if (wantsEventStream(req)) {
            state.counters.transport.mcpGet += 1;
            return handleTransport(req, res, { reqId, ip, pathname: "/mcp" });
        }

        // 그 외는 discovery
        state.counters.discovery.mcpGet += 1;
        state.lastDiscoveryAt = nowIso();
        state.lastAgentIp = ip;
        state.lastAgentUa = ua;
        log("INFO", reqId, "DISCOVERY_RETURNED", { via: "GET /mcp" });
        return writeJson(res, 200, buildDiscovery(req), { "cache-control": "no-store" });
    }

    if (pathname === "/mcp" && method === "POST") {
        /**
         * ★ 가장 중요한 분기
         * - POST /mcp 가 "discovery"로도 오고, "JSON-RPC initialize/호출"로도 옴.
         * - req body를 읽어서 판별하면 transport가 깨질 수 있으니 절대 읽지 않음.
         *
         * 안전한 현실적 규칙:
         * - Content-Length가 아주 작으면(0~2 정도) discovery로 간주
         * - 그 외(바디가 있으면) transport로 간주
         */
        const DISCOVERY_MAX_LEN = 2; // 필요하면 10까지 올려도 됨

        if (contentLength <= DISCOVERY_MAX_LEN) {
            state.counters.discovery.mcpPost += 1;
            state.lastDiscoveryAt = nowIso();
            state.lastAgentIp = ip;
            state.lastAgentUa = ua;
            log("INFO", reqId, "DISCOVERY_RETURNED", {
                via: "POST /mcp",
                note: `content-length<=${DISCOVERY_MAX_LEN}`,
            });
            return writeJson(res, 200, buildDiscovery(req), { "cache-control": "no-store" });
        }

        // 바디가 있으면: 대부분 initialize/도구호출 등 MCP 메시지
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
    console.log(`OAuth authsrv : http://localhost:${PORT}/mcp/.well-known/oauth-authorization-server`);
    console.log(`OAuth protect : http://localhost:${PORT}/mcp/.well-known/oauth-protected-resource`);
    console.log(`OAuth token   : http://localhost:${PORT}/mcp/oauth/token`);
    console.log(`Health        : http://localhost:${PORT}/health`);
});
