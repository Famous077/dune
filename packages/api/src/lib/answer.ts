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
 *   - Confidence starts from the retrieval signals. Every rule after that can only lower it:
 *     a retry, a recommended file outside the retrieved set, a dropped path, the model's own
 *     doubt. Nothing the model says raises it.
 *   - At low confidence, `candidates` holds two or three places; otherwise it is null.
 */

import { AnswerSchema } from '@dune/shared';
import type { Answer, Candidate, Confidence, Source } from '@dune/shared';

import { ApiFailure } from './errors';
import type { Generation } from './generation';
import type { Retrieval } from './retrieval';

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
