#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createChiasmusServer } from "./mcp-server.js";
import type { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import type { SkillLibrary } from "./skills/library.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3939;
const DEFAULT_PATH = "/mcp";
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

type HttpOptions = {
  host: string;
  port: number;
  path: string;
  sessionTtlMs: number;
  chiasmusHome?: string;
};

type Session = {
  transport: StreamableHTTPServerTransport;
  server: McpProtocolServer;
  library: SkillLibrary;
  idleTimer: NodeJS.Timeout;
};

type JsonRpcErrorCode = -32700 | -32603 | -32000;

function jsonRpcError(code: JsonRpcErrorCode, message: string): object {
  return {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  };
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: object): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) return `/${path}`;
  return path;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

export function parseHttpOptions(argv = process.argv.slice(2), env = process.env): HttpOptions {
  const options: HttpOptions = {
    host: env.CHIASMUS_MCP_HOST ?? DEFAULT_HOST,
    port: parsePort(env.CHIASMUS_MCP_PORT, DEFAULT_PORT),
    path: normalizePath(env.CHIASMUS_MCP_PATH ?? DEFAULT_PATH),
    sessionTtlMs: parsePositiveInt(
      env.CHIASMUS_MCP_SESSION_TTL_MS,
      DEFAULT_SESSION_TTL_MS,
      "session TTL",
    ),
    chiasmusHome: env.CHIASMUS_HOME,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const readValue = (): string => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === "--host") {
      options.host = readValue();
    } else if (arg === "--port") {
      options.port = parsePort(readValue(), options.port);
    } else if (arg === "--path") {
      options.path = normalizePath(readValue());
    } else if (arg === "--chiasmus-home") {
      options.chiasmusHome = readValue();
    } else if (arg === "--session-ttl-ms") {
      options.sessionTtlMs = parsePositiveInt(readValue(), options.sessionTtlMs, "session TTL");
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage: chiasmus-http [--host HOST] [--port PORT] [--path PATH] [--session-ttl-ms MS] [--chiasmus-home DIR]

Runs Chiasmus as a long-lived MCP Streamable HTTP server.

Defaults:
  --host ${DEFAULT_HOST}
  --port ${DEFAULT_PORT}
  --path ${DEFAULT_PATH}
  --session-ttl-ms ${DEFAULT_SESSION_TTL_MS}
`);
}

export async function startChiasmusHttpServer(options: HttpOptions): Promise<HttpServer> {
  const sessions = new Map<string, Session>();

  const refreshSession = (sessionId: string, session: Session): void => {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      console.error(`[Chiasmus] MCP HTTP session expired after ${options.sessionTtlMs}ms: ${sessionId}`);
      void closeSession(sessionId);
    }, options.sessionTtlMs);
    session.idleTimer.unref?.();
  };

  const closeSession = async (sessionId: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    clearTimeout(session.idleTimer);
    try {
      await session.server.close();
    } finally {
      session.library.close();
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? options.host}`);
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
      return;
    }
    if (url.pathname !== options.path) {
      sendJson(res, 404, jsonRpcError(-32000, "Not found"));
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;

    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        let session: Session | undefined;

        if (sid) {
          session = sessions.get(sid);
          if (!session) {
            sendJson(res, 404, jsonRpcError(-32000, "Invalid MCP session ID"));
            return;
          }
        } else if (isInitializeRequest(body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              sessions.set(newSessionId, session!);
              refreshSession(newSessionId, session!);
              console.error(`[Chiasmus] MCP HTTP session initialized: ${newSessionId}`);
            },
          });
          const created = await createChiasmusServer(options.chiasmusHome);
          session = {
            transport,
            server: created.server,
            library: created.library,
            idleTimer: setTimeout(() => undefined, options.sessionTtlMs),
          };
          session.idleTimer.unref?.();
          transport.onclose = () => {
            const transportSessionId = transport.sessionId;
            if (transportSessionId) {
              void closeSession(transportSessionId);
            }
          };
          await created.server.connect(transport);
        } else {
          sendJson(res, 400, jsonRpcError(-32000, "Bad Request: missing MCP session ID"));
          return;
        }

        if (sid) refreshSession(sid, session);
        await session.transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        if (!sid) {
          sendJson(res, 400, jsonRpcError(-32000, "Bad Request: missing MCP session ID"));
          return;
        }
        const session = sessions.get(sid);
        if (!session) {
          sendJson(res, 404, jsonRpcError(-32000, "Invalid MCP session ID"));
          return;
        }
        refreshSession(sid, session);
        await session.transport.handleRequest(req, res);
        if (req.method === "DELETE") {
          await closeSession(sid);
        }
        return;
      }

      sendJson(res, 405, jsonRpcError(-32000, "Method not allowed"));
    } catch (e) {
      const message = e instanceof SyntaxError
        ? "Parse error"
        : e instanceof Error ? e.message : String(e);
      const code = e instanceof SyntaxError ? -32700 : -32603;
      console.error(`[Chiasmus] MCP HTTP request failed: ${message}`);
      sendJson(res, e instanceof SyntaxError ? 400 : 500, jsonRpcError(code, message));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const shutdown = async (): Promise<void> => {
    for (const sessionId of [...sessions.keys()]) {
      await closeSession(sessionId);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  process.once("SIGINT", () => void shutdown().finally(() => process.exit(130)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(143)));

  return server;
}

const isMain = process.argv[1]?.endsWith("mcp-http-server.ts")
  || process.argv[1]?.endsWith("mcp-http-server.js");

if (isMain) {
  try {
    const options = parseHttpOptions();
    await startChiasmusHttpServer(options);
    console.error(`[Chiasmus] MCP Streamable HTTP server running at http://${options.host}:${options.port}${options.path}`);
  } catch (e) {
    console.error(`[Chiasmus] failed to start MCP HTTP server: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
