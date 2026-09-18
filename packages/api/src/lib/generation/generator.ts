/**
 * Generation — see `docs/01-BACKEND.md`, "Generation".
 *
 * A `Generator` takes the assembled context and returns a validated `Answer`. Gemini and
 * Groq implement it; Bedrock drops in behind the same interface if access arrives. How a
 * provider forces the JSON shape is its own business — JSON mode for Gemini and Groq, tool
 * calling for Bedrock — but every provider's output goes through a zod schema, the same
 * one-retry rule, and the same deadline. That part lives here, once.
 *
 * `generate` produces answers. `generateJson` is the same machinery for any other shape,
 * such as suggestion drafts.
 */

import { AnswerSchema } from '@dune/shared';
import type { Answer } from '@dune/shared';
import type { z } from 'zod';

/** From the doc, verbatim. */
export const SYSTEM_PROMPT =
  'You help engineers locate where a change belongs in a codebase you have been given context for. You never invent file paths. Every file you name must appear in the provided context. If the context does not support a confident answer, say so and name the most likely candidates instead of guessing. You are not writing code; you are locating work.';

/**
 * The shape, stated in the prompt. With JSON mode there is no tool schema to carry it, so
 * the model reads it here; the zod schema is what actually enforces it.
 */
export const OUTPUT_FORMAT = `Respond with one JSON object and nothing else. It must have exactly these keys:

{
  "recommendedFile": string or null — the repo-relative path of the file where the change belongs, copied exactly from the context,
  "attachTo": string or null — the file the change hooks into, such as a router or a page, when that is a different file; otherwise null,
  "reason": string — two or three sentences on why this is the place, grounded in the code shown,
  "affected": string[] — routes, pages or features the change touches, such as "/group/[groupId]"; [] if none,
  "testsToUpdate": string[] — test files from the context that would need updating; [] if none,
  "sources": [{ "file": string, "lines": [start, end] }] — the code your answer rests on, using the file and line range shown in each code heading; at least one,
  "confidence": "high" or "medium" or "low",
  "candidates": [{ "file": string, "reason": string }] or null — when you are not confident, the two or three most plausible places; otherwise null. Never a place the team lists as a dead end: a file where a rejected approach was tried is not a candidate for that approach
}

Every path you write must appear in the context exactly as written there.`;

/**
 * Everything one generation may spend, retries included. API Gateway cuts off at 30 s;
 * this leaves room for retrieval (up to ~1.5 s cold) and the response.
 */
export const GENERATION_BUDGET_MS = 25_000;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JsonRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
}

export interface JsonGeneration<T> {
  /** The validated value, or null when both attempts failed validation. */
  value: T | null;
  /** The last reply that parsed as JSON, for salvage. */
  raw: unknown;
  /** 1 when the first reply validated; 2 when a retry was needed. */
  attempts: number;
  generatorId: string;
}

export interface Generation {
  /** The validated answer, or null when both attempts failed validation. */
  answer: Answer | null;
  /** Whatever fields did validate, for the salvage path. */
  partial: Partial<Answer>;
  attempts: number;
  generatorId: string;
}

export interface Generator {
  readonly id: string;
  generate(context: string): Promise<Generation>;
  generateJson<T>(request: JsonRequest<T>): Promise<JsonGeneration<T>>;
}

/**
 * A provider could not produce valid JSON at all — Groq reports `json_validate_failed`,
 * Gemini stops at its token limit. A failed attempt, not an outage.
 */
export class InvalidModelOutput extends Error {}

function describeIssues<T>(schema: z.ZodType<T>, value: unknown): string {
  const result = schema.safeParse(value);
  if (result.success) return '';
  return result.error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Keeps each top-level answer field that validates on its own. */
function salvageAnswer(value: unknown): Partial<Answer> {
  if (typeof value !== 'object' || value === null) return {};
  const partial: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(AnswerSchema.shape)) {
    const field = schema.safeParse((value as Record<string, unknown>)[key]);
    if (field.success) partial[key] = field.data;
  }
  return partial as Partial<Answer>;
}

/**
 * The shared half of every provider: validation, one retry with the problem appended, the
 * deadline. A provider supplies only `chat` — one schema-enforced call that must finish by
 * `deadline`.
 */
export abstract class ChatGenerator implements Generator {
  abstract readonly id: string;

  protected abstract chat(messages: ChatMessage[], deadline: number): Promise<string>;

  async generateJson<T>(request: JsonRequest<T>): Promise<JsonGeneration<T>> {
    const deadline = Date.now() + GENERATION_BUDGET_MS;
    const messages: ChatMessage[] = [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ];
    let lastParsed: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let raw: string | null = null;
      try {
        raw = await this.chat(messages, deadline);
      } catch (err) {
        if (!(err instanceof InvalidModelOutput)) throw err;
      }

      let problem = 'the reply was not valid JSON';
      if (raw !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = undefined;
        }
        if (parsed !== undefined) {
          lastParsed = parsed;
          const result = request.schema.safeParse(parsed);
          if (result.success) {
            return { value: result.data, raw: parsed, attempts: attempt, generatorId: this.id };
          }
          problem = describeIssues(request.schema, parsed);
        }
      }

      console.warn('generation: reply failed validation', { generator: this.id, attempt, problem });
      if (attempt === 1) {
        messages.push(
          { role: 'assistant', content: raw ?? '(no valid JSON)' },
          {
            role: 'user',
            content: `That reply did not match the required JSON shape: ${problem}. Reply again with only the corrected JSON object, using exactly the keys described.`,
          },
        );
      }
    }

    return { value: null, raw: lastParsed, attempts: 2, generatorId: this.id };
  }

  async generate(context: string): Promise<Generation> {
    const result = await this.generateJson({
      system: `${SYSTEM_PROMPT}\n\n${OUTPUT_FORMAT}`,
      user: context,
      schema: AnswerSchema,
    });
    return {
      answer: result.value,
      partial: result.value ?? salvageAnswer(result.raw),
      attempts: result.attempts,
      generatorId: this.id,
    };
  }
}
