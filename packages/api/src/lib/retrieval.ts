/**
 * Retrieval — where answer quality is won or lost. Pure vector search is not enough on its
 * own; the graph is the advantage over a generic RAG demo. See `docs/01-BACKEND.md`,
 * "Retrieval".
 *
 *   1. Embed the question.
 *   2. Cosine over every chunk vector; keep the top 20.
 *   3. Keyword boost on path and symbol name, weighted 0.3 against the vector score.
 *      Test files are ranked lower unless the question is about tests.
 *   4. Graph expansion: the files the top 5 import, and the files that import them,
 *      contribute their file-summary chunks.
 *   5. The route table, when there are fewer than 50 routes.
 *   6. The team's context for this repo, always.
 *
 * Assembly and the token cap are in `context.ts`.
 */

import { assertCompatible } from '@dune/indexer/embed';
import { cosineScores } from '@dune/indexer/vectors';
import type { VectorSet } from '@dune/indexer/vectors';
import type { Chunk, ContextItem, Graph, RepoRecord, RouteTable } from '@dune/shared';

import * as db from './db';
import { embedder } from './embedder';

/* ── Tuning ─────────────────────────────────────────────────────────────────── */

const VECTOR_TOP_K = 20;
const KEYWORD_WEIGHT = 0.3;
/** Multiplies a test file's score when the question is not about tests. */
const TEST_FILE_FACTOR = 0.5;
const EXPAND_FROM_TOP = 5;
const ROUTE_TABLE_LIMIT = 50;
const MAX_CANDIDATES = 10;
/** Test files that import one of this many top candidates are offered for testsToUpdate. */
const TESTS_FOR_TOP = 3;

/**
 * Provisional confidence, from retrieval signals alone. Set by eye from three questions
 * against one repo — relevant questions had a spread of 3.7–3.9, the unanswerable one 2.1;
 * a clear winner led by 0.14, two plausible files by 0.02. That is not calibration: the
 * eval script replaces these. The final confidence is set after generation, once there is
 * a recommended file to check against the retrieved set.
 */
const SPREAD_LOW = 3.0;
const MARGIN_HIGH = 0.08;

/* ── Test files ─────────────────────────────────────────────────────────────── */

const TEST_FILE = /(^|\/)(__tests__|__mocks__|tests?|specs?|fixtures?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_QUESTION = /\b(tests?|testing|specs?|coverage|fixtures?)\b/i;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/* ── Keywords ───────────────────────────────────────────────────────────────── */

/**
 * Words that say nothing about where code lives. "add" and "get" are here because they
 * start half the symbol names in any repo — boosting on them boosts everything.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'can', 'code', 'did', 'do', 'does', 'done', 'file', 'files',
  'for', 'from', 'function', 'get', 'handle', 'handled', 'happen', 'happens', 'how', 'i', 'in',
  'into', 'is', 'it', 'its', 'logic', 'make', 'of', 'on', 'or', 'put', 'should', 'that', 'the',
  'this', 'to', 'use', 'used', 'was', 'we', 'what', 'when', 'where', 'which', 'who', 'why', 'with',
  'would', 'you', 'add', 'change', 'implement', 'implemented', 'live', 'lives', 'find',
]);

/** Splits camelCase, PascalCase, snake_case, kebab-case, paths and punctuation. */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

export function extractKeywords(question: string): string[] {
  return [...new Set(words(question).filter((word) => word.length >= 3 && !STOPWORDS.has(word)))];
}

/**
 * Two words match when they share a prefix of five characters, or all of the shorter one.
 * That is a crude stemmer — settlement/settlements/settle, create/created/createGroup,
 * group/groups, calculation/calculations — and crude is enough for path and symbol tokens.
 */
function related(a: string, b: string): boolean {
  const shorter = Math.min(a.length, b.length);
  if (shorter < 3) return false;
  const needed = Math.min(5, shorter);
  return a.slice(0, needed) === b.slice(0, needed);
}

/** The fraction of question keywords found in the chunk's path or symbol name, 0 to 1. */
function keywordScore(keywords: string[], path: string, symbolName: string | null): number {
  if (keywords.length === 0) return 0;
  const tokens = [...words(path), ...words(symbolName ?? '')];
  const matched = keywords.filter((keyword) => tokens.some((token) => related(keyword, token)));
  return matched.length / keywords.length;
}

/* ── The index, cached per warm Lambda ──────────────────────────────────────── */

interface LoadedIndex {
  indexedAt: string;
  vectors: VectorSet;
  rowOf: Map<string, number>;
  /** Every parsed file. The anti-hallucination check verifies answer paths against this. */
  files: Set<string>;
  imports: Map<string, Set<string>>;
  importedBy: Map<string, Set<string>>;
  routes: RouteTable;
}

/**
 * Vectors, graph and routes only change when a repo is re-indexed, and the repo record says
 * when that was. A warm Lambda reuses them until `indexedAt` moves.
 */
const indexCache = new Map<string, LoadedIndex>();
const INDEX_CACHE_SIZE = 8;

function link(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, new Set([value]));
  else existing.add(value);
}

function adjacency(graph: Graph): Pick<LoadedIndex, 'imports' | 'importedBy'> {
  const imports = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    link(imports, edge.from, edge.to);
    link(importedBy, edge.to, edge.from);
  }
  return { imports, importedBy };
}

async function loadIndex(record: RepoRecord): Promise<LoadedIndex | null> {
  const repoId = record.meta.repoId;
  const cached = indexCache.get(repoId);
  if (cached !== undefined && cached.indexedAt === record.meta.indexedAt) return cached;

  const [vectors, graph, routes] = await Promise.all([
    db.getVectorSet(repoId),
    db.getGraph(repoId),
    db.getRoutes(repoId),
  ]);
  if (vectors === null || graph === null) return null;

  const loaded: LoadedIndex = {
    indexedAt: record.meta.indexedAt,
    vectors,
    rowOf: new Map(vectors.header.chunkIds.map((chunkId, row) => [chunkId, row])),
    files: new Set(vectors.header.chunkIds.map((chunkId) => pathOf(repoId, chunkId))),
    ...adjacency(graph),
    routes,
  };

  indexCache.delete(repoId);
  indexCache.set(repoId, loaded);
  while (indexCache.size > INDEX_CACHE_SIZE) {
    const oldest = indexCache.keys().next().value;
    if (oldest === undefined) break;
    indexCache.delete(oldest);
  }
  return loaded;
}

/* ── Results ────────────────────────────────────────────────────────────────── */

export interface ScoredChunk {
  chunk: Chunk;
  cosine: number;
  /** 1-based rank by cosine alone, across every chunk in the repo. */
  vectorRank: number;
  keyword: number;
  isTest: boolean;
  /** cosine + 0.3 × keyword, halved for a test file when the question is not about tests. */
  score: number;
}

export interface Candidate {
  file: string;
  score: number;
  /** Retrieved directly, or reached only through a graph edge from a retrieved file. */
  source: 'retrieved' | 'graph';
  /** The chunk that earned the score. */
  best: { symbolName: string | null; kind: Chunk['kind']; lines: [number, number] };
  /** For graph candidates, the top files it is a neighbour of. */
  via: string[];
}

export interface Expansion {
  file: string;
  neighbourOf: string[];
  direction: 'imports' | 'imported-by' | 'both';
}

export interface TestCandidate {
  file: string;
  reason: string;
}

export interface RetrievalSignals {
  /** Mean, spread and best of the cosine distribution over every chunk in the repo. */
  cosineMean: number;
  cosineStd: number;
  cosineMax: number;
  /**
   * How far the best chunk stands above this question's own background, in standard
   * deviations. Scale-free, so it compares across questions where raw cosine does not:
   * a correct answer can score 0.277 on one question and an irrelevant one 0.21 on another.
   */
  spread: number;
  topScore: number;
  secondScore: number | null;
  /** Between the top two candidate files. A small margin means two plausible places. */
  margin: number | null;
  topSource: 'retrieved' | 'graph' | null;
  /** How many of the top 20 chunks sit in the top candidate file. Corroboration. */
  topFileHits: number;
}

export interface Retrieval {
  record: RepoRecord;
  indexedFiles: Set<string>;
  question: string;
  keywords: string[];
  testQuestion: boolean;
  chunks: ScoredChunk[];
  expansion: Expansion[];
  /** File summaries for every retrieved and expanded file, candidates first. */
  summaries: Chunk[];
  candidates: Candidate[];
  tests: TestCandidate[];
  routes: RouteTable & { included: boolean };
  teamContext: ContextItem[];
  signals: RetrievalSignals;
  provisionalConfidence: 'high' | 'medium' | 'low';
  timings: Record<string, number>;
}

export class NotIndexedError extends Error {}

const summaryId = (repoId: string, file: string): string => `${repoId}#${file}#1#file-summary`;

/** `${repoId}#${path}#${startLine}#${kind}` → path. From the right, so a `#` in a path survives. */
function pathOf(repoId: string, chunkId: string): string {
  const rest = chunkId.slice(repoId.length + 1);
  return rest.slice(0, rest.lastIndexOf('#', rest.lastIndexOf('#') - 1));
}

/* ── Retrieval ──────────────────────────────────────────────────────────────── */

export async function retrieve(input: {
  record: RepoRecord;
  teamId: string;
  question: string;
}): Promise<Retrieval> {
  const { record, teamId, question } = input;
  const repoId = record.meta.repoId;
  const timings: Record<string, number> = {};
  const mark = (name: string, since: number): void => {
    timings[name] = Date.now() - since;
  };

  // The question embeds while the index and team context load; neither waits on the other.
  const loadStarted = Date.now();
  const [queryVectors, index, teamContext] = await Promise.all([
    embedder.embed([question]).finally(() => mark('embedMs', loadStarted)),
    loadIndex(record).finally(() => mark('loadIndexMs', loadStarted)),
    db.getTeamContext(teamId, repoId),
  ]);
  mark('parallelMs', loadStarted);

  if (index === null) throw new NotIndexedError();
  const queryVector = queryVectors[0];
  if (queryVector === undefined) throw new Error('the embedder returned no vector for the question');

  // Refuses rather than comparing vectors from two different embedding spaces.
  assertCompatible(index.vectors.header, embedder);

  /* 2. Cosine over everything, top 20 ----------------------------------------- */
  const scoreStarted = Date.now();
  const cosines = cosineScores(index.vectors, queryVector);
  const order = Array.from(cosines.keys()).sort((a, b) => (cosines[b] ?? 0) - (cosines[a] ?? 0));
  const vectorRank = new Map(order.map((row, rank) => [row, rank + 1]));
  const topRows = order.slice(0, VECTOR_TOP_K);

  let sum = 0;
  for (const value of cosines) sum += value;
  const cosineMean = sum / Math.max(1, cosines.length);
  let variance = 0;
  for (const value of cosines) variance += (value - cosineMean) ** 2;
  const cosineStd = Math.sqrt(variance / Math.max(1, cosines.length));
  const cosineMax = cosines[order[0] ?? 0] ?? 0;
  mark('scoreMs', scoreStarted);

  const fetchStarted = Date.now();
  const topIds = topRows.map((row) => index.vectors.header.chunkIds[row] ?? '');
  const topChunks = await db.getChunks(repoId, topIds);

  /* 3. Keyword boost, test files lower ---------------------------------------- */
  const keywords = extractKeywords(question);
  const testQuestion = TEST_QUESTION.test(question);

  const rescore = (chunk: Chunk): ScoredChunk => {
    const row = index.rowOf.get(chunk.chunkId) ?? -1;
    const cosine = cosines[row] ?? 0;
    const keyword = keywordScore(keywords, chunk.path, chunk.symbolName);
    const isTest = isTestFile(chunk.path);
    const boosted = cosine + KEYWORD_WEIGHT * keyword;
    return {
      chunk,
      cosine,
      vectorRank: vectorRank.get(row) ?? 0,
      keyword,
      isTest,
      score: isTest && !testQuestion ? boosted * TEST_FILE_FACTOR : boosted,
    };
  };

  const chunks = topChunks.map(rescore).sort((a, b) => b.score - a.score);

  /* 4. Graph expansion from the top 5 ----------------------------------------- */
  const expandFrom = [...new Set(chunks.slice(0, EXPAND_FROM_TOP).map((entry) => entry.chunk.path))];
  const neighbours = new Map<string, { of: Set<string>; imports: boolean; importedBy: boolean }>();
  for (const file of expandFrom) {
    const visit = (other: string, kind: 'imports' | 'importedBy'): void => {
      const entry = neighbours.get(other) ?? { of: new Set(), imports: false, importedBy: false };
      entry.of.add(file);
      entry[kind] = true;
      neighbours.set(other, entry);
    };
    for (const imported of index.imports.get(file) ?? []) visit(imported, 'imports');
    for (const importer of index.importedBy.get(file) ?? []) visit(importer, 'importedBy');
  }
  for (const file of expandFrom) neighbours.delete(file);

  const expansion: Expansion[] = [...neighbours.entries()].map(([file, entry]) => ({
    file,
    neighbourOf: [...entry.of],
    direction: entry.imports && entry.importedBy ? 'both' : entry.imports ? 'imports' : 'imported-by',
  }));

  // Summaries for every retrieved file and every neighbour. Ones already in the top 20
  // are reused rather than fetched again.
  const retrievedFiles = [...new Set(chunks.map((entry) => entry.chunk.path))];
  const have = new Map(
    topChunks.filter((chunk) => chunk.kind === 'file-summary').map((chunk) => [chunk.path, chunk]),
  );
  // A file can be both retrieved and a neighbour of the top 5; ask for it once.
  const missing = [...new Set([...retrievedFiles, ...neighbours.keys()])].filter((file) => !have.has(file));
  for (const chunk of await db.getChunks(repoId, missing.map((file) => summaryId(repoId, file)))) {
    have.set(chunk.path, chunk);
  }
  mark('fetchChunksMs', fetchStarted);

  /* Candidates ---------------------------------------------------------------- */
  const byFile = new Map<string, Candidate>();
  for (const entry of chunks) {
    if (entry.isTest && !testQuestion) continue; // offered as tests, never as the answer
    const existing = byFile.get(entry.chunk.path);
    if (existing !== undefined && existing.score >= entry.score) continue;
    byFile.set(entry.chunk.path, {
      file: entry.chunk.path,
      score: entry.score,
      source: 'retrieved',
      best: {
        symbolName: entry.chunk.symbolName,
        kind: entry.chunk.kind,
        lines: [entry.chunk.startLine, entry.chunk.endLine],
      },
      via: [],
    });
  }
  // A neighbour is scored on its own summary, so it earns its place rather than inheriting one.
  for (const [file, entry] of neighbours) {
    if (byFile.has(file) || (isTestFile(file) && !testQuestion)) continue;
    const summary = have.get(file);
    if (summary === undefined) continue;
    const scored = rescore(summary);
    byFile.set(file, {
      file,
      score: scored.score,
      source: 'graph',
      best: { symbolName: null, kind: 'file-summary', lines: [summary.startLine, summary.endLine] },
      via: [...entry.of],
    });
  }
  const candidates = [...byFile.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);

  /* Tests: retrieved ones, and ones that import a top candidate --------------- */
  const tests = new Map<string, string>();
  for (const entry of chunks) {
    if (entry.isTest) tests.set(entry.chunk.path, `retrieved directly (cosine ${entry.cosine.toFixed(3)})`);
  }
  for (const candidate of candidates.slice(0, TESTS_FOR_TOP)) {
    for (const importer of index.importedBy.get(candidate.file) ?? []) {
      if (isTestFile(importer) && !tests.has(importer)) tests.set(importer, `imports ${candidate.file}`);
    }
  }

  // The model can only name a test to update if it can see it, so every offered test file
  // has its summary in the context too.
  const missingTests = [...tests.keys()].filter((file) => !have.has(file));
  for (const chunk of await db.getChunks(repoId, missingTests.map((file) => summaryId(repoId, file)))) {
    have.set(chunk.path, chunk);
  }

  /* Summaries in prompt order: candidates first, then the rest of the neighbours, then tests */
  const summaryOrder = [
    ...candidates.map((candidate) => candidate.file),
    ...retrievedFiles,
    ...neighbours.keys(),
    ...tests.keys(),
  ];
  const summaries = [...new Set(summaryOrder)].flatMap((file) => {
    const summary = have.get(file);
    return summary === undefined ? [] : [summary];
  });

  /* Signals ------------------------------------------------------------------- */
  const top = candidates[0];
  const second = candidates[1];
  const signals: RetrievalSignals = {
    cosineMean,
    cosineStd,
    cosineMax,
    spread: cosineStd === 0 ? 0 : (cosineMax - cosineMean) / cosineStd,
    topScore: top?.score ?? 0,
    secondScore: second?.score ?? null,
    margin: top !== undefined && second !== undefined ? top.score - second.score : null,
    topSource: top?.source ?? null,
    topFileHits: top === undefined ? 0 : chunks.filter((entry) => entry.chunk.path === top.file).length,
  };

  return {
    record,
    indexedFiles: index.files,
    question,
    keywords,
    testQuestion,
    chunks,
    expansion,
    summaries,
    candidates,
    tests: [...tests.entries()].map(([file, reason]) => ({ file, reason })),
    routes: { ...index.routes, included: index.routes.count > 0 && index.routes.count < ROUTE_TABLE_LIMIT },
    teamContext,
    signals,
    provisionalConfidence: provisionalConfidence(signals),
    timings,
  };
}

/**
 * From the doc: an answer is low when the top file came from graph expansion only.
 * Otherwise it is judged on shape rather than a fixed score. Spread asks whether anything
 * stands out from this question's own background at all; margin asks whether one file
 * clearly wins or two are plausible.
 */
function provisionalConfidence(signals: RetrievalSignals): 'high' | 'medium' | 'low' {
  if (signals.topSource !== 'retrieved') return 'low';
  if (signals.spread < SPREAD_LOW) return 'low';
  if ((signals.margin ?? 1) >= MARGIN_HIGH) return 'high';
  return 'medium';
}
