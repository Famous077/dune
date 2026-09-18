/**
 * The known-answer evaluation (docs/00-PRD.md: "8 of 10 questions point at the right file").
 * Ten questions across the two pre-indexed repos, each with the file(s) that correctly answer
 * it, established by reading the code — not by asking Dune. Runs against the live API.
 *
 *   npm run eval                 # 3 runs of all ten
 *   npm run eval -- --runs 1
 *
 * Scoring, fixed before the first run:
 * - Answerable: PASS only if the answer's primary file — `recommendedFile`, or the first
 *   candidate when there is no recommendation — is one of `accept`. Confidence does not rescue a
 *   wrong file: a confident wrong answer is a FAIL, and so is an uncertain wrong one.
 * - Unanswerable (`accept` empty): PASS only if confidence is low, i.e. Dune says it does not
 *   know rather than naming a file with conviction.
 *
 * The generator is not deterministic, so every question runs several times and every run is
 * reported; the headline is not the best run.
 *
 * Pacing: Gemini's free tier allows 15 requests a minute, so questions go out 5 s apart. A
 * question the API turns away as busy (MODEL_UNAVAILABLE / RATE_LIMITED) is asked again after
 * a pause, up to three times. That is an availability problem, not an answer, and the retries
 * are counted and printed rather than hidden.
 */
import type { Answer, QueryResponse } from '../packages/shared/src/types';

const API = (process.env['DUNE_API_URL'] ?? 'https://ivaqlw3t8d.execute-api.ap-south-1.amazonaws.com').replace(/\/+$/, '');
const TEAM = 'demo';
const PACE_MS = 5_000;
const BUSY_PAUSE_MS = 30_000;
const BUSY_RETRIES = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SPLIT = '255711d1'; // aashu2006/split-it-wise @ 07aeab2 — Next.js + Firebase
const REALWORLD = '2ccefe94'; // gothinkster/node-express-realworld-example-app @ 30b68e1 — Express + Prisma

interface Question {
  id: string;
  repo: string;
  kind: 'calculation' | 'logic' | 'page' | 'route' | 'add-new' | 'unanswerable';
  question: string;
  /** Files that correctly answer it. Empty: the repo cannot answer it. */
  accept: string[];
  /** Why those files, from the code. */
  why: string;
}

const QUESTIONS: Question[] = [
  {
    id: 'S1', repo: SPLIT, kind: 'calculation',
    question: "Where are each member's balances in a group calculated from the expenses and settlements?",
    accept: ['src/lib/calculations.js'],
    why: 'calculateBalancesByUid(expenses, memberUids, settlements) is defined there.',
  },
  {
    id: 'S2', repo: SPLIT, kind: 'calculation',
    question: 'Where is the list of who pays whom worked out, so that all debts settle in the fewest payments?',
    accept: ['src/lib/calculations.js'],
    why: 'simplifyDebts(balances) is defined there; the group page only calls it.',
  },
  {
    id: 'S3', repo: SPLIT, kind: 'logic',
    question: 'Where is the UPI payment link built when someone settles up?',
    accept: ['src/lib/upi.js'],
    why: 'buildUpiLink and the URI-query encoding live there; SettleUpModal only calls it.',
  },
  {
    id: 'S4', repo: SPLIT, kind: 'page',
    question: "Which page shows a single group's expenses, balances and settle-up options?",
    accept: ['src/app/group/[groupId]/page.jsx'],
    why: 'The Next.js route /group/[groupId]; it renders ExpenseList, BalanceSummary and SettleUp.',
  },
  {
    id: 'S5', repo: SPLIT, kind: 'add-new',
    question: 'Where do I add a new field, like a category, to an expense when it is saved?',
    accept: ['src/lib/expenses.js'],
    why: 'addExpense writes the expense document with addDoc; the form only collects input.',
  },
  {
    id: 'R1', repo: REALWORLD, kind: 'route',
    question: 'Where is the POST /users/login route registered?',
    accept: ['src/app/routes/auth/auth.controller.ts'],
    why: "router.post('/users/login', ...) is declared there.",
  },
  {
    id: 'R2', repo: REALWORLD, kind: 'route',
    question: 'Where are all the API routers mounted under /api?',
    accept: ['src/app/routes/routes.ts'],
    why: "Router().use('/api', api) with the tag, article, profile and auth controllers.",
  },
  {
    id: 'R3', repo: REALWORLD, kind: 'logic',
    question: 'Where is the JWT created for a user after they log in?',
    accept: ['src/app/routes/auth/token.utils.ts'],
    why: 'generateToken calls jwt.sign there; auth.service.ts only calls it.',
  },
  {
    id: 'R4', repo: REALWORLD, kind: 'add-new',
    question: 'Where do I add rate limiting to the auth API?',
    accept: ['src/app/routes/auth/auth.controller.ts', 'src/app/routes/routes.ts'],
    why: 'The auth router (per-route middleware) or where it is mounted. main.ts would limit every route, not the auth API, so it is not accepted.',
  },
  {
    id: 'R5', repo: REALWORLD, kind: 'unanswerable',
    question: 'Where are password reset emails sent?',
    accept: [],
    why: 'The repo has no password reset and sends no email at all.',
  },
];

interface Result {
  id: string;
  run: number;
  pass: boolean;
  primary: string | null;
  confidence: Answer['confidence'] | 'error';
  candidates: string[];
  tookMs: number;
  error: string | null;
  /** Times the API was busy (rate-limited) before this answer came back. */
  busyRetries: number;
}

function primaryFile(answer: Answer): string | null {
  return answer.recommendedFile ?? answer.candidates?.[0]?.file ?? null;
}

const BUSY_CODES = new Set(['MODEL_UNAVAILABLE', 'RATE_LIMITED']);

async function askPatiently(q: Question, run: number): Promise<Result> {
  for (let attempt = 0; ; attempt++) {
    const result = await ask(q, run);
    const busy = result.errorCode !== null && BUSY_CODES.has(result.errorCode);
    if (!busy || attempt >= BUSY_RETRIES) return { ...result, busyRetries: attempt };
    console.log(`         ${q.id} busy (${result.errorCode}); retrying in ${BUSY_PAUSE_MS / 1000}s`);
    await sleep(BUSY_PAUSE_MS);
  }
}

async function ask(q: Question, run: number): Promise<Result & { errorCode: string | null }> {
  const started = Date.now();
  const base = { id: q.id, run, candidates: [] as string[], busyRetries: 0, errorCode: null as string | null };
  try {
    const res = await fetch(`${API}/v1/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoId: q.repo, teamId: TEAM, question: q.question }),
      signal: AbortSignal.timeout(40_000),
    });
    const body = (await res.json()) as QueryResponse | { error: { code: string; message: string } };
    if (!res.ok || 'error' in body) {
      const message = 'error' in body ? body.error.message : `HTTP ${res.status}`;
      const errorCode = 'error' in body ? body.error.code : null;
      return { ...base, errorCode, pass: false, primary: null, confidence: 'error', tookMs: Date.now() - started, error: message };
    }
    const { answer, tookMs } = body;
    const primary = primaryFile(answer);
    const pass = q.accept.length === 0 ? answer.confidence === 'low' : primary !== null && q.accept.includes(primary);
    return {
      ...base,
      pass,
      primary,
      confidence: answer.confidence,
      candidates: (answer.candidates ?? []).map((c) => c.file),
      tookMs,
      error: null,
    };
  } catch (err) {
    return { ...base, pass: false, primary: null, confidence: 'error', tookMs: Date.now() - started, error: String(err) };
  }
}

async function main(): Promise<void> {
  const runsFlag = process.argv.indexOf('--runs');
  const runs = runsFlag === -1 ? 3 : Number(process.argv[runsFlag + 1]);
  const results: Result[] = [];

  for (let run = 1; run <= runs; run++) {
    // Sequential: this is a measurement, not a load test, and the generator has a rate limit.
    for (const q of QUESTIONS) {
      const r = await askPatiently(q, run);
      results.push(r);
      await sleep(PACE_MS);
      console.log(
        `run ${run}  ${q.id}  ${r.pass ? 'PASS' : 'FAIL'}  ${r.confidence.padEnd(6)}  ${String(r.tookMs).padStart(5)}ms  ${r.primary ?? r.error ?? '(no file)'}`,
      );
    }
  }

  console.log('\nPer run:');
  for (let run = 1; run <= runs; run++) {
    const passed = results.filter((r) => r.run === run && r.pass).length;
    console.log(`  run ${run}: ${passed}/${QUESTIONS.length}`);
  }

  console.log('\nPer question:');
  for (const q of QUESTIONS) {
    const rs = results.filter((r) => r.id === q.id);
    const passes = rs.filter((r) => r.pass).length;
    console.log(`  ${q.id} [${q.kind}] ${passes}/${rs.length}  ${q.question}`);
    console.log(`       expected: ${q.accept.length ? q.accept.join(' | ') : '(nothing — should be low confidence)'}`);
    for (const r of rs) {
      const cands = r.candidates.length ? `  candidates: ${r.candidates.join(', ')}` : '';
      console.log(`       run ${r.run}: ${r.pass ? 'PASS' : 'FAIL'} ${r.confidence} → ${r.primary ?? r.error ?? '(no file)'}${cands}`);
    }
  }

  const spread = { high: 0, medium: 0, low: 0 };
  for (const r of results) if (r.confidence !== 'error' && QUESTIONS.find((q) => q.id === r.id)!.accept.length > 0) spread[r.confidence]++;
  console.log(`\nConfidence on answerable questions: high ${spread.high}, medium ${spread.medium}, low ${spread.low}.`);
  console.log(`Busy retries (rate limit, not answers): ${results.reduce((n, r) => n + r.busyRetries, 0)}.`);

  const ms = results.filter((r) => r.confidence !== 'error').map((r) => r.tookMs).sort((a, b) => a - b);
  const median = ms[Math.floor(ms.length / 2)] ?? 0;
  console.log(`\nMedian server time per answer: ${(median / 1000).toFixed(1)}s over ${ms.length} answers.`);
}

void main();
