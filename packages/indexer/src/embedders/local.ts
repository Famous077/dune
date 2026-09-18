/**
 * The default embedder: `all-MiniLM-L6-v2` running in-process through transformers.js.
 * No account access, no per-call cost, 384 dimensions.
 *
 * The model is pinned to one Hugging Face revision, so vectors made at index time and at
 * query time come from the same weights. Two ways to load it:
 *
 *   - `EMBED_MODEL_DIR` set: load only from that directory, never the network. This is how
 *     the Lambda runs — the model is bundled into the deployment package, so a cold start
 *     never waits on a download.
 *   - unset: fetch the pinned revision from the hub on first use and cache it on disk.
 *     This is the local-development path.
 *
 * MiniLM reads at most 256 tokens; longer text is truncated, so a long chunk is represented
 * by its prefix and opening lines — the path, the symbol and the signature, which carry most
 * of the signal anyway.
 */

import type { Embedder } from '../embed';

export const MODEL = 'Xenova/all-MiniLM-L6-v2';

/** The Lambda build reads this line to fetch the same files. Change both together. */
export const MODEL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';

interface Extractor {
  (texts: string[], options: { pooling: 'mean'; normalize: boolean }): Promise<{
    data: Float32Array;
    dims: number[];
  }>;
}

export class LocalEmbedder implements Embedder {
  readonly id = `local:${MODEL}`;
  readonly dimension = 384;

  private extractor: Promise<Extractor> | null = null;

  /** Loaded once, on first use, and reused — loading the model is the slow part. */
  private load(): Promise<Extractor> {
    this.extractor ??= import('@xenova/transformers').then(({ env, pipeline }) => {
      const modelDir = process.env['EMBED_MODEL_DIR'];
      if (modelDir !== undefined && modelDir !== '') {
        env.localModelPath = modelDir;
        // Fail loudly if the bundled files are missing, rather than quietly downloading.
        env.allowRemoteModels = false;
        // The Lambda filesystem is read-only outside /tmp; there is nothing to cache.
        env.useFSCache = false;
      }
      return pipeline('feature-extraction', MODEL, {
        quantized: true,
        revision: MODEL_REVISION,
      }) as unknown as Promise<Extractor>;
    });
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const extractor = await this.load();
    const output = await extractor(texts, { pooling: 'mean', normalize: true });

    const [rows, columns] = output.dims;
    if (rows !== texts.length || columns !== this.dimension) {
      throw new Error(`MiniLM returned dims [${output.dims.join(', ')}] for ${texts.length} texts`);
    }

    return texts.map((_, index) =>
      output.data.slice(index * this.dimension, (index + 1) * this.dimension),
    );
  }
}
