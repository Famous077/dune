/**
 * Groq, through its OpenAI-compatible chat completions API.
 *
 * Schema enforcement is JSON mode (`response_format: json_object`) with the shape stated in
 * the prompt, not tool calling — Groq's JSON mode is the more reliable of the two. The zod
 * schema in `generator.ts` does the real enforcement either way.
 *
 * The model id comes from GROQ_MODEL, never from code: Groq retires models regularly, and a
 * retirement should be a config change, not a deploy of new code.
 */

import { z } from 'zod';

import { ApiFailure } from '../errors';
import { ChatGenerator, InvalidModelOutput } from './generator';
import type { ChatMessage } from './generator';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/** Well inside API Gateway's hard 30 s, leaving room for retrieval and a retry. */
const REQUEST_TIMEOUT_MS = 12_000;

/** The answer is a few hundred tokens; the rest is headroom for reasoning models. */
const MAX_COMPLETION_TOKENS = 1500;

/** Rate-limit waits longer than this are reported instead of slept through. */
const MAX_RETRY_AFTER_S = 4;

const CompletionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable() }) }))
    .min(1),
  usage: z
    .object({ prompt_tokens: z.number(), completion_tokens: z.number(), total_time: z.number().optional() })
    .optional(),
});

const ErrorBodySchema = z.object({
  error: z.object({ message: z.string().optional(), code: z.string().nullable().optional() }),
});

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class GroqGenerator extends ChatGenerator {
  readonly id: string;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    super();
    this.id = `groq:${model}`;
  }

  protected async chat(messages: ChatMessage[], deadline: number): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining < 2_000) {
        throw new ApiFailure('MODEL_UNAVAILABLE', 'The model took too long to answer. Try again in a moment.');
      }
      let response: Response;
      try {
        response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages,
            response_format: { type: 'json_object' },
            temperature: 0.1,
            max_completion_tokens: MAX_COMPLETION_TOKENS,
          }),
          signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
        });
      } catch (err) {
        throw new ApiFailure('MODEL_UNAVAILABLE', 'The model took too long to answer. Try again in a moment.', {
          cause: err,
        });
      }

      if (response.ok) {
        const completion = CompletionSchema.parse(await response.json());
        console.log('groq: completion', { model: this.model, usage: completion.usage });
        const content = completion.choices[0]?.message.content;
        if (content === null || content === undefined || content.trim() === '') {
          throw new InvalidModelOutput('empty completion');
        }
        return content;
      }

      const body = ErrorBodySchema.safeParse(await response.json().catch(() => null));
      const code = body.success ? (body.data.error.code ?? '') : '';
      const detail = body.success ? (body.data.error.message ?? '') : '';
      console.error('groq: request failed', { status: response.status, code, detail, attempt });

      // The model could not produce JSON that parses. A failed attempt, not an outage.
      if (code === 'json_validate_failed') throw new InvalidModelOutput(detail);

      if (response.status === 401 || response.status === 403) {
        throw new ApiFailure(
          'MODEL_UNAVAILABLE',
          'Answer generation is not configured correctly: the model provider rejected the API key.',
        );
      }
      if (response.status === 404 || code === 'model_not_found' || code === 'model_decommissioned') {
        throw new ApiFailure(
          'MODEL_UNAVAILABLE',
          `The configured model "${this.model}" is not available from the provider. Update GROQ_MODEL.`,
        );
      }
      // Larger than the account's tokens-per-minute limit allows in one request. Waiting
      // does not help; this request will never fit.
      if (response.status === 413) {
        throw new ApiFailure(
          'QUERY_FAILED',
          'This question pulled in more code than the model account accepts in a single request. Try a narrower question.',
        );
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after') ?? 'NaN');
        if (attempt < 2 && Number.isFinite(retryAfter) && retryAfter <= MAX_RETRY_AFTER_S) {
          await pause(retryAfter * 1000);
          continue;
        }
        throw new ApiFailure('RATE_LIMITED', 'The answer service is busy right now. Try again in a minute.');
      }
      if (response.status >= 500 && attempt < 1) {
        await pause(500);
        continue;
      }
      if (response.status >= 500) {
        throw new ApiFailure('MODEL_UNAVAILABLE', 'The model provider is unavailable right now. Try again shortly.');
      }
      throw new ApiFailure('QUERY_FAILED', 'Could not generate an answer for this question. Try again in a moment.');
    }
  }
}
