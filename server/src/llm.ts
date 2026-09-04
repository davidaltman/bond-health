/**
 * The one place this server talks to a model.
 *
 * The original prototype called AWS Bedrock directly from each call site,
 * which tied the repo to an employer SSO profile and meant a clean clone
 * couldn't run. Everything now goes through this module, so swapping
 * provider is a single edit rather than a hunt through call sites.
 *
 * There is deliberately no free-text completion helper. Every caller wants
 * strict JSON matching a schema, and unstructured model output has no path
 * into this app.
 */
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface JsonCompletionOptions {
  system: string;
  user: string;
  /** Schema must satisfy OpenAI strict mode: every object needs
   *  additionalProperties:false and every property listed in `required`.
   *  Nullable fields use a type union, e.g. `["string", "null"]`. */
  schemaName: string;
  schema: Record<string, unknown>;
  model?: string;
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
}

/** Thrown when the server is missing configuration, as opposed to the model
 *  call itself failing. Callers surface this differently: it's a setup
 *  problem the operator can fix, not a transient error worth retrying. */
export class LlmConfigError extends Error {}

function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new LlmConfigError(
      "OPENAI_API_KEY is not set. Copy server/.env.example to server/.env and add a personal key.",
    );
  }
  return key;
}

export async function completeJson<T>(options: JsonCompletionOptions): Promise<T> {
  const body: Record<string, unknown> = {
    model: options.model ?? DEFAULT_MODEL,
    messages: [
      { role: "system", content: options.system },
      { role: "user", content: options.user },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: options.schemaName, strict: true, schema: options.schema },
    },
  };
  // gpt-5.x rejects `max_tokens` and any temperature other than the default,
  // so neither is sent here.
  if (options.maxOutputTokens) body.max_completion_tokens = options.maxOutputTokens;
  if (options.reasoningEffort) body.reasoning_effort = options.reasoningEffort;

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${requireApiKey()}`,
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI ${response.status}: ${raw.slice(0, 500)}`);
  }

  const parsed = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };
  const choice = parsed.choices?.[0];
  const content = choice?.message?.content?.trim();
  if (!content) {
    throw new Error(
      `OpenAI returned no content (finish_reason: ${choice?.finish_reason ?? "unknown"})`,
    );
  }
  return JSON.parse(content) as T;
}
