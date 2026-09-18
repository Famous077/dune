/**
 * The diff a suggestion refresh drafts from, via GitHub's compare API: the commit a repo was
 * indexed at (or an explicit `since`) against the default branch's current HEAD. No git
 * binary and no clone — Lambda has neither, and one API call is enough.
 *
 * Authenticated when GITHUB_TOKEN is set (see githubHeaders); otherwise GitHub allows 60
 * requests an hour per source IP, and Lambda's egress IPs are shared.
 */

import { z } from 'zod';

import { githubHeaders } from '@dune/indexer/clone';

import { ApiFailure } from './errors';

/** What the drafting prompt gets. Past this the diff is cut, largest patches first. */
const MAX_DIFF_CHARS = 60_000;

const CompareSchema = z.object({
  status: z.string(),
  ahead_by: z.number(),
  commits: z.array(z.object({ sha: z.string(), commit: z.object({ message: z.string() }) })),
  files: z
    .array(
      z.object({
        filename: z.string(),
        status: z.string(),
        additions: z.number(),
        deletions: z.number(),
        patch: z.string().optional(),
        previous_filename: z.string().optional(),
      }),
    )
    .optional(),
});

export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface RepoDiff {
  base: string;
  head: string;
  /** Commit subjects, oldest first — often the clearest statement of intent in the diff. */
  commits: string[];
  files: ChangedFile[];
  /** The patches, joined and cut to fit a prompt. */
  text: string;
  truncated: boolean;
}

/** `https://github.com/owner/repo` → `owner/repo`. */
function slugOf(repoUrl: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repoUrl);
  if (match === null) {
    throw new ApiFailure('REPO_NOT_FOUND', 'This repository is not on GitHub, so there is no history to draft from.');
  }
  return `${match[1]}/${match[2]}`;
}

/**
 * GitHub's own size for a repository, in KB, counts its whole history; the working tree
 * the indexer downloads is usually far smaller. Past this, the index would not fit.
 */
const MAX_REPO_KB = 1_000_000;

/**
 * Checked before a job is accepted, so "not found or private" and "too large" come back
 * from POST /repos straight away instead of as a failed job a minute later.
 */
export async function checkRepoIndexable(repoUrl: string): Promise<void> {
  const slug = slugOf(repoUrl);
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${slug}`, {
      headers: githubHeaders({ accept: 'application/vnd.github+json' }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    throw new ApiFailure('INDEX_FAILED', 'GitHub did not respond in time. Try again in a moment.', { cause: err });
  }

  if (response.status === 404) {
    throw new ApiFailure('REPO_NOT_FOUND', 'Repository not found or private. Check the URL, or try a public repository.');
  }
  if (response.status === 403 || response.status === 429) {
    throw new ApiFailure('RATE_LIMITED', 'GitHub is limiting requests right now. Try again in a few minutes.');
  }
  if (!response.ok) {
    throw new ApiFailure('INDEX_FAILED', 'Could not reach GitHub to check this repository. Try again in a moment.');
  }

  const repo = z.object({ size: z.number(), private: z.boolean() }).safeParse(await response.json());
  if (repo.success && repo.data.private) {
    throw new ApiFailure('REPO_NOT_FOUND', 'Repository not found or private. Check the URL, or try a public repository.');
  }
  if (repo.success && repo.data.size > MAX_REPO_KB) {
    throw new ApiFailure(
      'REPO_TOO_LARGE',
      'This repository is too large to index. Try a smaller repository, or a subdirectory of this one.',
    );
  }
}

export async function compareWithHead(repoUrl: string, base: string): Promise<RepoDiff> {
  const slug = slugOf(repoUrl);
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${slug}/compare/${base}...HEAD`, {
      headers: githubHeaders({ accept: 'application/vnd.github+json' }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    throw new ApiFailure('QUERY_FAILED', 'GitHub did not respond in time. Try refreshing again.', { cause: err });
  }

  if (response.status === 404) {
    throw new ApiFailure(
      'REPO_NOT_FOUND',
      'GitHub cannot find this repository or that commit. Check the commit, or that the repository is still public.',
    );
  }
  if (response.status === 403 || response.status === 429) {
    throw new ApiFailure('RATE_LIMITED', 'GitHub is limiting requests right now. Try refreshing again in a few minutes.');
  }
  if (!response.ok) {
    throw new ApiFailure('QUERY_FAILED', 'Could not read the repository history from GitHub. Try refreshing again.');
  }

  const compare = CompareSchema.parse(await response.json());
  const files = compare.files ?? [];

  // Smallest patches first, so a single huge generated file cannot push out ten small,
  // meaningful ones. Anything that does not fit is listed by name only.
  const bySize = [...files].sort((a, b) => (a.patch?.length ?? 0) - (b.patch?.length ?? 0));
  let budget = MAX_DIFF_CHARS;
  let truncated = false;
  const blocks: string[] = [];
  for (const file of bySize) {
    const header = `### ${file.status} ${file.previous_filename ? `${file.previous_filename} -> ` : ''}${file.filename} (+${file.additions} -${file.deletions})`;
    const patch = file.patch ?? '(no patch: binary or too large)';
    if (header.length + patch.length + 2 <= budget) {
      blocks.push(`${header}\n${patch}`);
      budget -= header.length + patch.length + 2;
    } else {
      blocks.push(`${header}\n(patch omitted to fit)`);
      truncated = true;
    }
  }

  return {
    base,
    head: compare.commits.at(-1)?.sha ?? base,
    commits: compare.commits.map((commit) => commit.commit.message.split('\n')[0] ?? ''),
    files: files.map((file) => ({
      path: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })),
    text: blocks.join('\n\n'),
    truncated,
  };
}
