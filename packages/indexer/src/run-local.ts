/**
 * The local pipeline shortcut: `npm run index -- <repoUrl>`.
 *
 * Runs clone and parse in one process against real S3 and DynamoDB, bypassing Step
 * Functions. Step Functions' job is retries and visibility, not logic, so it is only
 * exercised on deploy.
 *
 * Today this covers step 2 of the build order — clone, parse, graph. Chunk, embed and
 * persist join it as those steps land.
 *
 *   npm run index -- https://github.com/owner/repo
 *   npm run index -- https://github.com/owner/repo --dry-run   # no AWS calls
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { clone } from './clone';
import { buildGraph } from './graph';
import { getGraph, putGraph, putRepoMeta } from './lib/db';
import { IndexerError } from './lib/errors';
import { parseRepo } from './parse';

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
    throw new IndexerError(
      'INVALID_REPO_URL',
      'Usage: npm run index -- <repoUrl> [--dry-run] [--keep]',
    );
  }

  return {
    repoUrl,
    dryRun: flags.has('--dry-run'),
    keepWorkDir: flags.has('--keep'),
  };
}

function seconds(from: number): string {
  return `${((Date.now() - from) / 1000).toFixed(1)}s`;
}

function stage(name: string, detail: string): void {
  console.log(`  ${name.padEnd(12)} ${detail}`);
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

  try {
    /* Clone ---------------------------------------------------------------- */
    const cloneStarted = Date.now();
    const cloned = await clone({
      repoUrl: options.repoUrl,
      workDir,
      bucket: options.dryRun ? null : bucket,
      region,
    });

    const sourceFiles = cloned.files.filter((file) => file.parse);
    console.log(`\nIndexing ${cloned.name}  (repoId ${cloned.repoId}, commit ${cloned.commitSha.slice(0, 7)})\n`);
    stage(
      'cloning',
      `${cloned.fileCount} files kept, ${sourceFiles.length} to parse · skipped ${cloned.skipped.excludedDir} in excluded dirs, ${cloned.skipped.envFile} env, ${cloned.skipped.tooLarge} over 500 KB · ${seconds(cloneStarted)}`,
    );
    if (cloned.s3Prefix !== null) {
      stage('uploading', `${cloned.uploaded} files to ${cloned.s3Prefix}`);
    }
    if (cloned.truncated) {
      stage('truncated', 'more source files than the parse cap; the overflow was not parsed');
    }

    /* Parse ---------------------------------------------------------------- */
    const parseStarted = Date.now();
    const parsed = await parseRepo({
      rootDir: workDir,
      files: sourceFiles.map((file) => file.path),
      allFiles: cloned.files.map((file) => file.path),
    });

    stage(
      'parsing',
      `${parsed.files.length} parsed, ${parsed.failures.length} failed, ${parsed.syntaxErrors.length} with syntax errors · ${seconds(parseStarted)}`,
    );
    for (const failure of parsed.failures) {
      console.log(`               ! ${failure.path}: ${failure.reason}`);
    }

    /* Graph ---------------------------------------------------------------- */
    const { graph, stats } = buildGraph(parsed.files);
    stage(
      'graph',
      `${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.hiddenCount} isolated files hidden`,
    );
    stage(
      '',
      `${stats.externalImports} external imports ignored, ${stats.droppedEdges} edges to non-module files dropped`,
    );

    const lineCount = parsed.files.reduce((total, file) => total + file.lineCount, 0);
    const entryPoints = graph.nodes.filter((node) => node.entryPoint);
    const hubs = [...graph.nodes]
      .sort((a, b) => b.importedByCount - a.importedByCount)
      .slice(0, 5);

    /* Store ---------------------------------------------------------------- */
    if (options.dryRun) {
      const outDir = path.join(process.cwd(), 'node_modules', '.cache', 'dune');
      await mkdir(outDir, { recursive: true });
      const outFile = path.join(outDir, `graph-${cloned.repoId}.json`);
      await writeFile(outFile, JSON.stringify(graph, null, 2));
      stage('dry run', `nothing written to AWS; graph JSON at ${outFile}`);
    } else {
      const stored = await putGraph(cloned.repoId, graph);
      await putRepoMeta(
        {
          repoId: cloned.repoId,
          repoUrl: cloned.repoUrl,
          name: cloned.name,
          commitSha: cloned.commitSha,
          fileCount: cloned.fileCount,
          lineCount,
          truncated: cloned.truncated,
          parseFailures: parsed.failures.length,
          indexedAt: new Date().toISOString(),
        },
        {
          s3Prefix: cloned.s3Prefix,
          graphShardCount: stored.shardCount,
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          hiddenCount: graph.hiddenCount,
          sourceFileCount: sourceFiles.length,
        },
      );

      stage(
        'stored',
        `graph in ${stored.shardCount} shard(s), ${(stored.packedBytes / 1024).toFixed(1)} KB packed · repo record written`,
      );

      // Read it straight back, so "it is in DynamoDB" is proven rather than assumed.
      const readBack = await getGraph(cloned.repoId);
      if (readBack === null) {
        throw new IndexerError('INDEX_FAILED', 'The graph was written but could not be read back.');
      }
      stage('verified', `read back ${readBack.nodes.length} nodes, ${readBack.edges.length} edges`);
    }

    /* Summary -------------------------------------------------------------- */
    console.log(`\n  ${lineCount.toLocaleString()} lines across ${parsed.files.length} parsed files`);
    console.log(`  ${entryPoints.length} entry points, for example: ${entryPoints.slice(0, 3).map((node) => node.id).join(', ')}`);
    console.log('  most depended on:');
    for (const node of hubs) {
      console.log(`    ${String(node.importedByCount).padStart(3)} <- ${node.id}`);
    }
    console.log(`\nDone in ${seconds(started)}\n`);
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
