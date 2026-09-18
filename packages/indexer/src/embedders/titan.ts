/**
 * The Bedrock path: Amazon Titan Text Embeddings V2, 1,024 dimensions.
 *
 * Not the default — Bedrock is optional for this hackathon and our model access is pending.
 * Select it with EMBEDDER=titan once access is granted, then re-index: its vectors are not
 * comparable with the local embedder's.
 *
 * Titan V2 through InvokeModel takes one text per call, so "batching" here means bounded
 * parallel calls. True batch embedding is Bedrock's asynchronous batch-inference job API,
 * which is the wrong shape for an index that should finish in minutes.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';

import type { Embedder } from '../embed';
import { IndexerError } from '../lib/errors';

/** Titan V2 accepts up to 8,192 tokens or 50,000 characters; stay clear of both. */
const MAX_INPUT_CHARS = 30_000;

/** Parallel InvokeModel calls. The SDK's adaptive retry absorbs throttling beyond this. */
const CONCURRENCY = 8;

const DIMENSION = 1024;

/** What Bedrock returns is validated, like everything else that comes back from a model. */
const TitanResponseSchema = z.object({
  embedding: z.array(z.number()).length(DIMENSION),
  inputTextTokenCount: z.number().int().nonnegative(),
});

export interface TitanOptions {
  region: string;
  modelId: string;
}

function errorName(err: unknown): string {
  return typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : '';
}

export class TitanEmbedder implements Embedder {
  readonly id: string;
  readonly dimension = DIMENSION;

  private readonly client: BedrockRuntimeClient;
  private readonly modelId: string;

  constructor(options: TitanOptions) {
    // A plain model id, not a global inference profile: the `global.` prefix is for Claude.
    this.modelId = options.modelId;
    this.id = `bedrock:${options.modelId}`;
    this.client = new BedrockRuntimeClient({
      region: options.region,
      maxAttempts: 6,
      retryMode: 'adaptive',
    });
  }

  private async embedOne(text: string): Promise<Float32Array> {
    let raw: Uint8Array;
    try {
      const response = await this.client.send(
        new InvokeModelCommand({
          modelId: this.modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({
            inputText: text.slice(0, MAX_INPUT_CHARS),
            dimensions: DIMENSION,
            normalize: true,
          }),
        }),
      );
      raw = response.body;
    } catch (err) {
      throw this.translate(err);
    }

    const parsed = TitanResponseSchema.parse(JSON.parse(new TextDecoder().decode(raw)));
    return Float32Array.from(parsed.embedding);
  }

  /** Model-access problems become one clear, non-retryable message instead of a stack. */
  private translate(err: unknown): Error {
    const name = errorName(err);

    if (name === 'AccessDeniedException' || name === 'ResourceNotFoundException') {
      return new IndexerError(
        'MODEL_UNAVAILABLE',
        `Bedrock embeddings are not available on this account (${name}). Request access to ${this.modelId} in the Bedrock console, or set EMBEDDER=local.`,
        { cause: err },
      );
    }
    if (name === 'ValidationException') {
      return new IndexerError(
        'MODEL_UNAVAILABLE',
        `Bedrock rejected the request for ${this.modelId}. Check BEDROCK_EMBED_MODEL_ID and the region, or set EMBEDDER=local.`,
        { cause: err },
      );
    }
    if (name === 'ThrottlingException') {
      // Reached only after the SDK's own retries are exhausted.
      return new IndexerError('RATE_LIMITED', 'Bedrock is throttling embedding calls. Try again shortly.', {
        cause: err,
      });
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const results = new Array<Float32Array>(texts.length);
    let cursor = 0;

    const workers = Array.from({ length: Math.min(CONCURRENCY, texts.length) }, async () => {
      for (;;) {
        const index = cursor++;
        const text = texts[index];
        if (text === undefined) return;
        results[index] = await this.embedOne(text);
      }
    });
    await Promise.all(workers);

    return results;
  }
}
