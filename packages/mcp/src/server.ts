/**
 * The Dune MCP server as a long-running process: local development, or any container host.
 * The deployed server is the Lambda in lambda.ts (App Runner is not available to this
 * account); this one additionally offers the SSE transport, which needs a single process.
 *
 *   GET  /sse         SSE transport (the one docs/01-BACKEND.md specifies); the client then
 *   POST /messages    posts its messages here with the sessionId it was given
 *   POST /mcp         Streamable HTTP, stateless — what current MCP clients prefer, and it
 *                     holds no connection open between calls
 *   GET  /health      health check for a container host
 *
 * `?teamId=` on the connection URL picks the team (default "demo", as in the API), and
 * `?repoId=` sets a default repo so tools can be called without one.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createApiClient } from './api';
import { connectionOf, createDuneServer } from './tools';

const PORT = Number(process.env['PORT'] ?? 8080);
const API_URL = process.env['DUNE_API_URL'];
if (!API_URL) {
  throw new Error('DUNE_API_URL is not set. It is the dune stack ApiUrl output, e.g. https://<id>.execute-api.ap-south-1.amazonaws.com');
}
const api = createApiClient(API_URL);

/** Open SSE sessions, by the sessionId the transport hands the client. */
const sseSessions = new Map<string, SSEServerTransport>();

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type }).end(body);
}

/** Browser-based clients (the MCP Inspector, for one) need CORS; other clients ignore it. */
function cors(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-expose-headers', 'mcp-session-id, mcp-protocol-version');
}

async function openSse(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  // The message endpoint carries the same query, so a proxy that strips nothing keeps the team.
  const transport = new SSEServerTransport('/messages', res);
  sseSessions.set(transport.sessionId, transport);
  res.on('close', () => sseSessions.delete(transport.sessionId));
  const connection = connectionOf(url);
  console.log('sse open', { sessionId: transport.sessionId, ...connection });
  await createDuneServer(api, connection).connect(transport);
}

async function postSseMessage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const transport = sseSessions.get(url.searchParams.get('sessionId') ?? '');
  if (!transport) {
    send(res, 404, 'Unknown or expired SSE session. Reconnect to /sse.');
    return;
  }
  await transport.handlePostMessage(req, res);
}

async function handleStreamable(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== 'POST') {
    // Stateless: there is no session stream to open with GET, and nothing to DELETE.
    res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' }).end(
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless, use POST.' }, id: null }),
    );
    return;
  }
  const server = createDuneServer(api, connectionOf(url));
  // No sessionIdGenerator: stateless, one server per request.
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  cors(res);

  const route = async () => {
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    if (url.pathname === '/health') return send(res, 200, 'ok');
    if (url.pathname === '/sse' && req.method === 'GET') return openSse(req, res, url);
    if (url.pathname === '/messages' && req.method === 'POST') return postSseMessage(req, res, url);
    if (url.pathname === '/mcp') return handleStreamable(req, res, url);
    if (url.pathname === '/' && req.method === 'GET') {
      return send(
        res,
        200,
        [
          'Dune MCP server.',
          '',
          'Streamable HTTP: POST /mcp',
          'SSE:             GET /sse, then POST /messages',
          '',
          'Optional query parameters on either URL: teamId (default "demo"), repoId (a default repo).',
          'Tools: get_project_context, find_where_to_change, save_decision.',
        ].join('\n'),
      );
    }
    return send(res, 404, 'Not found. The MCP endpoints are /mcp and /sse.');
  };

  route().catch((err: unknown) => {
    console.error('request failed', { method: req.method, path: url.pathname, err });
    if (!res.headersSent) send(res, 500, 'Internal error.');
    else res.end();
  });
});

http.listen(PORT, () => console.log(`dune mcp listening on :${PORT}`));

// Container hosts stop with SIGTERM; close cleanly so in-flight calls can finish.
process.on('SIGTERM', () => {
  for (const transport of sseSessions.values()) void transport.close();
  http.close(() => process.exit(0));
});
