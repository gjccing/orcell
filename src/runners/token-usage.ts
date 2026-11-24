export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

interface UsageParts {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function tokenUsage(parts: UsageParts): TokenUsage | undefined {
  if (parts.inputTokens === undefined && parts.outputTokens === undefined && parts.totalTokens === undefined) return undefined;
  const inputTokens = parts.inputTokens ?? 0;
  const outputTokens = parts.outputTokens ?? 0;
  const usage: TokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens: parts.totalTokens ?? inputTokens + (parts.cachedInputTokens ?? 0) + outputTokens,
  };
  if (parts.cachedInputTokens !== undefined) usage.cachedInputTokens = parts.cachedInputTokens;
  if (parts.reasoningTokens !== undefined) usage.reasoningTokens = parts.reasoningTokens;
  return usage;
}

export function tokenUsageFromGateway(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const body = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  return tokenUsage({
    inputTokens: finite(body.prompt_tokens),
    outputTokens: finite(body.completion_tokens),
    totalTokens: finite(body.total_tokens),
    cachedInputTokens: finite(body.prompt_tokens_details?.cached_tokens),
    reasoningTokens: finite(body.completion_tokens_details?.reasoning_tokens),
  });
}

/** Cursor `--output-format json` reports uncached input separately from cache read and write. */
export function tokenUsageFromCursor(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const body = usage as Record<string, unknown>;
  const cacheRead = finite(body.cacheReadTokens);
  const cacheWrite = finite(body.cacheWriteTokens);
  return tokenUsage({
    inputTokens: finite(body.inputTokens),
    outputTokens: finite(body.outputTokens),
    cachedInputTokens: cacheRead === undefined && cacheWrite === undefined ? undefined : (cacheRead ?? 0) + (cacheWrite ?? 0),
    reasoningTokens: finite(body.reasoningTokens),
  });
}

export function tokenUsageFromClaude(body: unknown): TokenUsage | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as { usage?: Record<string, unknown>; modelUsage?: Record<string, Record<string, unknown>> };
  const usage = record.usage;
  if (usage) {
    const cacheRead = finite(usage.cache_read_input_tokens);
    const cacheCreate = finite(usage.cache_creation_input_tokens);
    const parsed = tokenUsage({
      inputTokens: finite(usage.input_tokens),
      outputTokens: finite(usage.output_tokens),
      cachedInputTokens: cacheRead === undefined && cacheCreate === undefined ? undefined : (cacheRead ?? 0) + (cacheCreate ?? 0),
    });
    if (parsed) return parsed;
  }
  const models = Object.values(record.modelUsage ?? {});
  if (models.length === 0) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  for (const model of models) {
    inputTokens += finite(model.inputTokens) ?? 0;
    outputTokens += finite(model.outputTokens) ?? 0;
    cachedInputTokens += (finite(model.cacheReadInputTokens) ?? 0) + (finite(model.cacheCreationInputTokens) ?? 0);
  }
  return tokenUsage({ inputTokens, outputTokens, cachedInputTokens });
}

function tokenUsageFromCodexCounts(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const body = usage as Record<string, unknown>;
  return tokenUsage({
    inputTokens: finite(body.input_tokens),
    outputTokens: finite(body.output_tokens),
    totalTokens: finite(body.total_tokens),
    cachedInputTokens: finite(body.cached_input_tokens),
    reasoningTokens: finite(body.reasoning_output_tokens),
  });
}

/** Codex `--json` prints JSONL. The last cumulative `token_count` or `turn.completed` usage wins. */
export function tokenUsageFromCodexStdout(stdout: string): TokenUsage | undefined {
  let found: TokenUsage | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: { type?: string; msg?: { type?: string; info?: { total_token_usage?: unknown; last_token_usage?: unknown }; usage?: unknown }; info?: { total_token_usage?: unknown; last_token_usage?: unknown }; usage?: unknown };
    try { event = JSON.parse(line) as typeof event; }
    catch { continue; }
    const message = event.msg ?? event;
    if (message.type === "token_count") {
      const info = message.info;
      found = tokenUsageFromCodexCounts(info?.total_token_usage ?? info?.last_token_usage) ?? found;
    } else if (message.type === "turn.completed") {
      found = tokenUsageFromCodexCounts(message.usage) ?? found;
    }
  }
  return found;
}
