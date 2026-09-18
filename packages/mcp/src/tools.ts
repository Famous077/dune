/**
 * The three MCP tools from docs/03-API.md, "MCP tool contract". Each one is a single call to
 * the HTTP API; the server adds formatting for a model reader and nothing else.
 *
 * - get_project_context   -> GET /export/:repoId
 * - find_where_to_change  -> POST /query, rendered as markdown
 * - save_decision         -> POST /context with authoredBy "agent", always
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Answer } from '@dune/shared/types';

import { DuneApiError, type DuneApi } from './api';

/** Who is connected: the team whose record is read and written, and an optional default repo. */
export interface Connection {
  teamId: string;
  repoId: string | null;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `?teamId=` (default "demo", as in the API) and `?repoId=` from the connection URL. */
export function connectionOf(url: URL): Connection {
  const teamId = url.searchParams.get('teamId');
  const repoId = url.searchParams.get('repoId');
  return {
    teamId: teamId && ID.test(teamId) ? teamId : 'demo',
    repoId: repoId && ID.test(repoId) ? repoId : null,
  };
}

const text = (body: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: body }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Resolves the repo and checks it is ready. While indexing is still running, every tool
 * returns a normal response naming the current stage rather than an error — agents handle a
 * status message far better than a thrown error (03-API, "Behaviour before indexing
 * completes").
 */
async function readyRepo(
  api: DuneApi,
  connection: Connection,
  repoId: string | undefined,
): Promise<{ repoId: string } | { result: CallToolResult }> {
  const id = repoId?.trim() || connection.repoId;
  if (!id) {
    return {
      result: text(
        'No repoId given, and this connection has no default repo. Pass repoId (the 8-character id Dune assigned when the repo was indexed), or reconnect with ?repoId=<id> on the server URL.',
        true,
      ),
    };
  }

  const state = await api.repoState(id);
  const job = state.job;
  if (job && job.stage !== 'ready') {
    if (job.stage === 'failed') {
      return {
        result: text(
          `Indexing of repo ${id} failed while ${job.failedStage ?? 'indexing'}: ${job.failureReason ?? 'no reason given'}. It has to be re-indexed before these tools can use it.`,
          true,
        ),
      };
    }
    return {
      result: text(
        `Repo ${id} is still being indexed: ${job.stage}, ${job.progress}% done${job.detail ? ` (${job.detail})` : ''}. Try again in a minute; indexing usually takes under two minutes.`,
      ),
    };
  }
  return { repoId: id };
}

/** An API failure as a tool result: the API's own human sentence, flagged as an error. */
function failure(err: unknown): CallToolResult {
  if (err instanceof DuneApiError) {
    return text(`${err.message}${err.retryable ? ' (This can be retried.)' : ''}`, true);
  }
  return text('Something went wrong calling the Dune API. Try again.', true);
}

const code = (value: string) => `\`${value}\``;

/** The Answer object as markdown: the consumer is a model, not a JSON parser. */
export function renderAnswer(answer: Answer, tookMs: number): string {
  const lines: string[] = [];
  if (answer.confidence === 'low') {
    lines.push('**Uncertain answer.** No single location is strongly supported; treat these as candidates to check, not a recommendation.', '');
    if (answer.candidates && answer.candidates.length > 0) {
      lines.push('**Candidates:**');
      for (const c of answer.candidates) lines.push(`- ${code(c.file)}: ${c.reason}`);
      lines.push('');
    }
    if (answer.recommendedFile) lines.push(`**Closest match:** ${code(answer.recommendedFile)}`);
  } else {
    lines.push(`**Recommended file:** ${code(answer.recommendedFile ?? '(none)')} (confidence: ${answer.confidence})`);
  }
  if (answer.attachTo) lines.push(`**Attach to:** ${code(answer.attachTo)}`);
  lines.push('', `**Why:** ${answer.reason}`);
  if (answer.affected.length > 0) lines.push('', `**Affected:** ${answer.affected.map(code).join(', ')}`);
  if (answer.testsToUpdate.length > 0) lines.push(`**Tests to update:** ${answer.testsToUpdate.map(code).join(', ')}`);
  if (answer.sources.length > 0) {
    lines.push('', '**Sources:**');
    for (const s of answer.sources) lines.push(`- ${code(`${s.file}:${s.lines[0]}-${s.lines[1]}`)}`);
  }
  lines.push('', `_Answered by Dune in ${(tookMs / 1000).toFixed(1)}s, from the indexed code and the team's saved context._`);
  return lines.join('\n');
}

const repoIdInput = z
  .string()
  .optional()
  .describe('The Dune repo id, 8 hex characters, e.g. "255711d1". Optional when the connection URL sets ?repoId=.');

export function createDuneServer(api: DuneApi, connection: Connection): McpServer {
  const server = new McpServer(
    { name: 'dune', version: '0.1.0' },
    {
      instructions:
        "Dune keeps a team's shared context for a codebase: decisions, dead ends (approaches already tried and rejected) and constraints, plus a map of the code. Call get_project_context before planning a change, so you do not re-propose a dead end. Use find_where_to_change to locate where a change belongs. Use save_decision to record a decision you made; it is marked as agent-written so the team can tell it apart from their own.",
    },
  );

  server.registerTool(
    'get_project_context',
    {
      title: 'Get project context',
      description:
        "The team's shared record for a repo, as markdown: a repo summary, decisions to respect, dead ends (approaches already tried and rejected — never propose these), constraints the code must stay within, and an overview of the file structure. Read this before planning changes.",
      inputSchema: { repoId: repoIdInput },
    },
    async ({ repoId }) => {
      try {
        const ready = await readyRepo(api, connection, repoId);
        if ('result' in ready) return ready.result;
        const { markdown } = await api.exportContext(ready.repoId, connection.teamId);
        return text(markdown);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'find_where_to_change',
    {
      title: 'Find where to change',
      description:
        'Asks where a change belongs in the codebase. Returns the recommended file, where to attach it, why, affected routes, tests to update and cited source lines, taking the team\'s saved decisions and dead ends into account. When confidence is low it returns candidates instead of one answer.',
      inputSchema: {
        repoId: repoIdInput,
        question: z.string().min(1).describe('The change, in plain language, e.g. "Where do I add rate limiting to the auth API?"'),
      },
    },
    async ({ repoId, question }) => {
      try {
        const ready = await readyRepo(api, connection, repoId);
        if ('result' in ready) return ready.result;
        const { answer, tookMs } = await api.query({ repoId: ready.repoId, teamId: connection.teamId, question });
        return text(renderAnswer(answer, tookMs));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    'save_decision',
    {
      title: 'Save a decision',
      description:
        "Records an item in the team's shared context: a decision, a dead end (something tried and rejected, and why), or a constraint. It is stored as agent-written and shown with an agent badge, so the team can tell it apart from what people wrote. Use it for choices you actually made or confirmed, with the reasoning in the body.",
      inputSchema: {
        repoId: repoIdInput,
        type: z.enum(['decision', 'dead-end', 'constraint']).describe('decision, dead-end or constraint'),
        title: z.string().min(1).max(200).describe('A short title, e.g. "JWT over sessions"'),
        body: z.string().min(1).describe('The reasoning: what was decided or tried, and why.'),
        files: z.array(z.string()).optional().describe('Repo-relative paths the item is about, e.g. ["src/auth/jwt.ts"]'),
      },
    },
    async ({ repoId, type, title, body, files }) => {
      try {
        const ready = await readyRepo(api, connection, repoId);
        if ('result' in ready) return ready.result;
        // Always "agent": whatever the caller claims, a write through MCP is a model's.
        const item = await api.createContext({
          repoId: ready.repoId,
          teamId: connection.teamId,
          type,
          title,
          body,
          files: files ?? [],
          fromSuggestionId: null,
          authoredBy: 'agent',
        });
        return text(
          `Saved ${item.type} "${item.title}" to the team's context as ${item.id}. It is marked agent-written, so it shows with an agent badge in Dune.`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}
