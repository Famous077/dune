/**
 * Mock mode: the same functions as the live API, answered from the fixtures in src/mocks.
 * A development fixture only — see `isMockMode` in client.ts. Shapes are the contract's,
 * so switching to live changes where data comes from, never what it looks like.
 *
 * Deliberate failure paths, for building error states:
 *   - a repo URL containing "fail" indexes until parsing, then fails
 *   - a question containing "fail" returns QUERY_FAILED
 *   - a question containing "uncertain" returns the low-confidence answer
 */
import type {
  Answer,
  ContextItem,
  ContextListResponse,
  CreateContextRequest,
  CreateRepoResponse,
  ExportResponse,
  FileContentResponse,
  Graph,
  JobStage,
  JobStatus,
  QueryResponse,
  RepoMeta,
  RepoStateResponse,
  Suggestion,
} from '@dune/shared/types';
import { ApiRequestError, mockDelay } from './client';
import { repoNameFromUrl as nameOf } from '../lib/utils';
import { SAMPLE_REPOS } from '../config';
import answerFixture from '../mocks/answer.json';
import answerLowFixture from '../mocks/answer-low.json';
import contextFixture from '../mocks/context.json';
import filesFixture from '../mocks/files.json';
import graphFixture from '../mocks/graph.json';
import metaFixture from '../mocks/meta.json';
import suggestionsFixture from '../mocks/suggestions.json';

// JSON imports widen tuples to arrays; the fixtures follow the contract shapes.
const graph = graphFixture as Graph;
const sampleMeta = metaFixture as RepoMeta;
const answerHigh = answerFixture as Answer;
const answerLow = answerLowFixture as Answer;
const files = filesFixture as Record<string, FileContentResponse>;

/* ── Indexing ───────────────────────────────────────────────────────────────── */

const STAGES: { stage: JobStage; progress: number; detail: string | null }[] = [
  { stage: 'queued', progress: 0, detail: null },
  { stage: 'cloning', progress: 5, detail: null },
  { stage: 'parsing', progress: 20, detail: '389 files' },
  { stage: 'embedding', progress: 48, detail: '1,204 / 2,180 chunks' },
  { stage: 'embedding', progress: 79, detail: '1,920 / 2,180 chunks' },
  { stage: 'finalising', progress: 92, detail: null },
  { stage: 'ready', progress: 100, detail: null },
];
const STEP_MS = 1400;

interface MockJob {
  meta: RepoMeta;
  jobId: string;
  startedAt: number;
  fails: boolean;
}
const jobs = new Map<string, MockJob>();

function repoIdOf(url: string): string {
  let hash = 0;
  for (const ch of url) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, '0').slice(0, 8);
}

export async function createRepo(repoUrl: string): Promise<CreateRepoResponse> {
  await mockDelay();
  if (!/github\.com\/[^/\s]+\/[^/\s]+/.test(repoUrl)) {
    throw new ApiRequestError(
      'INVALID_REPO_URL',
      'That does not look like a GitHub repository URL. Use the form https://github.com/owner/repo.',
      false,
      400,
    );
  }
  // The fixture repo stands in for every sample repo, so the sample buttons work in mock mode.
  if (nameOf(repoUrl) === sampleMeta.name || SAMPLE_REPOS.some((s) => s.name === nameOf(repoUrl))) {
    return { repoId: sampleMeta.repoId, jobId: 'job_mock', alreadyIndexed: true };
  }
  const repoId = repoIdOf(repoUrl);
  const jobId = `job_mock${Date.now().toString(36)}`;
  jobs.set(repoId, {
    meta: { ...sampleMeta, repoId, repoUrl, name: nameOf(repoUrl) },
    jobId,
    startedAt: Date.now(),
    fails: repoUrl.toLowerCase().includes('fail'),
  });
  return { repoId, jobId, alreadyIndexed: false };
}

export async function getRepoState(repoId: string): Promise<RepoStateResponse> {
  await mockDelay(150, 300);
  if (repoId === sampleMeta.repoId) {
    return { meta: sampleMeta, job: readyJob(repoId, 'job_mock'), graph };
  }
  const job = jobs.get(repoId);
  if (!job) {
    throw new ApiRequestError('NOT_FOUND', 'This repository has not been indexed.', false, 404);
  }

  const step = Math.min(STAGES.length - 1, Math.floor((Date.now() - job.startedAt) / STEP_MS));
  const current = STAGES[step]!;
  if (job.fails && step >= 2) {
    return {
      meta: null,
      job: {
        repoId,
        jobId: job.jobId,
        stage: 'failed',
        progress: 20,
        detail: null,
        failedStage: 'parsing',
        failureReason: 'No TypeScript or JavaScript files were found to index. Dune supports .ts, .tsx, .js and .jsx.',
      },
      graph: null,
    };
  }
  if (current.stage === 'ready') {
    return { meta: job.meta, job: readyJob(repoId, job.jobId), graph };
  }
  return {
    meta: null,
    job: { repoId, jobId: job.jobId, ...current, failedStage: null, failureReason: null },
    graph: null,
  };
}

function readyJob(repoId: string, jobId: string): JobStatus {
  return { repoId, jobId, stage: 'ready', progress: 100, detail: null, failedStage: null, failureReason: null };
}

export async function getFile(_repoId: string, path: string): Promise<FileContentResponse> {
  await mockDelay(150, 300);
  const file = files[path];
  if (!file) {
    throw new ApiRequestError('NOT_FOUND', 'That file is not in the indexed snapshot.', false, 404);
  }
  return file;
}

/* ── Query ──────────────────────────────────────────────────────────────────── */

export async function askQuestion(_repoId: string, question: string): Promise<QueryResponse> {
  const started = Date.now();
  await mockDelay(400, 700);
  const q = question.toLowerCase();
  if (q.includes('fail')) {
    throw new ApiRequestError('QUERY_FAILED', 'The answer could not be generated. Try again.', true, 500);
  }
  const answer = q.includes('uncertain') ? answerLow : answerHigh;
  return { answer, tookMs: Date.now() - started };
}

/* ── Context ────────────────────────────────────────────────────────────────── */

const CONTEXT_KEY = 'dune_mock_context';
const SUGGESTIONS_KEY = 'dune_mock_suggestions';

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    // Fall back to the fixture.
  }
  return fallback;
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Mock state simply does not persist.
  }
}

const loadItems = () => load(CONTEXT_KEY, contextFixture as ContextItem[]);
const loadSuggestions = () => load(SUGGESTIONS_KEY, suggestionsFixture as Suggestion[]);

export async function getContext(repoId: string): Promise<ContextListResponse> {
  await mockDelay(200, 380);
  return {
    items: loadItems().map((item) => ({ ...item, repoId })),
    suggestions: loadSuggestions().filter((s) => s.status === 'pending'),
  };
}

export async function createContextItem(input: CreateContextRequest): Promise<ContextItem> {
  await mockDelay(250, 400);
  const item: ContextItem = {
    id: `ctx_mock${Date.now().toString(36)}`,
    repoId: input.repoId,
    type: input.type,
    title: input.title,
    body: input.body,
    files: input.files,
    authoredBy: input.authoredBy,
    createdAt: new Date().toISOString(),
  };
  store(CONTEXT_KEY, [item, ...loadItems()]);
  if (input.fromSuggestionId) {
    store(
      SUGGESTIONS_KEY,
      loadSuggestions().map((s) => (s.id === input.fromSuggestionId ? { ...s, status: 'saved' } : s)),
    );
  }
  return item;
}

export async function refreshSuggestions(_repoId: string): Promise<{ suggestions: Suggestion[] }> {
  await mockDelay(900, 1400);
  return { suggestions: loadSuggestions().filter((s) => s.status === 'pending') };
}

export async function dismissSuggestion(id: string): Promise<{ ok: boolean }> {
  await mockDelay(200, 350);
  store(
    SUGGESTIONS_KEY,
    loadSuggestions().map((s) => (s.id === id ? { ...s, status: 'dismissed' } : s)),
  );
  return { ok: true };
}

export async function getExport(repoId: string): Promise<ExportResponse> {
  await mockDelay(250, 400);
  const items = loadItems();
  const section = (title: string, type: ContextItem['type']) => {
    const list = items.filter((i) => i.type === type);
    if (list.length === 0) return `## ${title}\n\nNone recorded.\n`;
    return `## ${title}\n\n${list.map((i) => `- **${i.title}** — ${i.body}`).join('\n')}\n`;
  };
  const meta = repoId === sampleMeta.repoId ? sampleMeta : (jobs.get(repoId)?.meta ?? sampleMeta);
  return {
    markdown: [
      `# ${meta.name}`,
      '',
      `${meta.fileCount} files, ${meta.lineCount} lines, indexed at commit ${meta.commitSha.slice(0, 7)}. (Mock data.)`,
      '',
      section('Decisions', 'decision'),
      section('Dead ends', 'dead-end'),
      section('Constraints', 'constraint'),
    ].join('\n'),
  };
}
