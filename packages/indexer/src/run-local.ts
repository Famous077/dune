/**
 * The local pipeline shortcut: `npm run index -- <repoUrl>`.
 *
 * Runs the same pipeline IndexFn runs, in this process, against real S3 and DynamoDB.
 * EMBEDDER selects the embedder: `local` (default) or `titan`.
 *
 *   npm run index -- https://github.com/owner/repo
 *   npm run index -- https://github.com/owner/repo --dry-run   # nothing written to AWS
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { IndexerError } from './lib/errors';
import { indexRepository } from './pipeline';

interface Options {
  repoUrl: string;
  dryRun: boolean;
  keepWorkDir: boolean;
}

function parseArgs(argv: string[]): Options {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const repoUrl = positional[0];

  if (repoUrl === undefined) {
    throw new IndexerError('INVALID_REPO_URL', 'Usage: npm run index -- <repoUrl> [--dry-run] [--keep]');
  }

  return { repoUrl, dryRun: flags.has('--dry-run'), keepWorkDir: flags.has('--keep') };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const region = process.env['AWS_REGION'] ?? 'ap-south-1';
  const bucket = process.env['REPO_BUCKET'] ?? null;

  if (!options.dryRun && bucket === null) {
    throw new IndexerError(
      'INDEX_FAILED',
      'REPO_BUCKET is not set. Take it from the RepoBucketName output of the dune stack, or pass --dry-run to skip S3 and DynamoDB.',
    );
  }

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'dune-'));
  const started = Date.now();
  console.log('');

  try {
    const summary = await indexRepository({
      repoUrl: options.repoUrl,
      workDir,
      bucket: options.dryRun ? null : bucket,
      region,
      jobId: null,
      report: async () => {},
      log: (name, detail) => console.log(`  ${name.padEnd(12)} ${detail}`),
    });

    if (options.dryRun) {
      const outDir = path.join(process.cwd(), 'node_modules', '.cache', 'dune');
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, `graph-${summary.cloned.repoId}.json`), JSON.stringify(summary.graph, null, 2));
      await writeFile(path.join(outDir, `chunks-${summary.cloned.repoId}.json`), JSON.stringify(summary.chunks, null, 2));
      console.log(`  ${'dry run'.padEnd(12)} nothing written to AWS; graph and chunks JSON in ${outDir}`);
    }

    const entryPoints = summary.graph.nodes.filter((node) => node.entryPoint);
    const hubs = [...summary.graph.nodes].sort((a, b) => b.importedByCount - a.importedByCount).slice(0, 5);
    console.log(`\n  ${summary.lineCount.toLocaleString()} lines across ${summary.parsed.files.length} parsed files`);
    console.log(`  ${entryPoints.length} entry points, for example: ${entryPoints.slice(0, 3).map((node) => node.id).join(', ')}`);
    console.log('  most depended on:');
    for (const node of hubs) console.log(`    ${String(node.importedByCount).padStart(3)} <- ${node.id}`);
    console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  } finally {
    if (options.keepWorkDir) {
      console.log(`Working tree kept at ${workDir}`);
    } else {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

main().catch((err: unknown) => {
  if (err instanceof IndexerError) {
    console.error(`\n${err.code}: ${err.message}\n`);
  } else {
    console.error('\nUnexpected failure while indexing:\n', err);
  }
  process.exitCode = 1;
});
