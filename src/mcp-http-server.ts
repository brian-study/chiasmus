#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createChiasmusServer } from "./mcp-server.js";
import { exitOnFatalSolverError } from "./solvers/fatal.js";
import { shutdownGraphChild } from "./graph/child-pool.js";
import type { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import type { SkillLibrary } from "./skills/library.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3939;
const DEFAULT_PATH = "/mcp";
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

// A web page can reach a loopback server through DNS rebinding: its own
// hostname is made to resolve to 127.0.0.1, so the browser connects here but
// still names the page's site in Host (and Origin). Checking the name the
// client used, not the address it reached, refuses such a request. The
// loopback names can't be rebound, so they are always allowed.
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];
const WILDCARD_HOSTNAMES = new Set(["0.0.0.0", "[::]"]);

type HttpOptions = {
  host: string;
  port: number;
  path: string;
  sessionTtlMs: number;
  chiasmusHome?: string;
  /** Hostnames clients may use besides the loopback ones and the bound host. */
  allowedHosts?: string[];
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

function parseHostList(value: string): string[] {
  const hosts = value.split(",").map((h) => h.trim()).filter((h) => h !== "");
  if (hosts.length === 0) throw new Error(`Invalid allowed hosts: ${value}`);
  return hosts;
}

/**
 * The hostname in a Host header value, as URL parses it (lowercase, IPv6
 * bracketed), or undefined if it isn't a bare host[:port]. URL would read
 * `rebind.example@127.0.0.1` as host 127.0.0.1, so userinfo and path
 * characters are refused first.
 */
function hostnameOf(authority: string): string | undefined {
  if (/[@/\\?#\s]/.test(authority)) return undefined;
  try {
    return new URL(`http://${authority}`).hostname;
  } catch {
    return undefined;
  }
}

function hostnameOfAllowedHost(host: string): string {
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const hostname = hostnameOf(authority);
  if (hostname === undefined) throw new Error(`Invalid allowed host: ${host}`);
  return hostname;
}

/** The hostnames a request's Host header, and its Origin if it has one, may name. */
export function allowedHostnames(options: Pick<HttpOptions, "host" | "allowedHosts">): Set<string> {
  const names = new Set(LOOPBACK_HOSTNAMES);
  const bound = hostnameOfAllowedHost(options.host);
  if (!WILDCARD_HOSTNAMES.has(bound)) names.add(bound);
  for (const host of options.allowedHosts ?? []) names.add(hostnameOfAllowedHost(host));
  return names;
}

/** Why the request must be refused, or undefined if its Host and Origin are allowed. */
function refusal(req: IncomingMessage, allowed: ReadonlySet<string>): string | undefined {
  const host = req.headers.host;
  const hostname = host === undefined ? undefined : hostnameOf(host);
  if (hostname === undefined || !allowed.has(hostname)) {
    return `Invalid Host header: ${host ?? "(none)"}`;
  }
  const origin = req.headers.origin;
  if (origin === undefined) return undefined;
  let originHostname: string | undefined;
  try {
    originHostname = new URL(origin).hostname;
  } catch {
    // An opaque origin ("null": sandboxed frames, file: pages) names no host.
  }
  if (originHostname === undefined || !allowed.has(originHostname)) {
    return `Invalid Origin header: ${origin}`;
  }
  return undefined;
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
  if (env.CHIASMUS_MCP_ALLOWED_HOSTS !== undefined) {
    options.allowedHosts = parseHostList(env.CHIASMUS_MCP_ALLOWED_HOSTS);
  }

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
    } else if (arg === "--allowed-hosts") {
      options.allowedHosts = parseHostList(readValue());
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
  console.log(`Usage: chiasmus-http [--host HOST] [--port PORT] [--path PATH] [--session-ttl-ms MS] [--chiasmus-home DIR] [--allowed-hosts HOST,...]

Runs Chiasmus as a long-lived MCP Streamable HTTP server.

Requests are answered only when their Host header, and their Origin header if
they send one, names localhost, 127.0.0.1, [::1], the --host address (unless it
is 0.0.0.0 or ::) or a hostname in --allowed-hosts; others get a 403.

Defaults:
  --host ${DEFAULT_HOST}
  --port ${DEFAULT_PORT}
  --path ${DEFAULT_PATH}
  --session-ttl-ms ${DEFAULT_SESSION_TTL_MS}
`);
}

export async function startChiasmusHttpServer(options: HttpOptions): Promise<HttpServer> {
  const sessions = new Map<string, Session>();
  const allowed = allowedHostnames(options);

  const refreshSession = (sessionId: string, session: Session): void => {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      console.error(`[Chiasmus] MCP HTTP session expired after ${options.sessionTtlMs}ms: ${sessionId}`);
      void closeSession(sessionId);
    }, options.sessionTtlMs);
    session.idleTimer.unref?.();
  };

  const disposeSession = async (session: Session): Promise<void> => {
    clearTimeout(session.idleTimer);
    try {
      await session.server.close();
    } finally {
      session.library.close();
    }
  };

  const closeSession = async (sessionId: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    await disposeSession(session);
  };

  // A session created for an initialize request that never registered (the
  // transport rejected the request, or connect or handleRequest threw) has no
  // session ID to expire or delete, so its server and library close here.
  const closeUnlessRegistered = async (session: Session): Promise<void> => {
    const id = session.transport.sessionId;
    if (id !== undefined && sessions.get(id) === session) return;
    await disposeSession(session);
  };

  // Set once a SIGINT/SIGTERM shutdown begins. The listener is closed then,
  // but a kept-alive connection can still carry requests; they get a 503, so
  // no session starts after the shutdown has closed the open ones.
  let closing = false;

  const server = createServer(async (req, res) => {
    if (closing) {
      res.setHeader("connection", "close");
      sendJson(res, 503, jsonRpcError(-32000, "Server is shutting down"));
      return;
    }
    // Before anything else, so a refused initialize starts no session.
    const refused = refusal(req, allowed);
    if (refused) {
      console.error(`[Chiasmus] refused MCP HTTP request: ${refused}`);
      sendJson(res, 403, jsonRpcError(-32000, refused));
      return;
    }
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
    let starting: Session | undefined;

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
          starting = session;
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
    } finally {
      if (starting) {
        await closeUnlessRegistered(starting).catch((e) => {
          console.error(`[Chiasmus] closing unregistered MCP session failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const closeAllSessions = async (): Promise<void> => {
    while (sessions.size > 0) {
      for (const sessionId of [...sessions.keys()]) {
        await closeSession(sessionId);
      }
    }
  };

  const shutdown = async (): Promise<void> => {
    // Stop taking connections and requests first. Reaping the graph child
    // below spans event-loop turns, and a session started meanwhile would be
    // missed here, its GET stream holding server.close() open until its
    // client went away.
    closing = true;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    await closeAllSessions();
    // Closing the sessions cancels their graph calls, which kills a busy
    // graph child; this also kills an idle one, waits for it to exit and
    // refuses graph calls that arrive while the server drains.
    await shutdownGraphChild();
    // An initialize already under way when the shutdown began can have
    // registered its session since.
    await closeAllSessions();
    server.closeAllConnections();
    await closed;
  };

  process.once("SIGINT", () => void shutdown().finally(() => process.exit(130)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(143)));

  return server;
}

const isMain = process.argv[1]?.endsWith("mcp-http-server.ts")
  || process.argv[1]?.endsWith("mcp-http-server.js");

if (isMain) {
  // A solver WASM abort would otherwise leave the daemon hung, not dead, so
  // its supervisor never restarts it. The exit also kills a running graph
  // job's child process (GraphChildPool's process 'exit' listener).
  exitOnFatalSolverError();
  try {
    const options = parseHttpOptions();
    await startChiasmusHttpServer(options);
    console.error(`[Chiasmus] MCP Streamable HTTP server running at http://${options.host}:${options.port}${options.path}`);
  } catch (e) {
    console.error(`[Chiasmus] failed to start MCP HTTP server: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
