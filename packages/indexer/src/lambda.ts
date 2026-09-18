/**
 * IndexFn — runs the indexing pipeline for one job. Invoked asynchronously by
 * POST /v1/repos, which has already written the job as `queued` and returned 202.
 *
 * Every stage is written to the job record, which GET /v1/repos/:repoId reads and the
 * progress screen polls. A failure is recorded as `failed`, naming the stage that broke and
 * a sentence the UI can show as it is — the job never just stops moving.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { JobStage } from '@dune/shared';

import { normaliseRepoUrl, repoIdFromUrl } from './clone';
import { putJob } from './lib/db';
import { IndexerError } from './lib/errors';
import { indexRepository } from './pipeline';

export interface IndexJobEvent {
  repoUrl: string;
  jobId: string;
}

export const handler = async (event: IndexJobEvent): Promise<void> => {
  const { repoUrl } = normaliseRepoUrl(event.repoUrl);
  const repoId = repoIdFromUrl(repoUrl);
  const jobId = event.jobId;
  const bucket = process.env['REPO_BUCKET'];
  if (bucket === undefined || bucket === '') throw new Error('REPO_BUCKET is not set');

  let stage: JobStage = 'queued';
  let progress = 0;

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'dune-'));
  console.log('index job: start', { repoId, jobId, repoUrl });

  try {
    await indexRepository({
      repoUrl,
      workDir,
      bucket,
      region: process.env['AWS_REGION'] ?? 'ap-south-1',
      jobId,
      report: async (next, nextProgress, detail) => {
        stage = next;
        progress = nextProgress;
        await putJob({ repoId, jobId, stage: next, progress: nextProgress, detail, failedStage: null, failureReason: null });
      },
      log: (name, detail) => console.log(`index job: ${name || '·'}`, detail),
    });
    console.log('index job: ready', { repoId, jobId });
  } catch (err) {
    const failureReason =
      err instanceof IndexerError
        ? err.message
        : `Indexing stopped while ${stage === 'queued' ? 'starting' : stage}. Try indexing the repository again.`;
    console.error('index job: failed', { repoId, jobId, stage, err });
    await putJob({ repoId, jobId, stage: 'failed', progress, detail: null, failedStage: stage, failureReason });
  } finally {
    // Lambda reuses /tmp across warm invocations; a leftover tree would eat the next job's space.
    await rm(workDir, { recursive: true, force: true });
  }
};
