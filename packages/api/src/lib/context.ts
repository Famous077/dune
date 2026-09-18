/**
 * Assembly: turns a retrieval into the context the generator will read, in the order
 * `docs/01-BACKEND.md` sets and under its ~30,000-token cap.
 *
 *   1. Team context — first, because it is the highest-value, lowest-volume input and
 *      should not compete for attention with thousands of tokens of source.
 *   2. Repo summary
 *   3. Route table
 *   4. File summaries
 *   5. Declaration bodies
 *   6. The question
 *
 * Over the cap, declaration bodies are dropped from the bottom of the ranking first, then
 * file summaries from the bottom. Team context is never dropped.
 */

import type { Chunk, ContextItem } from '@dune/shared';

import type { Retrieval } from './retrieval';

/**
 * The doc's ~30,000. CONTEXT_TOKEN_CAP overrides it, because the real ceiling is whatever
 * the generation provider accepts per request, and that depends on the account's tier.
 */
function tokenCap(): number {
  const override = Number.parseInt(process.env['CONTEXT_TOKEN_CAP'] ?? '', 10);
  return Number.isFinite(override) && override > 0 ? override : 30_000;
}

/** Roughly four characters per token; close enough to budget with. */
const tokens = (text: string): number => Math.ceil(text.length / 4);

export interface Section {
  name: 'team-context' | 'repo' | 'routes' | 'file-summaries' | 'code' | 'question';
  tokens: number;
}

export interface AssembledContext {
  text: string;
  tokenEstimate: number;
  cap: number;
  sections: Section[];
  /** Chunk ids dropped to fit the cap, bottom of the ranking first. */
  dropped: string[];
}

const TYPE_LABEL: Record<ContextItem['type'], string> = {
  decision: 'Decision',
  'dead-end': 'Dead end — tried and rejected',
  constraint: 'Constraint',
};

function teamContextSection(items: ContextItem[]): string {
  if (items.length === 0) {
    return '## Team context\n\nNo decisions, dead ends or constraints have been recorded for this repository yet.';
  }
  const entries = items.map((item) => {
    const files = item.files.length > 0 ? `\nFiles: ${item.files.join(', ')}` : '';
    const author = item.authoredBy === 'agent' ? ' (recorded by an agent)' : '';
    return `### ${TYPE_LABEL[item.type]}: ${item.title}${author}\n${item.body}${files}`;
  });
  return `## Team context\n\nThe team has recorded these. They override anything the code alone suggests; never recommend something listed as a dead end.\n\n${entries.join('\n\n')}`;
}

function repoSection(retrieval: Retrieval): string {
  const { meta } = retrieval.record;
  return `## Repository\n\n${meta.name} at commit ${meta.commitSha.slice(0, 7)}: ${meta.fileCount.toLocaleString()} files, ${meta.lineCount.toLocaleString()} lines of TypeScript and JavaScript.`;
}

function routesSection(retrieval: Retrieval): string {
  const { routes } = retrieval;
  if (routes.count === 0) {
    return '## Routes\n\nNo route registrations (app.get, router.post and similar) were found.';
  }
  if (!routes.included) {
    return `## Routes\n\n${routes.count} route registrations — too many to list here.`;
  }
  const lines = routes.routes.map(
    (route) => `- ${route.method.toUpperCase()} ${route.path} — ${route.file}:${route.line}`,
  );
  return `## Routes\n\n${lines.join('\n')}`;
}

function summaryBlock(chunk: Chunk): string {
  return `### ${chunk.path}\n${chunk.content}`;
}

function codeBlock(chunk: Chunk): string {
  const label = chunk.symbolName ?? (chunk.kind === 'module' ? 'module-level code' : chunk.kind);
  const part = chunk.part === null ? '' : ` (part ${chunk.part[0]} of ${chunk.part[1]})`;
  const language = chunk.path.split('.').pop() ?? '';
  return `### ${chunk.path}:${chunk.startLine}-${chunk.endLine} — ${label}${part}\n\`\`\`${language}\n${chunk.content}\n\`\`\``;
}

export function assembleContext(retrieval: Retrieval, cap = tokenCap()): AssembledContext {
  const team = teamContextSection(retrieval.teamContext);
  const repo = repoSection(retrieval);
  const routes = routesSection(retrieval);
  const question = `## Question\n\n${retrieval.question}`;

  // Summaries already have their own section; the code section holds the bodies.
  const summaries = [...retrieval.summaries];
  const code = retrieval.chunks.map((entry) => entry.chunk).filter((chunk) => chunk.kind !== 'file-summary');
  const dropped: string[] = [];

  const render = (): { text: string; sections: Section[] } => {
    const summaryText = `## File summaries\n\n${summaries.map(summaryBlock).join('\n\n')}`;
    const codeText = `## Code\n\n${code.map(codeBlock).join('\n\n')}`;
    const parts: [Section['name'], string][] = [
      ['team-context', team],
      ['repo', repo],
      ['routes', routes],
      ['file-summaries', summaryText],
      ['code', codeText],
      ['question', question],
    ];
    return {
      text: parts.map(([, text]) => text).join('\n\n'),
      sections: parts.map(([name, text]) => ({ name, tokens: tokens(text) })),
    };
  };

  let rendered = render();
  // Bodies go first, lowest-ranked first; then summaries. Team context is never touched.
  while (tokens(rendered.text) > cap && (code.length > 0 || summaries.length > 0)) {
    const removed = code.length > 0 ? code.pop() : summaries.pop();
    if (removed !== undefined) dropped.push(removed.chunkId);
    rendered = render();
  }

  return {
    text: rendered.text,
    tokenEstimate: tokens(rendered.text),
    cap,
    sections: rendered.sections,
    dropped,
  };
}
