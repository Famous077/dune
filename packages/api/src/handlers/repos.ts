/**
 * Repo endpoints — `docs/03-API.md`, "Repo endpoints".
 *
 *   POST /v1/repos                     start indexing; 202 at once, the work runs in IndexFn
 *   GET  /v1/repos/:repoId             polled for progress, then read once for the map
 *   GET  /v1/repos/:repoId/files/*     one indexed file, for the source drawer
 */

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { normaliseRepoUrl, repoIdFromUrl } from '@dune/indexer/clone';
import {
  CreateRepoResponseSchema,
  FileContentResponseSchema,
  KeyIdSchema,
  RepoStateResponseSchema,
} from '@dune/shared';
import type { JobStatus, Language, RepoRecord } from '@dune/shared';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { z } from 'zod';

import * as db from '../lib/db';
import type { StoredJob } from '../lib/db';
import { readSnapshotFile } from '../lib/files';
import { checkRepoIndexable } from '../lib/github';
import { fail, failFrom, json, readJsonBody } from '../lib/http';

const lambda = new LambdaClient({});

/**
 * IndexFn's timeout is 15 minutes. A job that has not moved for longer than that is not
 * running any more — Lambda killed it without the chance to record a failure.
 */
const STALE_JOB_MS = 16 * 60 * 1000;

const TERMINAL = new Set<JobStatus['stage']>(['ready', 'failed']);

function isRunning(job: StoredJob | null): job is StoredJob {
  if (job === null || TERMINAL.has(job.status.stage)) return false;
  return Date.now() - Date.parse(job.updatedAt) < STALE_JOB_MS;
}

function staleAsFailed(job: StoredJob): JobStatus {
  if (TERMINAL.has(job.status.stage)) return job.status;
  return {
    ...job.status,
    stage: 'failed',
    detail: null,
    failedStage: job.status.stage,
    failureReason: 'Indexing stopped unexpectedly and did not finish. Try indexing the repository again.',
  };
}

/** Repos indexed by the local runner, or whose job record has expired, still read as ready. */
function readyJob(record: RepoRecord, latest: StoredJob | null): JobStatus {
  if (latest !== null && latest.status.stage === 'ready') return latest.status;
  return {
    repoId: record.meta.repoId,
    jobId: record.jobId ?? 'job_local',
    stage: 'ready',
    progress: 100,
    detail: null,
    failedStage: null,
    failureReason: null,
  };
}

/* ── POST /v1/repos ──────────────────────────────────────────────────────────── */

const CreateRepoBodySchema = z.object({ repoUrl: z.string().min(1), teamId: KeyIdSchema.default('demo') });

export async function createRepo(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const body = CreateRepoBodySchema.safeParse(readJsonBody(event));
  if (!body.success) {
    return fail('INVALID_REQUEST', 'Send a JSON body with the repoUrl of a GitHub repository.');
  }

  let repoUrl: string;
  try {
    repoUrl = normaliseRepoUrl(body.data.repoUrl).repoUrl;
  } catch (err) {
    return failFrom(err, 'repos create', 'That is not a repository URL we can read.');
  }
  const repoId = repoIdFromUrl(repoUrl);

  try {
    const [record, latest] = await Promise.all([db.getRepoRecord(repoId), db.getLatestJob(repoId)]);

    // Already indexed: answer at once, so the sample-repo link is instant.
    if (record !== null && !isRunning(latest)) {
      return json(202, CreateRepoResponseSchema.parse({ repoId, jobId: readyJob(record, latest).jobId, alreadyIndexed: true }));
    }
    // Already being indexed: hand back the running job rather than starting a second one.
    if (isRunning(latest)) {
      return json(202, CreateRepoResponseSchema.parse({ repoId, jobId: latest.status.jobId, alreadyIndexed: false }));
    }

    await checkRepoIndexable(repoUrl);

    const jobId = db.newJobId();
    const queued: JobStatus = { repoId, jobId, stage: 'queued', progress: 0, detail: null, failedStage: null, failureReason: null };
    await db.putJob(queued);

    try {
      await lambda.send(
        new InvokeCommand({
          FunctionName: process.env['INDEX_FUNCTION_NAME'],
          InvocationType: 'Event',
          Payload: new TextEncoder().encode(JSON.stringify({ repoUrl, jobId })),
        }),
      );
    } catch (err) {
      await db.putJob({ ...queued, stage: 'failed', failedStage: 'queued', failureReason: 'Indexing could not be started. Try again in a moment.' });
      throw err;
    }

    console.log('repos: indexing started', { repoId, jobId, repoUrl });
    return json(202, CreateRepoResponseSchema.parse({ repoId, jobId, alreadyIndexed: false }));
  } catch (err) {
    return failFrom(err, 'repos create', 'Could not start indexing just now. Try again in a moment.');
  }
}

/* ── GET /v1/repos/:repoId ───────────────────────────────────────────────────── */

export async function getRepoState(
  _event: APIGatewayProxyEventV2,
  params: { repoId: string },
): Promise<APIGatewayProxyStructuredResultV2> {
  const repoId = KeyIdSchema.safeParse(params.repoId);
  if (!repoId.success) return fail('NOT_FOUND', 'There is no repository with that id.');

  try {
    const [record, latest] = await Promise.all([db.getRepoRecord(repoId.data), db.getLatestJob(repoId.data)]);

    let state: { meta: unknown; job: JobStatus; graph: unknown };
    if (isRunning(latest)) {
      state = { meta: null, job: latest.status, graph: null };
    } else if (record !== null) {
      state = { meta: record.meta, job: readyJob(record, latest), graph: await db.getGraph(repoId.data) };
    } else if (latest !== null) {
      state = { meta: null, job: staleAsFailed(latest), graph: null };
    } else {
      return fail('NOT_FOUND', 'This repository has not been indexed. Submit it to start indexing.');
    }

    return json(200, RepoStateResponseSchema.parse(state));
  } catch (err) {
    return failFrom(err, 'repos state', 'Could not load this repository just now. Try again in a moment.');
  }
}

/* ── GET /v1/repos/:repoId/files/* ───────────────────────────────────────────── */

const LANGUAGE: Record<string, Language> = { ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', py: 'py' };

export async function getFile(
  _event: APIGatewayProxyEventV2,
  params: { repoId: string; path: string },
): Promise<APIGatewayProxyStructuredResultV2> {
  const repoId = KeyIdSchema.safeParse(params.repoId);
  const path = params.path.replace(/^\/+/, '');
  const unavailable = (): APIGatewayProxyStructuredResultV2 =>
    fail('NOT_FOUND', 'This file is not available. Only the TypeScript and JavaScript files that were indexed can be opened.');

  if (!repoId.success || path === '' || path.split('/').some((segment) => segment === '..' || segment === '.')) {
    return unavailable();
  }

  try {
    // "In the indexed set" means the indexer parsed it — every parsed file has a summary
    // chunk. That also keeps the drawer to files the answers can actually cite.
    const [summary] = await db.getChunks(repoId.data, [`${repoId.data}#${path}#1#file-summary`]);
    if (summary === undefined) return unavailable();

    const content = await readSnapshotFile(repoId.data, path);
    if (content === null) return unavailable();

    const extension = path.split('.').pop()?.toLowerCase() ?? '';
    return json(
      200,
      FileContentResponseSchema.parse({
        path,
        content,
        lineCount: content.split('\n').length,
        language: LANGUAGE[extension] ?? 'js',
      }),
    );
  } catch (err) {
    return failFrom(err, 'repos file', 'Could not load this file just now. Try again in a moment.');
  }
}
