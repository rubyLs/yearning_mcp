#!/usr/bin/env node
/**
 * Yearning MCP Server 入口。
 *
 * MCP_TRANSPORT:
 *   - stdio（默认）：本地 AI 客户端
 *   - sse：已废弃，仍可用
 *   - streamable-http：远程 HTTP，端点 /mcp
 */

import { randomUUID } from "node:crypto";
import express from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function extractToken(req: express.Request): string | undefined {
  const auth = req.header("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return (
    req.header("x-auth-token")?.trim() ||
    req.header("x-mcp-token")?.trim() ||
    undefined
  );
}

async function runStdio(): Promise<void> {
  const config = loadConfig();
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[yearning-mcp] stdio 已启动（readOnly=${config.yearning.readOnly}）`,
  );
}

async function runHttp(transportKind: "sse" | "streamable-http"): Promise<void> {
  const config = loadConfig();
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  if (config.mcp.authToken) {
    app.use((req, res, next) => {
      if (req.path === "/health") return next();
      const token = extractToken(req);
      if (!token || !timingSafeEqual(token, config.mcp.authToken!)) {
        res.status(401).json({
          error: "unauthorized",
          message: "missing or invalid MCP auth token",
        });
        return;
      }
      next();
    });
    console.error("[yearning-mcp] HTTP 接口认证已启用");
  } else {
    console.error(
      "[yearning-mcp] 警告：MCP_AUTH_TOKEN 未设置，HTTP 接口无鉴权，生产环境请务必配置",
    );
  }

  if (transportKind === "sse") {
    console.error("[yearning-mcp] SSE 传输已废弃，建议切换至 streamable-http");
    const sessions = new Map<string, SSEServerTransport>();

    app.get("/sse", async (req, res) => {
      const server = createServer(config);
      const transport = new SSEServerTransport("/messages", res);
      sessions.set(transport.sessionId, transport);
      res.on("close", () => sessions.delete(transport.sessionId));
      await server.connect(transport);
    });

    app.post("/messages", async (req, res) => {
      const sessionId = String(req.query.sessionId || "");
      const transport = sessions.get(sessionId);
      if (!transport) {
        res.status(404).send("Unknown session");
        return;
      }
      await transport.handlePostMessage(req, res, req.body);
    });
  } else {
    // streamable-http
    if (config.mcp.statelessHttp) {
      app.all("/mcp", async (req, res) => {
        const server = createServer(config);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      });
      console.error("[yearning-mcp] 已启用 Stateless HTTP 模式");
    } else {
      const transports = new Map<string, StreamableHTTPServerTransport>();

      app.all("/mcp", async (req, res) => {
        const sessionId = req.header("mcp-session-id");
        let transport = sessionId ? transports.get(sessionId) : undefined;

        if (!transport) {
          if (req.method !== "POST") {
            res.status(400).json({
              error: "invalid_session",
              message: "缺少有效会话，请先 POST 初始化",
            });
            return;
          }
          const server = createServer(config);
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, transport!);
            },
          });
          transport.onclose = () => {
            const id = transport!.sessionId;
            if (id) transports.delete(id);
          };
          await server.connect(transport);
        }

        await transport.handleRequest(req, res, req.body);
      });
    }
  }

  const { host, port } = config.mcp;
  const endpoint = transportKind === "sse" ? "/sse" : "/mcp";
  app.listen(port, host, () => {
    console.error(
      `[yearning-mcp] ${transportKind} 监听 http://${host}:${port}${endpoint}（readOnly=${config.yearning.readOnly}）`,
    );
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.mcp.transport === "stdio") {
    await runStdio();
    return;
  }
  await runHttp(config.mcp.transport);
}

main().catch((err) => {
  console.error("[yearning-mcp] 启动失败:", err);
  process.exit(1);
});
