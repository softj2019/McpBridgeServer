/**
 * Local File Agent MCP Bridge (ALB & Streamable-HTTP Debug Enhanced)
 *
 * ✅ 수정해야 할 부분
 * 1) LOCAL_FILE_AGENT_BASE_URL: local-file-agent 주소
 * 2) DEFAULT_AGENT_TOKEN 또는 LFA_TOKEN(env): Agent Builder가 토큰을 안 보내면 fallback
 * 3) PORT: 서비스 포트
 * 4) PING_INTERVAL_MS: SSE keepalive 주기(너무 짧게 하면 비용/로그 증가)
 *
 * 실행:
 *   node server.js
 *
 * ENV:
 *   PORT=8787
 *   LOCAL_FILE_AGENT_BASE_URL=http://127.0.0.1:4312
 *   LFA_TOKEN=xxxx
 *   PING_INTERVAL_MS=15000
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
    process.env.LOCAL_FILE_AGENT_BASE_URL || "";

const PORT = Number(process.env.PORT || 8787);

// Agent Builder가 x-agent-token을 안 보낼 때 대비 (ENV 우선)
const DEFAULT_AGENT_TOKEN = (process.env.LFA_TOKEN || "").trim();

// SSE 연결 유지(관측/디버깅 목적)
// - ALB idle timeout, 중간 프록시 등에 의해 조용히 끊기는지 확인 가능
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 15000);

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
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders });
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
const mcp = new McpServer({ name: "lfa-bridge", version: "1.2.0" });

mcp.tool("lfa_health", "Check local agent health", z.object({}), async (_args, ctx) => {
    const headers = (ctx?.requestContext?.headers || {});
    const token = (headers["x-agent-token"] || DEFAULT_AGENT_TOKEN).toString();

    const r = await lfaFetch("/health", { method: "GET", token });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
});

// ✅ 여기부터 네가 쓰던 핵심 도구를 “동일 패턴”으로 추가하면 됨
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
    const url = req.url || "/";
    const method = req.method || "GET";

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
        url,
        proto: getProto(req),
        host: getHost(req),
        headers: pickHeaders(req.headers),
    });

    // 연결/에러 이벤트(관측 강화)
    req.on("aborted", () => log("WARN", reqId, "REQ_ABORTED_BY_CLIENT"));
    req.on("error", (e) => log("ERROR", reqId, "REQ_STREAM_ERROR", { message: e?.message }));
    res.on("close", () => log("INFO", reqId, "RES_CLOSE"));
    res.on("finish", () => log("INFO", reqId, "RES_FINISH"));

    // health
    if (url === "/health" && method === "GET") {
        return writeJson(res, 200, {
            ok: true,
            name: "lfa-bridge",
            time: nowIso(),
            state,
            lfaBase: LOCAL_FILE_AGENT_BASE_URL,
            tokenFallback: maskToken(DEFAULT_AGENT_TOKEN),
            pingIntervalMs: PING_INTERVAL_MS,
        });
    }

    // debug state
    if (url === "/debug/state" && method === "GET") {
        return writeJson(res, 200, { ok: true, state });
    }

    // debug echo (요청 바디/헤더 확인)
    if (url.startsWith("/debug/echo")) {
        const body = await readBody(req);
        return writeJson(res, 200, {
            ok: true,
            method,
            url,
            headers: pickHeaders(req.headers),
            body: body.length ? body.toString("utf-8") : "",
        });
    }

    // debug ping lfa (브릿지->LFA 통신이 되는지 확인)
    if (url.startsWith("/debug/ping-lfa")) {
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

    // ✅ Discovery Endpoint
    // Agent Builder는 여기(/mcp)를 먼저 호출
    if (url === "/mcp" && (method === "GET" || method === "POST")) {
        state.lastDiscoveryAt = nowIso();
        state.lastAgentIp = ip;
        state.lastAgentUa = (req.headers["user-agent"] || "").toString();

        const base = `${getProto(req)}://${getHost(req)}`;
        const payload = {
            protocol: "mcp",
            transport: "streamable-http",
            // 주의: sseEndpoint는 "경로"만 기대하는 구현도 있고 "절대URL"을 기대하는 구현도 있어 혼합 제공
            sseEndpoint: "/sse",
            endpoints: {
                sse: `${base}/sse`,
                health: `${base}/health`,
                debugEcho: `${base}/debug/echo`,
                debugPingLfa: `${base}/debug/ping-lfa`,
                debugState: `${base}/debug/state`,
            },
        };

        log("INFO", reqId, "MCP_DISCOVERY_OK", payload);
        return writeJson(res, 200, payload);
    }

    // ✅ Transport Endpoint
    // 일부 구현은 /mcp 자체를 transport로 때릴 수 있어 /mcp or /sse 모두 허용
    if (url.startsWith("/sse") || url.startsWith("/mcp")) {
        // /mcp GET/POST는 위에서 discovery로 처리했으니,
        // 여기까지 왔다는 건 streamable-http transport로 들어온 요청 가능성이 큼.
        state.lastSseAt = nowIso();

        const token = extractToken(req);
        log("INFO", reqId, "SSE_ENTER", { token: maskToken(token) });

        // ✅ ALB/프록시 버퍼링 방지 & 즉시 응답 시작(관측)
        // (중요) streamable-http transport는 SDK가 헤더/응답을 제어할 수 있으므로
        // 여기서 "event-stream"을 강제하면 오히려 깨질 수 있어.
        // 대신, 버퍼링 방지 헤더만 선제 설정하고, 본문은 SDK가 처리하도록 둔다.
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        // ✅ "연결이 실제로 열렸는지" 확인용 아주 작은 프리플라이트 flush
        // Node http는 res.flushHeaders()로 헤더를 즉시 밀어낼 수 있음
        try {
            res.flushHeaders?.();
            log("INFO", reqId, "SSE_HEADERS_FLUSHED");
        } catch (e) {
            log("WARN", reqId, "SSE_FLUSH_HEADERS_FAIL", { message: e?.message });
        }

        // ✅ 연결 유지/관측용 ping
        // - 실제 MCP 프로토콜 데이터와 충돌을 피하려면 "주기적 write"는 조심해야 함.
        // - 여기서는 '연결 유지 목적'으로 매우 짧은 코멘트만 쓰고,
        //   만약 문제 생기면 PING_INTERVAL_MS=0으로 꺼도 됨.
        let pingTimer = null;
        const startMs = Date.now();

        function startPing() {
            if (!PING_INTERVAL_MS || PING_INTERVAL_MS <= 0) return;
            pingTimer = setInterval(() => {
                try {
                    // streamable-http에서 body는 SDK가 주로 관리하지만,
                    // 실제 환경에서 "아무 트래픽도 없으면 끊기는지" 확인을 위해 최소한의 keepalive 시도.
                    // 문제가 의심되면 바로 꺼서 테스트.
                    res.write(`\n`); // 최소 keepalive
                    log("DEBUG", reqId, "SSE_PING_WRITE", { t: Date.now() - startMs });
                } catch (e) {
                    log("WARN", reqId, "SSE_PING_WRITE_FAIL", { message: e?.message });
                }
            }, PING_INTERVAL_MS);
        }

        function stopPing() {
            if (pingTimer) clearInterval(pingTimer);
            pingTimer = null;
        }

        res.on("close", () => {
            stopPing();
            state.activeSse = Math.max(0, state.activeSse - 1);
            log("INFO", reqId, "SSE_RES_CLOSE", { activeSse: state.activeSse, aliveMs: Date.now() - startMs });
        });

        req.on("aborted", () => {
            stopPing();
            log("WARN", reqId, "SSE_REQ_ABORTED", { aliveMs: Date.now() - startMs });
        });

        try {
            state.activeSse += 1;
            log("INFO", reqId, "SSE_ACTIVE_INC", { activeSse: state.activeSse });

            startPing();

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
            // 여기서 끝나면 “연결은 되었는데, 툴 호출이 없는 상태”일 수 있음.
            return;
        } catch (e) {
            stopPing();
            state.activeSse = Math.max(0, state.activeSse - 1);

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

    // 404
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
