/**
 * Pipeline step 2 — Clone.
 *
 * In:  { repoUrl }   Out: { repoId, commitSha, s3Prefix, files[] }
 *
 * Shallow clone into a temp directory, apply the filters from `docs/01-BACKEND.md` in the
 * order they are listed there, upload the working tree to S3, and pin the commit SHA so an
 * answer that was correct on Friday is still correct in Sunday's recording.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { IndexerError } from './lib/errors';

const exec = promisify(execFile);

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

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    // A clone that has not finished in five minutes is not going to.
    timeout: 5 * 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
  });
  return stdout;
}

function cloneFailure(err: unknown): IndexerError {
  const stderr = typeof err === 'object' && err !== null && 'stderr' in err ? String(err.stderr) : '';

  if (/not found|could not read Username|Authentication failed|access denied/i.test(stderr)) {
    return new IndexerError(
      'REPO_NOT_FOUND',
      'Repository not found or private. Check the URL, or try a public repository.',
      { cause: err },
    );
  }

  return new IndexerError(
    'INDEX_FAILED',
    'Could not download the repository. It may be temporarily unreachable — try again in a moment.',
    { cause: err },
  );
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

  try {
    await git(['clone', '--depth', '1', '--single-branch', repoUrl, options.workDir], process.cwd());
  } catch (err) {
    throw cloneFailure(err);
  }

  const commitSha = (await git(['rev-parse', 'HEAD'], options.workDir)).trim();

  // `git ls-files` lists tracked files, which is the .gitignore filter: anything ignored
  // was never committed, so it is not in this list.
  const tracked = (await git(['ls-files', '-z'], options.workDir))
    .split('\0')
    .filter((entry) => entry !== '');

  const skipped: SkipCounts = { excludedDir: 0, envFile: 0, tooLarge: 0 };
  const kept: RepoFile[] = [];

  for (const filePath of tracked) {
    if (inExcludedDir(filePath)) {
      skipped.excludedDir += 1;
      continue;
    }
    if (isEnvFile(filePath)) {
      // Never read, never uploaded.
      skipped.envFile += 1;
      continue;
    }

    let size: number;
    try {
      size = (await stat(path.join(options.workDir, filePath))).size;
    } catch {
      // A tracked path that is not a regular file (a submodule, a broken symlink).
      continue;
    }

    if (size > MAX_FILE_BYTES) {
      skipped.tooLarge += 1;
      continue;
    }

    const extension = path.posix.extname(filePath).toLowerCase();
    kept.push({ path: filePath, size, source: SOURCE_EXTENSIONS.has(extension), parse: false });
  }

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
