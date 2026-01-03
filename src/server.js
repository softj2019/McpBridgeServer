/**
 * Local File Agent MCP Bridge (ALB & SSE Optimized)
 * * ✅ 수정 포인트:
 * 1) ALB 버퍼링 방지 (no-transform, X-Accel-Buffering)
 * 2) 호스트 헤더 보존 대응 (x-forwarded-host)
 * 3) 초기 핑(Keep-alive) 즉시 전송으로 504 방지
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const LOCAL_FILE_AGENT_BASE_URL = process.env.LOCAL_FILE_AGENT_BASE_URL || "http://58.121.142.180:4312";
const PORT = Number(process.env.PORT || 8787);
const DEFAULT_AGENT_TOKEN = "73025532";

const mcp = new McpServer({ name: "lfa-bridge", version: "1.2.0" });

// --- 유틸리티 함수 ---
const getProto = (req) => req.headers["x-forwarded-proto"] || "http";
const getHost = (req) => req.headers["x-forwarded-host"] || req.headers["host"];

// --- 도구 등록 (핵심 도구 예시) ---
mcp.tool("lfa_health", "Check local agent health", z.object({}), async (_, ctx) => {
    const res = await fetch(`${LOCAL_FILE_AGENT_BASE_URL}/health`, {
        headers: { "x-agent-token": ctx.requestContext.headers["x-agent-token"] }
    });
    return { content: [{ type: "text", text: await res.text() }] };
});

// (여기에 기존 lfa_index_summary, lfa_file_read 등 도구들을 추가하세요)

// --- HTTP 서버 ---
const server = http.createServer(async (req, res) => {
    const reqId = randomUUID();
    const url = req.url || "/";

    // 1. CORS 설정
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-agent-token");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    // 2. Discovery Endpoint
    if (url === "/mcp") {
        const base = `${getProto(req)}://${getHost(req)}`;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            protocol: "mcp",
            transport: "streamable-http",
            sseEndpoint: `${base}/sse`
        }));
        return;
    }

    // 3. SSE Endpoint (핵심 고도화 지점)
    if (url.startsWith("/sse")) {
        try {
            const token = req.headers["x-agent-token"] || DEFAULT_AGENT_TOKEN;

            // ✅ ALB 504 및 버퍼링 방지를 위한 헤더 세트
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform", // ALB 버퍼링 방지 핵심
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",                  // Nginx 버퍼링 방지
                "Access-Control-Expose-Headers": "x-agent-token"
            });

            // ✅ 즉시 응답을 시작하여 ALB가 연결 수립을 인지하게 함
            res.write(": connection established\n\n");

            const transport = new StreamableHTTPServerTransport(req, res, {
                requestContext: { reqId, headers: { "x-agent-token": token } },
            });

            await mcp.connect(transport);
            console.log(`[${reqId}] SSE Connected to ${getHost(req)}`);
        } catch (e) {
            console.error(`[${reqId}] SSE Error:`, e.message);
            if (!res.headersSent) {
                res.writeHead(500);
                res.end(e.message);
            }
        }
        return;
    }

    res.writeHead(404);
    res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Bridge started on port ${PORT}, targeting LFA: ${LOCAL_FILE_AGENT_BASE_URL}`);
});