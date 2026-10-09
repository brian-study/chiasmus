#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CancelledNotificationSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createChiasmusServer, getChiasmusHome } from "./mcp-server.js";
import { loadConfig } from "./config.js";
import { createEmbeddingFromEnv, createLLMFromEnv } from "./llm/anthropic.js";
import { SkillLibrary } from "./skills/library.js";
import { exitOnFatalSolverError } from "./solvers/fatal.js";
import { shutdownGraphChild } from "./graph/child-pool.js";
import { shutdownSolverChildren } from "./solvers/child-pool.js";
import type { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import type { EmbeddingAdapter } from "./llm/types.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3939;
const DEFAULT_PATH = "/mcp";
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
// The stdio transport's message limit (the SDK's STDIO_DEFAULT_MAX_BUFFER_SIZE).
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 256;
// setTimeout runs a longer delay after 1 ms instead.
const MAX_TIMER_MS = 2 ** 31 - 1;
// How long a SIGINT/SIGTERM shutdown may drain before the process exits anyway.
const SHUTDOWN_DEADLINE_MS = 5_000;

// A web page can reach a loopback server through DNS rebinding: its own
// hostname is made to resolve to 127.0.0.1, so the browser connects here but
// still names the page's site in Host (and Origin). Checking the name the
// client used, not the address it reached, refuses such a request. The
// loopback names can't be rebound, so they are always allowed.
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];
const WILDCARD_HOSTNAMES = new Set(["0.0.0.0", "[::]"]);

export type HttpOptions = {
  host: string;
  port: number;
  path: string;
  sessionTtlMs: number;
  chiasmusHome?: string;
  /** Hostnames clients may use besides the loopback ones and the bound host. */
  allowedHosts?: string[];
  /** Largest request body read, in bytes; a larger one gets a 413. */
  maxBodyBytes?: number;
  /** Sessions open at once, starting ones included; an initialize beyond it gets a 503. */
  maxSessions?: number;
};

export type ChiasmusHttpServer = {
  httpServer: HttpServer;
  /**
   * Stops taking requests, closes every session and connection, waits for the
   * request handlers still running, then closes the skill library the
   * sessions share and starts releasing their embedding model (one still
   * loading is released once loaded). A tool call that ignores its cancelled
   * signal can outlive close(); the embedding adapter refuses work from the
   * start of close(). Calling it again returns the same promise.
   */
  close(): Promise<void>;
};

type Session = {
  transport: StreamableHTTPServerTransport;
  server: McpProtocolServer;
  idleTimer: NodeJS.Timeout;
  /** Client requests dispatched to the server and not yet answered or cancelled. */
  pending: Set<string | number>;
  /** POST bodies being read. */
  uploads: number;
};

/** A session with a request pending or a body arriving isn't idle. */
const busy = (session: Session): boolean => session.uploads > 0 || session.pending.size > 0;

type JsonRpcErrorCode = -32700 | -32603 | -32000;

function jsonRpcError(code: JsonRpcErrorCode, message: string): object {
  return {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  };
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

class BodyTooLargeError extends Error {}

/**
 * Reads and parses a JSON request body. One over `maxBytes` is refused as
 * soon as its declared length, or the bytes received so far, exceed it.
 */
async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const tooLarge = () => new BodyTooLargeError(`Request body exceeds ${maxBytes} bytes`);
  if (Number(req.headers["content-length"]) > maxBytes) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  // Stop reading without destroying the request, so the 413 can still be sent.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw tooLarge();
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

/** Releases a local embedding model; remote adapters hold nothing to release. */
async function disposeEmbedding(embedding: EmbeddingAdapter | null): Promise<void> {
  await (embedding as { dispose?: () => Promise<void> | void } | null)?.dispose?.();
}

/**
 * The embedding adapter the sessions share, refusing embed() once `closed()`
 * is true. A tool call that ignores its cancelled signal can still be running
 * after close(), and a search would load a local model again after
 * close() released it.
 */
function closableEmbedding(embedding: EmbeddingAdapter, closed: () => boolean): EmbeddingAdapter {
  return {
    embed: (texts) => closed()
      ? Promise.reject(new Error("The MCP HTTP server has closed"))
      : embedding.embed(texts),
    dimension: () => embedding.dimension(),
  };
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) return `/${path}`;
  return path;
}

/** A whole decimal number from 1 to `max`; "3939junk", "1e3" and "-1" are refused. */
function parseInteger(value: string, name: string, max: number): number {
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
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

function headerCount(req: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) count++;
  }
  return count;
}

/** Why the request must be refused, or undefined if its Host and Origin are allowed. */
function refusal(req: IncomingMessage, allowed: ReadonlySet<string>): string | undefined {
  // Node keeps the first of several Host headers; a later one could name another site.
  if (headerCount(req, "host") > 1) return "Invalid Host header: sent more than once";
  const host = req.headers.host;
  const hostname = host === undefined ? undefined : hostnameOf(host);
  if (hostname === undefined || !allowed.has(hostname)) {
    return `Invalid Host header: ${host ?? "(none)"}`;
  }
  const origin = req.headers.origin;
  if (origin === undefined) return undefined;
  let originHostname: string | undefined;
  try {
    const url = new URL(origin);
    // Only a serialized origin (scheme://host[:port]) names a site; URL would
    // also find a hostname in "http://evil@localhost" or "http://localhost/evil".
    if (url.origin === origin) originHostname = url.hostname;
  } catch {
    // An opaque origin ("null": sandboxed frames, file: pages) names no host.
  }
  if (originHostname === undefined || !allowed.has(originHostname)) {
    return `Invalid Origin header: ${origin}`;
  }
  return undefined;
}

/**
 * The path of an origin-form request target ("/mcp?x=1"), or undefined for
 * any other form: an absolute-form target ("http://host/mcp") names a host
 * the Host check never saw, and a malformed one would make URL throw.
 */
function requestPath(target: string | undefined): string | undefined {
  // URL reads a backslash as a slash ("/\host/x" names another host) and
  // drops a fragment, which a request target can't carry.
  if (target === undefined || !target.startsWith("/") || /[\\#]/.test(target)) return undefined;
  try {
    const url = new URL(target, "http://localhost");
    return url.host === "localhost" ? url.pathname : undefined;
  } catch {
    return undefined;
  }
}

export function parseHttpOptions(argv = process.argv.slice(2), env = process.env): HttpOptions {
  const options: HttpOptions = {
    host: env.CHIASMUS_MCP_HOST ?? DEFAULT_HOST,
    port: env.CHIASMUS_MCP_PORT ? parseInteger(env.CHIASMUS_MCP_PORT, "port", 65535) : DEFAULT_PORT,
    path: normalizePath(env.CHIASMUS_MCP_PATH ?? DEFAULT_PATH),
    sessionTtlMs: env.CHIASMUS_MCP_SESSION_TTL_MS
      ? parseInteger(env.CHIASMUS_MCP_SESSION_TTL_MS, "session TTL", MAX_TIMER_MS)
      : DEFAULT_SESSION_TTL_MS,
    chiasmusHome: env.CHIASMUS_HOME,
  };
  if (env.CHIASMUS_MCP_ALLOWED_HOSTS !== undefined) {
    options.allowedHosts = parseHostList(env.CHIASMUS_MCP_ALLOWED_HOSTS);
  }
  if (env.CHIASMUS_MCP_MAX_BODY_BYTES) {
    options.maxBodyBytes = parseInteger(env.CHIASMUS_MCP_MAX_BODY_BYTES, "max body bytes", Number.MAX_SAFE_INTEGER);
  }
  if (env.CHIASMUS_MCP_MAX_SESSIONS) {
    options.maxSessions = parseInteger(env.CHIASMUS_MCP_MAX_SESSIONS, "max sessions", Number.MAX_SAFE_INTEGER);
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
      options.port = parseInteger(readValue(), "port", 65535);
    } else if (arg === "--path") {
      options.path = normalizePath(readValue());
    } else if (arg === "--chiasmus-home") {
      options.chiasmusHome = readValue();
    } else if (arg === "--session-ttl-ms") {
      options.sessionTtlMs = parseInteger(readValue(), "session TTL", MAX_TIMER_MS);
    } else if (arg === "--allowed-hosts") {
      options.allowedHosts = parseHostList(readValue());
    } else if (arg === "--max-body-bytes") {
      options.maxBodyBytes = parseInteger(readValue(), "max body bytes", Number.MAX_SAFE_INTEGER);
    } else if (arg === "--max-sessions") {
      options.maxSessions = parseInteger(readValue(), "max sessions", Number.MAX_SAFE_INTEGER);
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
                     [--allowed-hosts HOST,...] [--max-body-bytes N] [--max-sessions N]

Runs Chiasmus as a long-lived MCP Streamable HTTP server.

Requests are answered only when their Host header, and their Origin header if
they send one, names localhost, 127.0.0.1, [::1], the --host address (unless it
is 0.0.0.0 or ::) or a hostname in --allowed-hosts; others get a 403.

Defaults:
  --host ${DEFAULT_HOST}
  --port ${DEFAULT_PORT}
  --path ${DEFAULT_PATH}
  --session-ttl-ms ${DEFAULT_SESSION_TTL_MS}
  --max-body-bytes ${DEFAULT_MAX_BODY_BYTES}
  --max-sessions ${DEFAULT_MAX_SESSIONS}
`);
}

export async function startChiasmusHttpServer(options: HttpOptions): Promise<ChiasmusHttpServer> {
  const allowed = allowedHostnames(options);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const home = options.chiasmusHome ?? getChiasmusHome();
  // One skill library, LLM and embedding adapter for every session. A library
  // per session would keep its own template cache and miss the templates
  // another session crafts; a local embedding adapter per session would load
  // its own copy of the model.
  const library = await SkillLibrary.create(home);
  const llm = createLLMFromEnv();
  const embedding = createEmbeddingFromEnv(loadConfig(home), home);
  // Set once close() begins: requests get a 503, no session registers, and
  // the shared embedding adapter refuses work.
  let closing = false;
  const sharedEmbedding = embedding && closableEmbedding(embedding, () => closing);
  const sessions = new Map<string, Session>();
  // Session-less POSTs from before their body is read (it may be an
  // initialize) until registration or failure, counted against maxSessions.
  let startingCount = 0;
  // Request handlers still running, which close() waits for.
  const inFlight = new Set<Promise<void>>();

  const refreshSession = (sessionId: string, session: Session): void => {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      // The request or upload keeping it busy restarts the countdown when it ends.
      if (busy(session)) return;
      console.error(`[Chiasmus] MCP HTTP session expired after ${options.sessionTtlMs}ms: ${sessionId}`);
      void closeSession(sessionId);
    }, options.sessionTtlMs);
    session.idleTimer.unref?.();
  };

  const disposeSession = async (session: Session): Promise<void> => {
    clearTimeout(session.idleTimer);
    await session.server.close();
  };

  // Restarts a registered session's countdown once nothing keeps it busy.
  const idleAgain = (session: Session): void => {
    const id = session.transport.sessionId;
    if (id !== undefined && sessions.get(id) === session && !busy(session)) refreshSession(id, session);
  };

  /**
   * Counts the client requests a session works on, from the message that
   * carries one to the response the server sends or the client's
   * cancellation of it. Not the POST's lifetime: the SDK sends no response to
   * a cancelled request, so the POST that carried it stays open until the
   * session closes, and several requests can share one POST.
   */
  const trackRequests = (session: Session): void => {
    const { transport } = session;
    const dispatch = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if ("method" in message && "id" in message) {
        session.pending.add(message.id);
      } else if ("method" in message && message.method === "notifications/cancelled") {
        // Only a cancellation the SDK accepts aborts the request (it parses
        // it with this schema); a malformed one leaves the request running.
        const cancelled = CancelledNotificationSchema.safeParse(message);
        const id = cancelled.success ? cancelled.data.params.requestId : undefined;
        if (id !== undefined && session.pending.delete(id)) idleAgain(session);
      }
      dispatch?.(message, extra);
    };
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      if (!("method" in message) && "id" in message && message.id !== undefined && session.pending.delete(message.id)) {
        idleAgain(session);
      }
      return send(message, options);
    };
  };

  const closeSession = async (sessionId: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    await disposeSession(session);
  };

  // A session created for an initialize request that never registered (the
  // transport rejected the request, connect or handleRequest threw, or the
  // daemon began closing) has no session ID to expire or delete, so its
  // server closes here.
  const closeUnlessRegistered = async (session: Session): Promise<void> => {
    const id = session.transport.sessionId;
    if (id !== undefined && sessions.get(id) === session) return;
    await disposeSession(session);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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
    const path = requestPath(req.url);
    if (path === undefined) {
      sendJson(res, 400, jsonRpcError(-32000, "Bad Request: invalid request target"));
      return;
    }
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
      return;
    }
    if (path !== options.path) {
      sendJson(res, 404, jsonRpcError(-32000, "Not found"));
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;
    let starting: Session | undefined;
    let reserved = false;
    const release = (): void => {
      if (reserved) startingCount--;
      reserved = false;
    };

    try {
      if (req.method === "POST") {
        // Refuse an unknown session, or a session-less POST (a possible
        // initialize) past maxSessions, before reading the body.
        if (sid !== undefined) {
          const session = sessions.get(sid);
          if (!session) {
            sendJson(res, 404, jsonRpcError(-32000, "Invalid MCP session ID"));
            return;
          }
          // Busy while its body arrives, so a slow upload can't expire it;
          // the requests in the body keep it busy from dispatch on.
          refreshSession(sid, session);
          session.uploads++;
          let body: unknown;
          try {
            body = await readJsonBody(req, maxBodyBytes);
          } finally {
            session.uploads--;
            idleAgain(session);
          }
          // A DELETE or close() can have closed the session meanwhile.
          if (sessions.get(sid) !== session) {
            sendJson(res, 404, jsonRpcError(-32000, "Invalid MCP session ID"));
            return;
          }
          await session.transport.handleRequest(req, res, body);
          return;
        }

        // A session-less POST may be an initialize: hold a session slot
        // before reading its body, so a full daemon reads none.
        if (sessions.size + startingCount >= maxSessions) {
          res.setHeader("connection", "close");
          sendJson(res, 503, jsonRpcError(-32000, `Too many MCP sessions (${maxSessions})`));
          return;
        }
        startingCount++;
        reserved = true;
        const body = await readJsonBody(req, maxBodyBytes);
        if (!isInitializeRequest(body)) {
          sendJson(res, 400, jsonRpcError(-32000, "Bad Request: missing MCP session ID"));
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            release();
            // close() has already closed the open sessions; this one closes
            // with its request (closeUnlessRegistered).
            if (closing) return;
            sessions.set(newSessionId, starting!);
            refreshSession(newSessionId, starting!);
            console.error(`[Chiasmus] MCP HTTP session initialized: ${newSessionId}`);
          },
        });
        const created = await createChiasmusServer(home, llm, sharedEmbedding, library);
        starting = {
          transport,
          server: created.server,
          idleTimer: setTimeout(() => undefined, options.sessionTtlMs),
          pending: new Set(),
          uploads: 0,
        };
        starting.idleTimer.unref?.();
        transport.onclose = () => {
          const transportSessionId = transport.sessionId;
          if (transportSessionId) {
            void closeSession(transportSessionId);
          }
        };
        await created.server.connect(transport);
        trackRequests(starting);
        await transport.handleRequest(req, res, body);
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
        // A DELETE the transport accepts closes it, and its onclose closes
        // the session; one it rejects (say, an unsupported protocol version)
        // leaves the session open.
        await session.transport.handleRequest(req, res);
        return;
      }

      res.setHeader("allow", "GET, POST, DELETE");
      sendJson(res, 405, jsonRpcError(-32000, "Method not allowed"));
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        // The rest of the body is never read, so the connection can't be reused.
        res.setHeader("connection", "close");
        sendJson(res, 413, jsonRpcError(-32000, e.message));
        return;
      }
      const message = e instanceof SyntaxError
        ? "Parse error"
        : e instanceof Error ? e.message : String(e);
      const code = e instanceof SyntaxError ? -32700 : -32603;
      console.error(`[Chiasmus] MCP HTTP request failed: ${message}`);
      sendJson(res, e instanceof SyntaxError ? 400 : 500, jsonRpcError(code, message));
    } finally {
      release();
      if (starting) {
        await closeUnlessRegistered(starting).catch((e) => {
          console.error(`[Chiasmus] closing unregistered MCP session failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    }
  };

  const server = createServer((req, res) => {
    // An async listener's rejection would be unhandled and end the process.
    const handled: Promise<void> = handle(req, res)
      .catch((e) => {
        console.error(`[Chiasmus] MCP HTTP request failed: ${e instanceof Error ? e.message : String(e)}`);
        sendJson(res, 500, jsonRpcError(-32603, "Internal error"));
      })
      .finally(() => inFlight.delete(handled));
    inFlight.add(handled);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (e) {
    library.close();
    await disposeEmbedding(embedding);
    throw e;
  }

  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      closing = true;
      const listenerClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      while (sessions.size > 0) {
        for (const sessionId of [...sessions.keys()]) {
          await closeSession(sessionId);
        }
      }
      server.closeAllConnections();
      // With their sessions and connections gone, running handlers end
      // promptly: a starting session closes its server, a body being read
      // fails. Wait for them before closing what they share.
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
      await listenerClosed;
      library.close();
      // Not awaited: a local model still downloading or loading would hold
      // close() until it finished. The adapter releases it once loaded.
      void disposeEmbedding(embedding).catch((e) => {
        console.error(`[Chiasmus] releasing the embedding model failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    })();
    return closed;
  };

  return { httpServer: server, close };
}

/**
 * On SIGINT or SIGTERM: close the daemon, which cancels its sessions' graph
 * and solver calls (killing a busy child), then kill the idle graph and
 * solver children and wait for them to exit, then exit 130 or 143. A
 * shutdown still draining after `deadlineMs` exits anyway; the exit kills a
 * child that is left.
 */
export function exitOnShutdownSignals(daemon: ChiasmusHttpServer, deadlineMs = SHUTDOWN_DEADLINE_MS): void {
  const stop = (code: number): void => {
    // Not unref'd: a stuck shutdown with nothing else pending would let the
    // process end with 0 instead of the signal's code.
    const deadline = setTimeout(() => {
      console.error(`[Chiasmus] MCP HTTP shutdown still running after ${deadlineMs}ms, exiting`);
      process.exit(code);
    }, deadlineMs);
    void daemon.close()
      .then(() => Promise.all([shutdownGraphChild(), shutdownSolverChildren()]))
      .catch((e) => {
        console.error(`[Chiasmus] MCP HTTP shutdown failed: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        clearTimeout(deadline);
        process.exit(code);
      });
  };
  process.once("SIGINT", () => stop(130));
  process.once("SIGTERM", () => stop(143));
}

// npm runs the bin through a symlink named chiasmus-http, so compare real paths.
const thisFile = fileURLToPath(import.meta.url);
const resolvedArg = process.argv[1] ? realpathSync(process.argv[1]) : "";
const isMain = resolvedArg === thisFile
  || process.argv[1]?.endsWith("mcp-http-server.ts")
  || process.argv[1]?.endsWith("mcp-http-server.js");

if (isMain) {
  // Solves run in child processes. With CHIASMUS_SOLVER_WORKER=off they run
  // here, and a solver WASM abort would leave the daemon hung, not dead, so
  // its supervisor would never restart it. The exit also kills the graph and
  // solver children (ChildPool's process 'exit' listener).
  exitOnFatalSolverError();
  try {
    const options = parseHttpOptions();
    const daemon = await startChiasmusHttpServer(options);
    exitOnShutdownSignals(daemon);
    console.error(`[Chiasmus] MCP Streamable HTTP server running at http://${options.host}:${options.port}${options.path}`);
  } catch (e) {
    console.error(`[Chiasmus] failed to start MCP HTTP server: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
