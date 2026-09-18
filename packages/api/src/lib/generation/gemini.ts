/**
 * Gemini, through the Generative Language API (`generateContent`).
 *
 * Schema enforcement is JSON mode (`responseMimeType: application/json`) with the shape
 * stated in the prompt; the zod schema in `generator.ts` does the real enforcement, the
 * same as for Groq.
 *
 * Model id, API key and thinking level come from GEMINI_MODEL, GEMINI_API_KEY and
 * GEMINI_THINKING_LEVEL, never from code: Google retires model ids to new users without
 * much warning.
 *
 * Free-tier Gemini is slow and bursty — the same one-line prompt has taken 5 s and 14 s,
 * and "high demand" 503s are routine. So every call runs against a deadline that leaves
 * room inside API Gateway's hard 30 s, and a slow provider becomes a clean error instead
 * of a gateway timeout the frontend cannot read.
 */

import { z } from 'zod';

import { ApiFailure } from '../errors';
import { ChatGenerator, InvalidModelOutput } from './generator';
import type { ChatMessage } from './generator';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Below this, a retry cannot finish in time, so it is not attempted. */
const MIN_ATTEMPT_MS = 4_000;

/** Thinking tokens count against this, so it is generous; the answer itself is small. */
const MAX_OUTPUT_TOKENS = 8192;

const MAX_RETRY_DELAY_S = 4;

const ResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({ parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })).optional() })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      thoughtsTokenCount: z.number().optional(),
    })
    .optional(),
});

const ErrorSchema = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
    details: z.array(z.record(z.string(), z.unknown())).optional(),
  }),
});

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Google reports how long to back off as a RetryInfo detail, e.g. `"retryDelay": "12s"`. */
function retryDelaySeconds(details: Record<string, unknown>[] | undefined): number | null {
  for (const detail of details ?? []) {
    const delay = detail['retryDelay'];
    if (typeof delay === 'string' && delay.endsWith('s')) {
      const seconds = Number.parseFloat(delay);
      if (Number.isFinite(seconds)) return seconds;
    }
  }
  return null;
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  /** `low`, `high` and so on, or null to leave the model's default. Model-specific. */
  thinkingLevel: string | null;
}

export class GeminiGenerator extends ChatGenerator {
  readonly id: string;

  constructor(private readonly options: GeminiOptions) {
    super();
    this.id = `gemini:${options.model}`;
  }

  protected async chat(messages: ChatMessage[], deadline: number): Promise<string> {
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content);
    const contents = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }));

    const body = JSON.stringify({
      systemInstruction: { parts: system.map((text) => ({ text })) },
      contents,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        ...(this.options.thinkingLevel === null ? {} : { thinkingConfig: { thinkingLevel: this.options.thinkingLevel } }),
      },
    });

    for (let attempt = 0; ; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining < MIN_ATTEMPT_MS) {
        throw new ApiFailure('MODEL_UNAVAILABLE', 'The model is taking too long to answer right now. Try again in a moment.');
      }

      let response: Response;
      try {
        response = await fetch(`${ENDPOINT}/${encodeURIComponent(this.options.model)}:generateContent`, {
          method: 'POST',
          // The key goes in a header, never the URL, so it cannot end up in a log line.
          headers: { 'x-goog-api-key': this.options.apiKey, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(remaining),
        });
      } catch (err) {
        throw new ApiFailure('MODEL_UNAVAILABLE', 'The model is taking too long to answer right now. Try again in a moment.', {
          cause: err,
        });
      }

      if (response.ok) {
        const parsed = ResponseSchema.parse(await response.json());
        console.log('gemini: completion', { model: this.options.model, usage: parsed.usageMetadata, attempt });

        if (parsed.promptFeedback?.blockReason !== undefined) {
          throw new ApiFailure('QUERY_FAILED', 'The model declined to answer this question. Try rephrasing it.');
        }
        const candidate = parsed.candidates?.[0];
        const text = (candidate?.content?.parts ?? [])
          .filter((part) => part.thought !== true)
          .map((part) => part.text ?? '')
          .join('');

        // Cut off mid-JSON: a failed attempt, which earns the one retry.
        if (candidate?.finishReason === 'MAX_TOKENS') throw new InvalidModelOutput('output hit the token limit');
        if (candidate?.finishReason !== undefined && candidate.finishReason !== 'STOP') {
          throw new ApiFailure('QUERY_FAILED', 'The model declined to answer this question. Try rephrasing it.');
        }
        if (text.trim() === '') throw new InvalidModelOutput('empty completion');
        return text;
      }

      const error = ErrorSchema.safeParse(await response.json().catch(() => null));
      const status = error.success ? (error.data.error.status ?? '') : '';
      const detail = error.success ? (error.data.error.message ?? '') : '';
      console.error('gemini: request failed', { httpStatus: response.status, status, detail, attempt });

      if (response.status === 401 || response.status === 403 || /api key/i.test(detail)) {
        throw new ApiFailure(
          'MODEL_UNAVAILABLE',
          'Answer generation is not configured correctly: the model provider rejected the API key.',
        );
      }
      if (response.status === 404) {
        throw new ApiFailure(
          'MODEL_UNAVAILABLE',
          `The configured model "${this.options.model}" is not available from the provider. Update GEMINI_MODEL.`,
        );
      }
      if (response.status === 400) {
        throw new ApiFailure(
          'MODEL_UNAVAILABLE',
          'The model provider rejected the request settings. Check GEMINI_MODEL and GEMINI_THINKING_LEVEL.',
        );
      }
      if (response.status === 429) {
        const delay = retryDelaySeconds(error.success ? error.data.error.details : undefined);
        if (attempt < 2 && delay !== null && delay <= MAX_RETRY_DELAY_S) {
          await pause(delay * 1000);
          continue;
        }
        throw new ApiFailure('RATE_LIMITED', 'The answer service is busy right now. Try again in a minute.');
      }
      // "This model is currently experiencing high demand" is a 503, and it is routine.
      if (response.status >= 500 && attempt < 2) {
        await pause(1000 * (attempt + 1));
        continue;
      }
      if (response.status >= 500) {
        throw new ApiFailure('MODEL_UNAVAILABLE', 'The model provider is overloaded right now. Try again shortly.');
      }
      throw new ApiFailure('QUERY_FAILED', 'Could not generate an answer for this question. Try again in a moment.');
    }
  }
}
