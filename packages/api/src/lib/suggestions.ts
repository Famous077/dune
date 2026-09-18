/**
 * Git-aware drafting — see `docs/01-BACKEND.md`, "Git-aware suggestion drafting".
 *
 * Reads the diff since the indexed commit and drafts candidate records: decisions, dead
 * ends, constraints. They are drafts and nothing more. Nothing here writes a context item;
 * a draft only becomes team context when a person approves it through POST /context. Auto-
 * detection that is sometimes wrong would pollute the record permanently, and the whole
 * value of the record is that it can be trusted.
 *
 *   - At most 5 suggestions are pending at once. A refresh drafts only enough to fill the
 *     free slots, so nobody faces a pile they will never review.
 *   - Nothing is suggested twice. The model is shown everything already recorded and every
 *     earlier suggestion, dismissed ones included, and a title-overlap check afterwards
 *     drops any repeat that gets through anyway.
 *   - A draft names only files that are in the diff.
 */

import { randomUUID } from 'node:crypto';

import { ContextTypeSchema } from '@dune/shared';
import type { ContextItem, RepoRecord, Suggestion } from '@dune/shared';
import { z } from 'zod';

import * as db from './db';
import { ApiFailure } from './errors';
import { getGenerator } from './generation';
import { compareWithHead } from './github';
import type { RepoDiff } from './github';

const MAX_PENDING = 5;

/** Title overlap at or above this counts as the same record said again. */
const REPEAT_THRESHOLD = 0.5;

const DRAFTING_PROMPT = `You read the changes made to a codebase and draft records for the team's shared memory of it. There are three kinds:

- "decision": the diff shows a choice was made — a library adopted, an approach standardised, a behaviour changed on purpose.
- "dead-end": the diff shows something was tried and then removed or replaced, or a dependency was dropped.
- "constraint": the diff shows a limit the code must now respect — a version pin, a config limit, a rule.

Every draft goes to a person, who approves it, edits it or dismisses it. Nothing you write is saved without them. So:

- Draft only what the diff actually shows. Never invent a motive the diff does not reveal. Where the reason is missing, ask for it in the body — for example "UPI links changed from a form body to a URI query. Record why the form body did not work?"
- Keep titles short, like a heading, under 80 characters. Keep bodies to one to three sentences.
- "files" lists the paths from the diff that the record is about, copied exactly as they appear there.
- Fewer, better drafts beat many thin ones. Formatting, and copy changes with no consequence, are not worth recording.

Respond with one JSON object and nothing else:
{"suggestions": [{"type": "decision" or "dead-end" or "constraint", "title": string, "body": string, "files": string[]}]}
An empty array is a valid answer when nothing in the diff is worth recording.`;

const DraftsSchema = z.object({
  suggestions: z.array(
    z.object({
      type: ContextTypeSchema,
      title: z.string().trim().min(1).max(160),
      body: z.string().trim().min(1).max(1200),
      files: z.array(z.string()),
    }),
  ),
});

type Draft = z.infer<typeof DraftsSchema>['suggestions'][number];

function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3),
  );
}

/** Jaccard overlap of title words — crude, and enough to catch a record said again. */
function overlap(a: string, b: string): number {
  const left = titleWords(a);
  const right = titleWords(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function describeKnown(items: ContextItem[], suggestions: Suggestion[]): string {
  const lines = [
    ...items.map((item) => `- [${item.type}, recorded] ${item.title}`),
    ...suggestions.map((suggestion) => `- [${suggestion.type}, ${suggestion.status} suggestion] ${suggestion.title}`),
  ];
  return lines.length === 0 ? 'Nothing yet.' : lines.join('\n');
}

function promptFor(record: RepoRecord, diff: RepoDiff, known: string, slots: number): string {
  return [
    `Repository: ${record.meta.name}`,
    `Comparing ${diff.base.slice(0, 7)} with HEAD ${diff.head.slice(0, 7)}: ${diff.commits.length} commits, ${diff.files.length} files changed.`,
    '',
    'Commits, oldest first:',
    ...diff.commits.map((subject) => `- ${subject}`),
    '',
    'Already recorded by the team, or already suggested — dismissed suggestions included. Do not propose any of these again, or anything that says the same thing:',
    known,
    '',
    `Diff${diff.truncated ? ' (some large patches omitted to fit)' : ''}:`,
    diff.text,
    '',
    `Draft at most ${slots} new records.`,
  ].join('\n');
}

export interface RefreshResult {
  /** Every pending suggestion after the refresh, newest first, at most 5. */
  suggestions: Suggestion[];
  drafted: number;
  discarded: string[];
  diff: { base: string; head: string; commits: number; files: number } | null;
}

export async function refreshSuggestions(input: {
  record: RepoRecord;
  teamId: string;
  since: string | null;
}): Promise<RefreshResult> {
  const { record, teamId, since } = input;
  const repoId = record.meta.repoId;

  const [existing, items] = await Promise.all([
    db.listSuggestions(teamId, repoId),
    db.getTeamContext(teamId, repoId),
  ]);
  const pending = existing.filter((suggestion) => suggestion.status === 'pending');
  const slots = MAX_PENDING - pending.length;
  if (slots <= 0) return { suggestions: pending.slice(0, MAX_PENDING), drafted: 0, discarded: [], diff: null };

  const diff = await compareWithHead(record.meta.repoUrl, since ?? record.meta.commitSha);
  const diffSummary = { base: diff.base, head: diff.head, commits: diff.commits.length, files: diff.files.length };
  if (diff.files.length === 0) return { suggestions: pending, drafted: 0, discarded: [], diff: diffSummary };

  const generation = await getGenerator().generateJson({
    system: DRAFTING_PROMPT,
    user: promptFor(record, diff, describeKnown(items, existing), slots),
    schema: DraftsSchema,
  });
  if (generation.value === null) {
    throw new ApiFailure('QUERY_FAILED', 'Could not draft suggestions from these changes. Try refreshing again.');
  }

  const changed = new Set(diff.files.map((file) => file.path));
  const knownTitles = [...items.map((item) => item.title), ...existing.map((suggestion) => suggestion.title)];
  const discarded: string[] = [];
  const accepted: Draft[] = [];

  for (const draft of generation.value.suggestions) {
    if (knownTitles.some((title) => overlap(title, draft.title) >= REPEAT_THRESHOLD)) {
      discarded.push(`repeat: ${draft.title}`);
      continue;
    }
    const files = draft.files.map((file) => file.trim().replace(/^\.?\//, '')).filter((file) => changed.has(file));
    accepted.push({ ...draft, files });
    knownTitles.push(draft.title); // and no two drafts in one refresh say the same thing
    if (accepted.length >= slots) break;
  }

  // The first draft is the newest, so the panel shows drafts in the order they were written.
  const now = Date.now();
  const created: Suggestion[] = accepted.map((draft, index) => ({
    id: `sug_${repoId}_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
    type: draft.type,
    title: draft.title,
    body: draft.body,
    files: draft.files,
    status: 'pending',
    createdAt: new Date(now - index).toISOString(),
  }));
  await db.putSuggestions(teamId, repoId, created);

  return {
    suggestions: [...created, ...pending].slice(0, MAX_PENDING),
    drafted: created.length,
    discarded,
    diff: diffSummary,
  };
}

/** Suggestion ids carry their repo, so a dismiss needs nothing but the id: `sug_{repoId}_{random}`. */
export function repoIdOfSuggestion(id: string): string | null {
  const match = /^sug_([A-Za-z0-9-]+)_[A-Za-z0-9]+$/.exec(id);
  return match?.[1] ?? null;
}
