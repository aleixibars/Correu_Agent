// The Anthropic client the pipeline talks to (context.md §6, §11).

import Anthropic from "@anthropic-ai/sdk";

export const loadAnthropicApiKey = (
  env: Record<string, string | undefined> = process.env,
): string => {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required to classify mail.");
  }
  return apiKey;
};

/**
 * Read at boot rather than per call: a missing key should stop the worker
 * instead of failing one thread at a time, forever.
 */
export const createAnthropicClient = (
  env: Record<string, string | undefined> = process.env,
): Anthropic => new Anthropic({ apiKey: loadAnthropicApiKey(env) });
