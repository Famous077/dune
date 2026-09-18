/**
 * McpFn: the deployed Dune MCP server, at {ApiUrl}/mcp on the same HTTP API as everything
 * else. Streamable HTTP, stateless: each POST builds a server, answers, and is done, which is
 * what a Lambda can do. There is no SSE here — SSE needs one long-lived process holding each
 * session, and App Runner, which the design picked for that, is not available to this account.
 * Streamable HTTP is the transport the MCP spec now recommends, and current clients use it.
 *
 * The server calls the Dune API over HTTP like any other client, at the same domain this
 * request arrived on — which also keeps the template free of a function-to-API cycle.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { createApiClient } from './api';
import { connectionOf, createDuneServer } from './tools';

const methodNotAllowed: APIGatewayProxyStructuredResultV2 = {
  statusCode: 405,
  headers: { allow: 'POST', 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed: this MCP server is stateless, use POST.' },
    id: null,
  }),
};

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const method = event.requestContext.http.method;
  // CORS preflight for browser-based clients; API Gateway adds the CORS headers.
  if (method === 'OPTIONS') return { statusCode: 204 };
  if (method !== 'POST') return methodNotAllowed;

  const origin = `https://${event.requestContext.domainName}`;
  const url = new URL(`${origin}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`);
  const body = event.body === undefined ? undefined : event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) if (value !== undefined) headers.set(name, value);

  const connection = connectionOf(url);
  const server = createDuneServer(createApiClient(process.env['DUNE_API_URL'] ?? origin), connection);
  // No sessionIdGenerator: stateless. JSON responses rather than an SSE stream per call.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(new Request(url, { method, headers, ...(body === undefined ? {} : { body }) }));
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    console.log('mcp', { status: response.status, ...connection });
    return { statusCode: response.status, headers: responseHeaders, body: await response.text() };
  } finally {
    await transport.close();
    await server.close();
  }
};
