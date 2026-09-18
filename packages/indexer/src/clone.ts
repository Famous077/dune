/**
 * Pipeline step 2 — Clone.
 *
 * In:  { repoUrl }   Out: { repoId, commitSha, s3Prefix, files[] }
 *
 * Resolve the default branch's HEAD to a commit SHA, download that commit's tarball into a
 * temp directory, apply the filters from `docs/01-BACKEND.md` in the order they are listed
 * there, upload the working tree to S3, and pin the SHA so an answer that was correct on
 * Friday is still correct in Sunday's recording.
 *
 * A tarball rather than `git clone`: the Lambda runtime has no git binary, and GitHub's
 * archive of a commit holds exactly its tracked files — the same set `git ls-files` gives —
 * so the .gitignore filter still holds, with one download and no history to discard.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import * as tar from 'tar';

import { IndexerError } from './lib/errors';

/** Lambda's /tmp is 2 GB here. A working tree bigger than this is refused, not truncated. */
const MAX_TREE_BYTES = 1_500 * 1024 * 1024;

/**
 * Headers for every GitHub request, from the indexer and the API alike. Unauthenticated,
 * GitHub allows 60 API requests an hour per source IP, and Lambda's egress IPs are shared;
 * with `GITHUB_TOKEN` set it is 5,000 an hour for the token. The token needs no scopes at all
 * — every repo Dune reads is public — so a fine-grained token with public read-only access
 * is enough, and it is never sent anywhere but github.com.
 */
export function githubHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = process.env['GITHUB_TOKEN'];
  return {
    'user-agent': 'dune',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/** Skipped wherever they appear in the path, not just at the root. */
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', 'vendor']);

/** Parsed this weekend. Other files are counted but never parsed. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

const MAX_FILE_BYTES = 500 * 1024;

/** Above this, everything is still kept and uploaded; only the parse set is capped. */
const PARSE_FILE_CAP = 1000;

const UPLOAD_CONCURRENCY = 12;

export interface RepoFile {
  /** Repo-relative, forward slashes. */
  path: string;
  size: number;
  /** Has a supported extension. */
  source: boolean;
  /** Source, and inside the parse cap. */
  parse: boolean;
}

export interface SkipCounts {
  excludedDir: number;
  envFile: number;
  tooLarge: number;
}

export interface CloneResult {
  repoId: string;
  repoUrl: string;
  /** "owner/repo" */
  name: string;
  commitSha: string;
  /** Where the working tree was cloned. The caller owns cleanup. */
  workDir: string;
  /** null when the upload was skipped. */
  s3Prefix: string | null;
  files: RepoFile[];
  /** Files kept after filtering — what the UI shows as the repo's file count. */
  fileCount: number;
  /** True when more source files were found than the parse cap. */
  truncated: boolean;
  uploaded: number;
  skipped: SkipCounts;
}

export interface CloneOptions {
  repoUrl: string;
  /** An empty directory to clone into. */
  workDir: string;
  /** S3 bucket for the snapshot, or null to skip the upload (local dry run). */
  bucket: string | null;
  region: string;
}

/**
 * Normalises to a canonical `https://github.com/owner/repo`. Accepts the shorthand
 * `owner/repo`, an `.git` suffix, and any trailing path, query or fragment.
 */
export function normaliseRepoUrl(input: string): { repoUrl: string; name: string } {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new IndexerError('INVALID_REPO_URL', 'Enter a GitHub repository URL.');
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://github.com/${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new IndexerError(
      'INVALID_REPO_URL',
      `"${input}" is not a valid URL. Use a GitHub repository address, like https://github.com/owner/repo.`,
    );
  }

  if (url.hostname.toLowerCase() !== 'github.com') {
    throw new IndexerError(
      'INVALID_REPO_URL',
      'Only GitHub repositories are supported today. Use an address like https://github.com/owner/repo.',
    );
  }

  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const owner = segments[0];
  const repo = segments[1]?.replace(/\.git$/i, '');
  if (owner === undefined || repo === undefined || repo === '') {
    throw new IndexerError(
      'INVALID_REPO_URL',
      'That URL is missing the owner or the repository name. It should look like https://github.com/owner/repo.',
    );
  }

  return { repoUrl: `https://github.com/${owner}/${repo}`, name: `${owner}/${repo}` };
}

/**
 * Deterministic from the normalised URL, so re-submitting the same repo returns the same
 * id and re-indexing overwrites rather than duplicates. Case is ignored, because GitHub
 * treats owner and repo names case-insensitively.
 */
export function repoIdFromUrl(repoUrl: string): string {
  return createHash('sha256').update(repoUrl.toLowerCase()).digest('hex').slice(0, 8);
}

function isEnvFile(filePath: string): boolean {
  return path.posix.basename(filePath).startsWith('.env');
}

function inExcludedDir(filePath: string): boolean {
  const segments = filePath.split('/');
  // The last segment is the filename, so stop before it.
  return segments.slice(0, -1).some((segment) => EXCLUDED_DIRS.has(segment));
}

/** Shallower paths first, then alphabetical. Only matters for repos over the cap. */
function parsePriority(a: string, b: string): number {
  const depth = a.split('/').length - b.split('/').length;
  return depth !== 0 ? depth : a.localeCompare(b);
}

const NOT_FOUND_MESSAGE = 'Repository not found or private. Check the URL, or try a public repository.';
const UNREACHABLE_MESSAGE = 'Could not download the repository. GitHub may be unreachable — try again in a moment.';

/** The default branch's current HEAD, as a full SHA. One GitHub API call. */
async function resolveHead(slug: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${slug}/commits/HEAD`, {
      headers: githubHeaders({ accept: 'application/vnd.github.sha' }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new IndexerError('INDEX_FAILED', UNREACHABLE_MESSAGE, { cause: err });
  }
  if (response.status === 404 || response.status === 409 || response.status === 422) {
    // 409 is an empty repository: nothing to index is the same answer as nothing there.
    throw new IndexerError('REPO_NOT_FOUND', NOT_FOUND_MESSAGE);
  }
  if (response.status === 403 || response.status === 429) {
    throw new IndexerError('RATE_LIMITED', 'GitHub is limiting requests right now. Try again in a few minutes.');
  }
  const sha = (await response.text()).trim();
  if (!response.ok || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new IndexerError('INDEX_FAILED', UNREACHABLE_MESSAGE);
  }
  return sha;
}

interface Extracted {
  kept: RepoFile[];
  skipped: SkipCounts;
}

/**
 * Streams the commit's tarball straight into `workDir`, applying the filters while it
 * extracts: a skipped file is never written to disk. The archive's single top directory
 * (`repo-<sha>/`) is stripped.
 */
async function downloadTree(slug: string, sha: string, workDir: string): Promise<Extracted> {
  let response: Response;
  try {
    response = await fetch(`https://codeload.github.com/${slug}/tar.gz/${sha}`, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(5 * 60_000),
    });
  } catch (err) {
    throw new IndexerError('INDEX_FAILED', UNREACHABLE_MESSAGE, { cause: err });
  }
  if (response.status === 404) throw new IndexerError('REPO_NOT_FOUND', NOT_FOUND_MESSAGE);
  if (!response.ok || response.body === null) throw new IndexerError('INDEX_FAILED', UNREACHABLE_MESSAGE);

  const skipped: SkipCounts = { excludedDir: 0, envFile: 0, tooLarge: 0 };
  const kept: RepoFile[] = [];
  let totalBytes = 0;
  let overCap = false;

  await mkdir(workDir, { recursive: true });
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    tar.x({
      cwd: workDir,
      strip: 1,
      filter: (entryPath, entry) => {
        const type = 'type' in entry ? entry.type : 'File';
        if (type === 'Directory') return true;
        // Symlinks and anything else that is not a plain file never reach the disk.
        if (type !== 'File') return false;

        const filePath = entryPath.split('/').slice(1).join('/');
        if (filePath === '') return false;

        if (inExcludedDir(filePath)) {
          skipped.excludedDir += 1;
          return false;
        }
        if (isEnvFile(filePath)) {
          // Never read, never uploaded, never written to disk.
          skipped.envFile += 1;
          return false;
        }
        const size = entry.size ?? 0;
        if (size > MAX_FILE_BYTES) {
          skipped.tooLarge += 1;
          return false;
        }

        totalBytes += size;
        if (totalBytes > MAX_TREE_BYTES) {
          overCap = true;
          return false;
        }

        const extension = path.posix.extname(filePath).toLowerCase();
        kept.push({ path: filePath, size, source: SOURCE_EXTENSIONS.has(extension), parse: false });
        return true;
      },
    }),
  );

  if (overCap) {
    throw new IndexerError(
      'REPO_TOO_LARGE',
      'This repository is too large to index here. Try a smaller repository, or a subdirectory of this one.',
    );
  }
  return { kept, skipped };
}

/** Runs `tasks` with a bounded number in flight, preserving nothing but the errors. */
async function inBatches<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      await run(item);
    }
  });
  await Promise.all(workers);
}

export async function clone(options: CloneOptions): Promise<CloneResult> {
  const { repoUrl, name } = normaliseRepoUrl(options.repoUrl);
  const repoId = repoIdFromUrl(repoUrl);

  // The tarball holds exactly the commit's tracked files: that is the .gitignore filter,
  // because anything ignored was never committed.
  const commitSha = await resolveHead(name);
  const { kept, skipped } = await downloadTree(name, commitSha, options.workDir);

  // Everything is kept; only the parse set is capped, with the overflow marked so Parse
  // can prioritise. `truncated` drives the banner in the UI.
  const sourcePaths = kept
    .filter((file) => file.source)
    .map((file) => file.path)
    .sort(parsePriority);
  const toParse = new Set(sourcePaths.slice(0, PARSE_FILE_CAP));
  for (const file of kept) {
    file.parse = toParse.has(file.path);
  }

  let uploaded = 0;
  let s3Prefix: string | null = null;

  if (options.bucket !== null) {
    const bucket = options.bucket;
    const s3 = new S3Client({ region: options.region });
    s3Prefix = `s3://${bucket}/${repoId}/`;

    await inBatches(kept, UPLOAD_CONCURRENCY, async (file) => {
      const body = await readFile(path.join(options.workDir, file.path));
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: `${repoId}/${file.path}`, Body: body }),
      );
      uploaded += 1;
    });
  }

  return {
    repoId,
    repoUrl,
    name,
    commitSha,
    workDir: options.workDir,
    s3Prefix,
    files: kept,
    fileCount: kept.length,
    truncated: sourcePaths.length > PARSE_FILE_CAP,
    uploaded,
    skipped,
  };
}
