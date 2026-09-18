/**
 * Picks the generator from GENERATOR: `gemini` (the default) or `groq`. Configuration is
 * checked when a question arrives, not at load, so a missing key breaks answers with a
 * clear message and leaves the health check and everything else running.
 */

import { ApiFailure } from '../errors';
import { GeminiGenerator } from './gemini';
import type { Generator } from './generator';
import { GroqGenerator } from './groq';

let cached: Generator | null = null;

function required(names: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = process.env[name] ?? '';
    if (value === '') missing.push(name);
    values[name] = value;
  }
  if (missing.length > 0) {
    throw new ApiFailure('MODEL_UNAVAILABLE', `Answer generation is not configured: set ${missing.join(' and ')}.`);
  }
  return values;
}

export function getGenerator(): Generator {
  if (cached !== null) return cached;

  const kind = process.env['GENERATOR'] || 'gemini';

  if (kind === 'gemini') {
    const env = required(['GEMINI_API_KEY', 'GEMINI_MODEL']);
    cached = new GeminiGenerator({
      apiKey: env['GEMINI_API_KEY'] ?? '',
      model: env['GEMINI_MODEL'] ?? '',
      thinkingLevel: process.env['GEMINI_THINKING_LEVEL'] || null,
    });
  } else if (kind === 'groq') {
    const env = required(['GROQ_API_KEY', 'GROQ_MODEL']);
    cached = new GroqGenerator(env['GROQ_API_KEY'] ?? '', env['GROQ_MODEL'] ?? '');
  } else {
    throw new ApiFailure(
      'MODEL_UNAVAILABLE',
      `Answer generation is set to "${kind}", which is not a generator. Use "gemini" or "groq".`,
    );
  }

  return cached;
}

export type { Generation, Generator } from './generator';
