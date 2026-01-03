/**
 * Local File Agent MCP Bridge (Streamable HTTP) - AWS ALB & External optimized
 * * ✅ 수정 및 전제 조건:
 * 1) ALB 설정: Idle Timeout 3600초, 호스트 헤더 보존(Host Header Preservation) 활성화
 * 2) 로컬 PC: EC2의 Public IP로부터 4312 포트 인바운드 허용 (또는 Reverse SSH 터널링)
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// =========================
// ✅ 환경 변수 및 설정
// =========================
const LOCAL_FILE_AGENT_BASE_URL = process.env.LOCAL_FILE_AGENT_BASE_URL || "http://58.121.142.180:4312";
const PORT = Number(process.env.PORT || 8787);
const DEFAULT_AGENT_TOKEN = process.env.AGENT_TOKEN || "73025532";
const LOG_LEVEL = String(process.env.LOG_LEVEL || "debug").toLowerCase();

// =========================
// Utility Functions
// =========================
const nowISO = () => new Date().toISOString();
const redact = (s) => (s && s.length > 6 ? `${s.slice(0, 3)}***${s.slice(-3)}` : "***");

function getClientIp(req) {
    const xf = req.headers["x-forwarded-for"];
    return xf ? xf.split(",")[0].trim() : req.socket.remoteAddress;
}

function getProto(req) {
    return req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
}

function getHost(req) {
    // ALB에서 '호스트 헤더 보존' 옵션을 켰을 경우 host 헤더를 그대로 사용 가능
    return req.headers["x-forwarded-host"] || req.headers["host"] || `localhost:${PORT}`;
}

function withCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-agent-token, Last-Event-ID");
    res.setHeader("Access-Control-Expose-Headers", "x-agent-token");
}

// =========================
// LFA Communication (EC2 -> Local PC)
// =========================
async function lfaFetch(path, args = {}) {
    const method = args.method || "GET";
    const token = args.token || "";
    const url = `${LOCAL_FILE_AGENT_BASE_URL}${path}`;
    const reqId = args.reqId || "no-reqid";

    const headers = {
        ...(method === "POST" && { "Content-Type": "application/json" }),
        ...(token && { "x-agent-token": token })
    };

    try {
        const res = await fetch(url, {
            method,
            headers,
            body: method === "POST" ? JSON.stringify(args.body || {}) : undefined,
            signal: AbortSignal.timeout(10000) // 10초 타임아웃
        });

        const text = await res.text();
        if (!res.ok) throw new Error(`LFA Error ${res.status}: ${text}`);
        return JSON.parse(text);
    } catch (err) {
        console.error(`[${reqId}] LFA_FETCH_FAILED: ${url}`, err.message);
        throw err;
    }
}

// =========================
// MCP Server & Tools Definition
// =========================
const mcp = new McpServer({ name: "local-file-agent-bridge", version: "1.1.0" });

mcp.tool("lfa_index_summary", "Get index cache summary", z.object({}), async (_, ctx) => {
    const { reqId, headers } = ctx.requestContext;
    const data = await lfaFetch("/index/summary", { token: headers["x-agent-token"], reqId });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

mcp.tool("lfa_file_read", "Read file content", z.object({ path: z.string() }), async (args, ctx) => {
    const { reqId, headers } = ctx.requestContext;
    const qs = new URLSearchParams({ path: args.path });
    const data = await lfaFetch(`/file?${qs.toString()}`, { token: headers["x-agent-token"], reqId });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// (기존 도구들 동일 로직으로 유지됨...)

// =========================
// HTTP Server Routes
// =========================
const httpServer = http.createServer(async (req, res) => {
    const reqId = randomUUID();
    const url = req.url || "/";

    // CORS 및 기본 응답 설정
    withCors(res);
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    console.log(`[${nowISO()}] [${reqId}] ${req.method} ${url} (IP: ${getClientIp(req)})`);

    // 1. Discovery
    if (url === "/mcp" || url === "/mcp/") {
        const base = `${getProto(req)}://${getHost(req)}`;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            protocol: "mcp",
            transport: "streamable-http",
            sseEndpoint: `${base}/sse`,
            endpoints: {
                health: `${base}/health`,
                debug: `${base}/debug/ping-lfa`
            }
        }));
        return;
    }

    // 2. SSE (핵심 수정 지점)
    if (url.startsWith("/sse")) {
        try {
            const token = req.headers["x-agent-token"] || DEFAULT_AGENT_TOKEN;

            // ALB/Proxy 버퍼링 방지 및 연결 유지 설정
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no" // ALB 및 Nginx 버퍼링 해제
            });

            const transport = new StreamableHTTPServerTransport(req, res, {
                requestContext: { reqId, headers: { "x-agent-token": token } },
            });

            await mcp.connect(transport);
            console.log(`[${reqId}] SSE Connected (Token: ${redact(token)})`);
        } catch (e) {
            console.error(`[${reqId}] SSE_INIT_ERROR:`, e.message);
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: e.message }));
            }
        }
        return;
    }

    // 3. Health & Debug
    if (url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, bridge: "online", lfa_target: LOCAL_FILE_AGENT_BASE_URL }));
        return;
    }

    if (url === "/debug/ping-lfa") {
        try {
            const data = await lfaFetch("/index/summary", { token: DEFAULT_AGENT_TOKEN, reqId });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "LFA_REACHABLE", data }));
        } catch (e) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "LFA_UNREACHABLE", error: e.message }));
        }
        return;
    }

    res.writeHead(404);
    res.end("Not Found");
});

httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 MCP Bridge is running on port ${PORT}`);
    console.log(`🔗 Local LFA Target: ${LOCAL_FILE_AGENT_BASE_URL}`);
    console.log(`📡 Discovery URL: http://localhost:${PORT}/mcp\n`);
});