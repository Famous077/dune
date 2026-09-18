/**
 * GET /export — the team's context as markdown, written to be pasted into any agent cold.
 * Order, per `docs/03-API.md`: repo summary, decisions, dead ends, constraints, structure.
 *
 * It reads on its own: it says what it is, what the sections mean, and how to treat them,
 * because the reader is a model that has never heard of Dune. It never fails on empty
 * context — with nothing saved, it is the repo summary and structure alone.
 */

import type { ContextItem, Graph, RepoRecord, RouteTable } from '@dune/shared';

const TOP_MODULES = 8;

function date(iso: string): string {
  return iso.slice(0, 10);
}

function itemBlock(item: ContextItem): string {
  const author = item.authoredBy === 'agent' ? ', recorded by an agent' : '';
  const files = item.files.length > 0 ? `\n  Files: ${item.files.map((file) => `\`${file}\``).join(', ')}` : '';
  const body = item.body.trim() === '' ? '' : `\n  ${item.body.trim().replace(/\n+/g, '\n  ')}`;
  return `- **${item.title}** (${date(item.createdAt)}${author})${body}${files}`;
}

function section(title: string, intro: string, items: ContextItem[]): string {
  const entries = items.length === 0 ? 'None recorded yet.' : items.map(itemBlock).join('\n');
  return `## ${title}\n\n${intro}\n\n${entries}`;
}

function structure(graph: Graph | null, routes: RouteTable): string {
  if (graph === null) return '## Structure\n\nThe structure map is not available for this index.';

  const lines: string[] = ['## Structure', ''];

  const clusters = new Map<string, number>();
  for (const node of graph.nodes) clusters.set(node.cluster, (clusters.get(node.cluster) ?? 0) + 1);
  lines.push(
    `Areas of the code, by top-level directory: ${[...clusters.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cluster, count]) => `\`${cluster}\` (${count})`)
      .join(', ')}.`,
  );

  if (routes.count > 0) {
    lines.push('', 'Routes:');
    for (const route of routes.routes.slice(0, 50)) {
      lines.push(`- ${route.method.toUpperCase()} \`${route.path}\` — \`${route.file}\``);
    }
    if (routes.count > 50) lines.push(`- …and ${routes.count - 50} more`);
  }

  const entries = graph.nodes.filter((node) => node.entryPoint);
  if (entries.length > 0) {
    lines.push('', `Entry points: ${entries.map((node) => `\`${node.id}\``).join(', ')}.`);
  }

  const hubs = [...graph.nodes]
    .filter((node) => node.importedByCount > 0)
    .sort((a, b) => b.importedByCount - a.importedByCount)
    .slice(0, TOP_MODULES);
  if (hubs.length > 0) {
    lines.push('', 'Most depended-on modules — changes here ripple furthest:');
    for (const node of hubs) lines.push(`- \`${node.id}\`, imported by ${node.importedByCount} files`);
  }

  lines.push(
    '',
    `${graph.nodes.length} connected files and ${graph.edges.length} import edges; ${graph.hiddenCount} ${graph.hiddenCount === 1 ? 'file imports' : 'files import'} nothing internal and ${graph.hiddenCount === 1 ? 'is' : 'are'} not imported.`,
  );
  return lines.join('\n');
}

export function buildExport(input: {
  record: RepoRecord;
  items: ContextItem[];
  graph: Graph | null;
  routes: RouteTable;
}): string {
  const { record, items, graph, routes } = input;
  const { meta } = record;
  const byType = (type: ContextItem['type']): ContextItem[] => items.filter((item) => item.type === type);

  return [
    `# Project context: ${meta.name}`,
    '',
    `This is the shared record the team keeps for the repository ${meta.repoUrl}: decisions to respect, approaches already tried and rejected, and limits the code must stay within, followed by a map of how the code is organised. Treat the team's record as authoritative over anything the code alone suggests, and never propose an approach listed as a dead end.`,
    '',
    `Indexed at commit \`${meta.commitSha.slice(0, 7)}\` on ${date(meta.indexedAt)}: ${meta.fileCount.toLocaleString()} files, ${meta.lineCount.toLocaleString()} lines of TypeScript and JavaScript.${meta.truncated ? ' The repository was larger than the index cap, so not every file is covered.' : ''} Exported ${date(new Date().toISOString())}.`,
    '',
    section('Decisions', 'Choices that were made deliberately. Do not re-litigate them.', byType('decision')),
    '',
    section(
      'Dead ends',
      'Approaches that were tried and rejected. Do not suggest them again.',
      byType('dead-end'),
    ),
    '',
    section('Constraints', 'Limits the code must respect.', byType('constraint')),
    '',
    structure(graph, routes),
    '',
  ].join('\n');
}
