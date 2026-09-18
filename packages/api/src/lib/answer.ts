/**
 * Turns a generation into the `Answer` the contract promises. The model proposes; this
 * decides. See `docs/03-API.md`, "Guarantees the backend must hold", and `docs/01-BACKEND.md`,
 * "Anti-hallucination check" and "Confidence".
 *
 *   - Every path in recommendedFile, attachTo, sources and candidates exists in the indexed
 *     file set. Any that does not is dropped and confidence goes down a level. Test paths
 *     are held to the same standard.
 *   - `sources` is never empty. If the model cited nothing real, the top retrieved code is
 *     cited instead, and confidence goes down a level.
 *   - Confidence starts from the retrieval signals, and can be raised only by evidence the
 *     index verifies about the recommended file (see `verifiedEvidence`): the file registers
 *     the route the question names, or it defines the symbol the question describes. Every
 *     rule after that can only lower it: a retry, a recommended file outside the retrieved
 *     set, a dropped path, the model's own doubt. Nothing the model says raises it.
 *   - At low confidence, `candidates` holds two or three places; otherwise it is null.
 */

import { AnswerSchema } from '@dune/shared';
import type { Answer, Candidate, Confidence, Source } from '@dune/shared';

import { ApiFailure } from './errors';
import type { Generation } from './generation';
import { related, words, type Retrieval } from './retrieval';

const LEVEL: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const lower = (a: Confidence, b: Confidence): Confidence => (LEVEL[a] <= LEVEL[b] ? a : b);
const downgrade = (level: Confidence): Confidence => (level === 'high' ? 'medium' : 'low');

const FALLBACK_SOURCES = 3;

/** Models write `./src/x.ts` or `/src/x.ts` as often as `src/x.ts`. */
function normalise(path: string): string {
  return path.trim().replace(/^\.?\//, '');
}

function fixLines([start, end]: [number, number]): [number, number] {
  const first = Math.max(1, Math.min(start, end));
  return [first, Math.max(first, start, end)];
}

/* ── Verified evidence ──────────────────────────────────────────────────────── */

const HTTP_METHOD = /\b(get|post|put|patch|delete)\b/gi;
/** A request path as people write it in a question: "/users/login", "/api/articles/:slug". */
const QUESTION_PATH = /(?:^|[\s`'"(])(\/[A-Za-z0-9_\-./:[\]{}]*)/g;
/** A symbol name must cover this many of the question's keywords to count. */
const SYMBOL_MIN_KEYWORDS = 2;

export interface Evidence {
  level: Confidence;
  note: string;
}

/**
 * Evidence from the index, not the model, that the recommended file is the answer. Either
 * one can raise the retrieval-based confidence; nothing else can.
 *
 * - **Route.** The question names a request path that is in the repo's route table, with its
 *   method when the question gives one, and the recommended file is where that route is
 *   registered. Stored paths are relative to their router, so a question path matches when
 *   it equals a stored path or ends with it after a mount prefix ("/api/users/login" matches
 *   "/users/login"). Near-certain, so high.
 * - **Symbol.** A declaration retrieved for this question, in the recommended file, has a name
 *   covering at least two of the question's keywords — "balances … calculated" and
 *   `calculateBalancesByUid` — and no other retrieved file has a declaration that matches as
 *   well. The last condition is what keeps a file that merely calls the function from being
 *   raised alongside the file that defines it. Strong but not certain, so medium.
 *
 * Neither applies without a recommended file, so an answer that says "nothing here does
 * this" cannot be raised.
 */
export function verifiedEvidence(recommendedFile: string | null, retrieval: Retrieval): Evidence | null {
  if (recommendedFile === null) return null;
  const question = retrieval.question;

  const paths = [...question.matchAll(QUESTION_PATH)]
    .map((match) => (match[1] ?? '').replace(/[.,;:?!)]+$/, '').replace(/\/+$/, '') || '/')
    .filter((path) => path.length > 0);
  if (paths.length > 0) {
    const methods = new Set([...question.matchAll(HTTP_METHOD)].map((m) => (m[1] ?? '').toLowerCase()));
    const route = retrieval.routes.routes.find((entry) => {
      if (entry.file !== recommendedFile) return false;
      if (methods.size > 0 && !methods.has(entry.method.toLowerCase())) return false;
      return paths.some((path) => path === entry.path || (entry.path !== '/' && path.endsWith(entry.path)));
    });
    if (route) {
      return { level: 'high', note: `verified route: ${route.method.toUpperCase()} ${route.path} is registered in ${route.file}:${route.line}` };
    }
  }

  // Keywords a declaration's name covers, per file, over the chunks retrieved for this question.
  const coverage = (symbolName: string): number => {
    const tokens = words(symbolName);
    return retrieval.keywords.filter((keyword) => tokens.some((token) => related(keyword, token))).length;
  };
  const bestByFile = new Map<string, { symbol: string; covered: number }>();
  for (const { chunk } of retrieval.chunks) {
    if (chunk.symbolName === null) continue;
    const covered = coverage(chunk.symbolName);
    const best = bestByFile.get(chunk.path);
    if (best === undefined || covered > best.covered) bestByFile.set(chunk.path, { symbol: chunk.symbolName, covered });
  }
  const own = bestByFile.get(recommendedFile);
  if (own === undefined || own.covered < SYMBOL_MIN_KEYWORDS) return null;
  const rival = [...bestByFile.entries()].some(([file, best]) => file !== recommendedFile && best.covered >= own.covered);
  if (rival) return null;
  return { level: 'medium', note: `verified symbol: ${recommendedFile} defines ${own.symbol}, matching ${own.covered} question keywords` };
}

export interface Finalised {
  answer: Answer;
  /** Why confidence ended where it did, for the logs. */
  notes: string[];
}

export function finaliseAnswer(generation: Generation, retrieval: Retrieval): Finalised {
  const files = retrieval.indexedFiles;
  const exists = (path: string): boolean => files.has(path);
  // Candidates may name a directory, as the contract's own example does ("src/middleware/").
  const existsOrDirectory = (path: string): boolean =>
    exists(path) || (path.endsWith('/') && [...files].some((file) => file.startsWith(path)));

  const draft = generation.answer ?? generation.partial;
  const notes: string[] = [];

  if (draft.reason === undefined || draft.reason.trim() === '') {
    // Nothing usable came back: show a retry, never a half-rendered card.
    throw new ApiFailure('QUERY_FAILED', 'Could not produce an answer for this question. Try again.');
  }

  let droppedPath = false;
  const keep = (path: string | null | undefined): string | null => {
    if (path === null || path === undefined) return null;
    const clean = normalise(path);
    if (exists(clean)) return clean;
    droppedPath = true;
    notes.push(`dropped path not in the index: ${path}`);
    return null;
  };

  const recommendedFile = keep(draft.recommendedFile);
  const attachTo = keep(draft.attachTo);

  // A file's summary chunk spans the whole file, so its end line is the file's length.
  const lineCounts = new Map(retrieval.summaries.map((summary) => [summary.path, summary.endLine]));

  let sources: Source[] = (draft.sources ?? []).flatMap((source) => {
    const file = normalise(source.file);
    if (!exists(file)) {
      droppedPath = true;
      notes.push(`dropped source not in the index: ${source.file}`);
      return [];
    }
    // A real path with an invented line range still opens the drawer on nothing.
    const [start, end] = fixLines(source.lines);
    const total = lineCounts.get(file);
    if (total === undefined) return [{ file, lines: [start, end] as [number, number] }];
    if (start > total) {
      notes.push(`dropped source past the end of ${file} (${start} > ${total} lines)`);
      return [];
    }
    if (end > total) notes.push(`clamped ${file}:${start}-${end} to its ${total} lines`);
    return [{ file, lines: [start, Math.min(end, total)] as [number, number] }];
  });

  let citedByRetrieval = false;
  if (sources.length === 0) {
    citedByRetrieval = true;
    notes.push('no valid sources from the model; cited the top retrieved code instead');
    sources = retrieval.chunks
      .filter((entry) => !entry.isTest)
      .slice(0, FALLBACK_SOURCES)
      .map((entry) => ({ file: entry.chunk.path, lines: [entry.chunk.startLine, entry.chunk.endLine] }));
  }

  const testsToUpdate = (draft.testsToUpdate ?? []).map(normalise).filter((path) => {
    if (exists(path)) return true;
    notes.push(`dropped test not in the index: ${path}`);
    return false;
  });

  const modelCandidates: Candidate[] = (draft.candidates ?? []).flatMap((candidate) => {
    const file = normalise(candidate.file);
    if (existsOrDirectory(file)) return [{ file, reason: candidate.reason }];
    droppedPath = true;
    notes.push(`dropped candidate not in the index: ${candidate.file}`);
    return [];
  });

  /* Confidence ------------------------------------------------------------------ */
  let confidence: Confidence = retrieval.provisionalConfidence;
  notes.push(`retrieval signals: ${confidence}`);

  // The only raise, and it comes from the index. Everything below can still lower it.
  const evidence = verifiedEvidence(recommendedFile, retrieval);
  if (evidence !== null) {
    notes.push(evidence.note);
    if (LEVEL[evidence.level] > LEVEL[confidence]) confidence = evidence.level;
  }

  if (generation.attempts > 1 || generation.answer === null) {
    confidence = 'low';
    notes.push('validation needed a retry');
  }

  const retrievedFiles = new Set(retrieval.chunks.map((entry) => entry.chunk.path));
  if (recommendedFile === null) {
    confidence = 'low';
    notes.push('no recommended file');
  } else if (!retrievedFiles.has(recommendedFile)) {
    confidence = 'low';
    notes.push('recommended file was not in the retrieved set (graph expansion only)');
  }

  if (droppedPath || citedByRetrieval) confidence = downgrade(confidence);

  if (draft.confidence !== undefined && LEVEL[draft.confidence] < LEVEL[confidence]) {
    notes.push(`model reported ${draft.confidence}`);
    confidence = lower(confidence, draft.confidence);
  }

  /* Candidates: two or three at low confidence, otherwise null ------------------ */
  let candidates: Candidate[] | null = null;
  if (confidence === 'low') {
    const chosen = [...modelCandidates];
    // The fill comes from search, which knows nothing of the team's record. It must not
    // offer the file already recommended, nor a file the team has marked as a dead end —
    // "we tried that there and removed it" followed by "maybe there?" is worse than nothing.
    const deadEndFiles = new Set(
      retrieval.teamContext.filter((item) => item.type === 'dead-end').flatMap((item) => item.files),
    );
    for (const candidate of retrieval.candidates) {
      if (chosen.length >= 2) break;
      if (candidate.file === recommendedFile || deadEndFiles.has(candidate.file)) continue;
      if (chosen.some((entry) => entry.file === candidate.file)) continue;
      const where = candidate.best.symbolName ?? 'its file summary';
      chosen.push({
        file: candidate.file,
        reason: `Among the closest matches for this question in the code search, via ${where} (lines ${candidate.best.lines[0]}–${candidate.best.lines[1]}).`,
      });
    }
    candidates = chosen.slice(0, 3);
  }

  const reason = droppedPath
    ? `${draft.reason.trim()} (A suggested path that does not exist in this repository was removed.)`
    : draft.reason.trim();

  // The same schema the contract is written against, applied to what goes out.
  const answer = AnswerSchema.parse({
    recommendedFile,
    attachTo: attachTo === recommendedFile ? null : attachTo,
    reason,
    affected: draft.affected ?? [],
    testsToUpdate,
    sources,
    confidence,
    candidates,
  });

  return { answer, notes };
}
