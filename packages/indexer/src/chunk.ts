/**
 * Chunking — on declaration boundaries, never fixed character windows. A function split
 * across two chunks retrieves badly.
 *
 * Per file:
 *   1. One synthetic file-summary chunk: exports, imports, routes, declaration names. It
 *      reads like an index entry, which is exactly what "where does X happen" matches.
 *   2. One chunk per declaration over 5 lines. Over the token cap, it is split and the
 *      parts are marked.
 *   3. One chunk for module-level code, if more than 5 lines of it remain.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Chunk, ChunkKind } from '@dune/shared';

import type { ParsedFile } from './parse';

/** A declaration must be longer than this to get a chunk of its own. */
const MIN_CHUNK_LINES = 5;

/** The cap from the spec, 1,500 tokens, at roughly four characters per token. */
const MAX_CHUNK_CHARS = 1500 * 4;

/** Keeps the file summary near its ~200-token target on files with long export lists. */
const SUMMARY_LIST_CAP = 25;

export interface ChunkOptions {
  repoId: string;
  /** The cloned working tree. */
  rootDir: string;
  files: ParsedFile[];
}

interface SourceLine {
  /** 1-based. */
  number: number;
  text: string;
}

function chunkId(repoId: string, filePath: string, startLine: number, kind: ChunkKind): string {
  return `${repoId}#${filePath}#${startLine}#${kind}`;
}

function capped(items: string[]): string {
  if (items.length <= SUMMARY_LIST_CAP) return items.join(', ');
  return `${items.slice(0, SUMMARY_LIST_CAP).join(', ')}, and ${items.length - SUMMARY_LIST_CAP} more`;
}

function summaryContent(file: ParsedFile): string {
  const lines = [`File summary (${file.language}, ${file.lineCount} lines)`];

  if (file.exports.length > 0) {
    lines.push(
      `Exports: ${capped(file.exports.map((entry) => (entry.isDefault ? `${entry.name} (default)` : entry.name)))}`,
    );
  }

  if (file.imports.length > 0) {
    lines.push(
      `Imports: ${capped(
        file.imports.map((entry) => {
          // The resolved path carries real signal for "where" questions; a bare specifier
          // is the dependency name, which is signal of its own.
          const target = entry.resolved ?? entry.specifier;
          return entry.names.length > 0 ? `${target} (${entry.names.join(', ')})` : target;
        }),
      )}`,
    );
  }

  if (file.routes.length > 0) {
    lines.push(`Routes: ${capped(file.routes.map((route) => `${route.method.toUpperCase()} ${route.path}`))}`);
  }

  if (file.declarations.length > 0) {
    lines.push(`Declarations: ${capped(file.declarations.map((entry) => entry.name))}`);
  }

  return lines.join('\n');
}

/**
 * Splits on line boundaries so no part is over the cap. A single line longer than the cap
 * (minified code, a data blob) becomes a part of its own rather than being cut mid-line.
 */
function splitByBudget(lines: SourceLine[]): SourceLine[][] {
  const parts: SourceLine[][] = [];
  let current: SourceLine[] = [];
  let size = 0;

  for (const line of lines) {
    const cost = line.text.length + 1;
    if (current.length > 0 && size + cost > MAX_CHUNK_CHARS) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += cost;
  }
  if (current.length > 0) parts.push(current);

  return parts;
}

function toChunks(
  repoId: string,
  file: ParsedFile,
  kind: ChunkKind,
  symbolName: string | null,
  lines: SourceLine[],
): Chunk[] {
  const parts = splitByBudget(lines);

  return parts.map((part, index) => {
    const first = part[0];
    const last = part[part.length - 1];
    const startLine = first?.number ?? 1;
    return {
      chunkId: chunkId(repoId, file.path, startLine, kind),
      repoId,
      path: file.path,
      kind,
      symbolName,
      startLine,
      endLine: last?.number ?? startLine,
      part: parts.length > 1 ? [index + 1, parts.length] : null,
      content: part.map((line) => line.text).join('\n'),
    };
  });
}

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

/**
 * The first line of the comment block directly above `startLine`, or `startLine` itself if
 * there is none. A JSDoc block is the declaration's own description — "Create a new group"
 * — and left behind it lands in the module chunk, where it describes nothing.
 */
function leadingCommentStart(sourceLines: string[], startLine: number, covered: Set<number>): number {
  let line = startLine;
  while (line > 1 && !covered.has(line - 1) && COMMENT_LINE.test(sourceLines[line - 2] ?? '')) {
    line -= 1;
  }
  return line;
}

function chunkFile(repoId: string, file: ParsedFile, source: string): Chunk[] {
  const sourceLines = source.split('\n');
  const lineAt = (number: number): SourceLine => ({ number, text: sourceLines[number - 1] ?? '' });
  const range = (start: number, end: number): SourceLine[] =>
    Array.from({ length: end - start + 1 }, (_, offset) => lineAt(start + offset));

  const chunks: Chunk[] = [
    {
      chunkId: chunkId(repoId, file.path, 1, 'file-summary'),
      repoId,
      path: file.path,
      kind: 'file-summary',
      symbolName: null,
      startLine: 1,
      endLine: Math.max(1, file.lineCount),
      part: null,
      content: summaryContent(file),
    },
  ];

  // Lines owned by a declaration chunk. A declaration of 5 lines or fewer does not get a
  // chunk, so its lines stay module-level — otherwise a short helper would appear in no
  // chunk at all beyond its name in the summary.
  const covered = new Set<number>();

  const declarations = [...file.declarations].sort((a, b) => a.startLine - b.startLine);
  for (const declaration of declarations) {
    const length = declaration.endLine - declaration.startLine + 1;
    if (length <= MIN_CHUNK_LINES) continue;

    const start = leadingCommentStart(sourceLines, declaration.startLine, covered);
    for (let line = start; line <= declaration.endLine; line += 1) covered.add(line);
    chunks.push(
      ...toChunks(repoId, file, 'declaration', declaration.name, range(start, declaration.endLine)),
    );
  }

  const moduleLines = range(1, sourceLines.length).filter(
    (line) => !covered.has(line.number) && line.text.trim() !== '',
  );
  if (moduleLines.length > MIN_CHUNK_LINES) {
    chunks.push(...toChunks(repoId, file, 'module', null, moduleLines));
  }

  return chunks;
}

export async function chunkRepo(options: ChunkOptions): Promise<Chunk[]> {
  const chunks: Chunk[] = [];

  for (const file of options.files) {
    const source = await readFile(path.join(options.rootDir, file.path), 'utf8');
    chunks.push(...chunkFile(options.repoId, file, source));
  }

  return chunks;
}
