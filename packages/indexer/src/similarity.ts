/**
 * Manual similarity check: `npm run similarity -- "<query>" [--repo <url>] [--top <n>]`.
 *
 * Embeds the query with the current embedder, loads the repo's vector set, and prints the
 * top chunks by cosine similarity. Pure vector search — no keyword boost, no graph
 * expansion, no generation. It exists to answer one question during step 3: does the right
 * code come back for a plain-language question?
 *
 * The repo defaults to the pinned demo repo.
 */

import { assertCompatible, createEmbedder } from './embed';
import { normaliseRepoUrl, repoIdFromUrl } from './clone';
import { getChunks, getVectorSet } from './lib/db';
import { IndexerError } from './lib/errors';
import { topKByCosine } from './lib/vectors';

const DEMO_REPO = 'https://github.com/aashu2006/split-it-wise';

interface Options {
  query: string;
  repoUrl: string;
  top: number;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  let repoUrl = DEMO_REPO;
  let top = 10;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--repo') {
      repoUrl = argv[++index] ?? repoUrl;
    } else if (arg === '--top') {
      top = Number.parseInt(argv[++index] ?? '', 10) || top;
    } else {
      positional.push(arg);
    }
  }

  const query = positional.join(' ').trim();
  if (query === '') {
    throw new IndexerError('INTERNAL', 'Usage: npm run similarity -- "<query>" [--repo <url>] [--top <n>]');
  }
  return { query, repoUrl, top };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { repoUrl, name } = normaliseRepoUrl(options.repoUrl);
  const repoId = repoIdFromUrl(repoUrl);
  const embedder = createEmbedder();

  const loadStarted = Date.now();
  const set = await getVectorSet(repoId);
  if (set === null) {
    throw new IndexerError(
      'INDEX_NOT_READY',
      `${name} has no vectors stored. Run npm run index -- ${repoUrl} first.`,
    );
  }
  const loadMs = Date.now() - loadStarted;

  // Refuses rather than silently comparing vectors from two different embedding spaces.
  assertCompatible(set.header, embedder);

  const embedStarted = Date.now();
  const [queryVector] = await embedder.embed([options.query]);
  if (queryVector === undefined) throw new Error('the embedder returned no vector for the query');
  const embedMs = Date.now() - embedStarted;

  const scoreStarted = Date.now();
  const ranked = topKByCosine(set, queryVector, options.top);
  const scoreMs = Date.now() - scoreStarted;

  const chunks = await getChunks(repoId, ranked.map((entry) => entry.chunkId));
  const byId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));

  console.log(`\n"${options.query}"`);
  console.log(
    `${name} · ${set.header.count} vectors · ${embedder.id} · load ${loadMs} ms, embed ${embedMs} ms, score ${scoreMs} ms\n`,
  );

  ranked.forEach((entry, index) => {
    const chunk = byId.get(entry.chunkId);
    if (chunk === undefined) {
      console.log(`${String(index + 1).padStart(3)}. ${entry.score.toFixed(3)}  (chunk missing: ${entry.chunkId})`);
      return;
    }
    const where = `${chunk.path}:${chunk.startLine}-${chunk.endLine}`;
    const what = chunk.symbolName ?? chunk.kind;
    const part = chunk.part === null ? '' : ` [${chunk.part[0]}/${chunk.part[1]}]`;
    console.log(`${String(index + 1).padStart(3)}. ${entry.score.toFixed(3)}  ${where.padEnd(48)} ${what}${part}`);
  });
  console.log('');
}

main().catch((err: unknown) => {
  if (err instanceof IndexerError) {
    console.error(`\n${err.code}: ${err.message}\n`);
  } else {
    console.error('\nUnexpected failure:\n', err);
  }
  process.exitCode = 1;
});
