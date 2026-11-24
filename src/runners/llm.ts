import { Ajv } from "ajv";
import type { WorkflowContext } from "../core/context.js";
import type { RunLogger } from "../core/logger.js";
import type { LlmCell } from "../core/types.js";
import { interpolatePrompt } from "../core/expressions.js";
import { parseLlmModel } from "./llm-model.js";
import { runSubscriptionCli } from "./subscription-cli.js";
import { tokenUsageFromGateway, type TokenUsage } from "./token-usage.js";

function parseModelJson(cellName: string, content: string): unknown {
  const candidates = [content.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  if (fenced) candidates.push(fenced[1].trim());
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) as unknown; }
    catch { /* The model may wrap the object in a markdown fence. */ }
  }
  throw new Error(`LLM cell '${cellName}' returned invalid JSON: ${content.trim().slice(0, 300)}`);
}

interface LlmText {
  text: string;
  usage?: TokenUsage;
}

async function runGateway(cell: LlmCell, wf: WorkflowContext, prompt: string): Promise<LlmText> {
  const keyName = cell.key?.startsWith("env:") ? cell.key.slice(4) : (cell.key ?? "AI_GATEWAY_API_KEY");
  const key = wf.env(keyName);
  if (!key) throw new Error(`Missing API key environment variable: ${keyName}`);

  const payload: Record<string, unknown> = {
    model: cell.model,
    messages: [{ role: "user", content: prompt }],
  };
  if (cell.outputSchema !== undefined) {
    payload.response_format = {
      type: "json_schema",
      json_schema: {
        name: cell.name.replace(/[^\w-]/g, "_") || "output",
        schema: cell.outputSchema,
      },
    };
  }
  if (cell.maxOutputTokens !== undefined) payload.max_tokens = cell.maxOutputTokens;
  if (cell.temperature !== undefined) payload.temperature = cell.temperature;
  if (cell.reasoningEffort !== undefined) payload.reasoning_effort = cell.reasoningEffort;

  const response = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`AI Gateway returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const body = await response.json() as { choices?: { message?: { content?: string } }[]; usage?: unknown };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`LLM cell '${cell.name}' returned no text`);
  return { text: content, usage: tokenUsageFromGateway(body.usage) };
}

export async function runLlmCell(cell: LlmCell, wf: WorkflowContext, logger: RunLogger): Promise<unknown> {
  const prompt = interpolatePrompt(cell.prompt, wf);
  const target = parseLlmModel(cell.model);
  const completion = target.kind === "cli"
    ? await runSubscriptionCli(target.cli, target.model, prompt, cell.outputSchema)
    : await runGateway(cell, wf, prompt);
  const usage = completion.usage;
  await logger.write("usage", {
    cell: cell.name,
    model: cell.model,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    ...(usage?.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(usage?.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
  });
  const content = completion.text;
  if (cell.outputSchema === undefined) return content;
  const parsed = parseModelJson(cell.name, content);
  const validate = new Ajv({ allErrors: true }).compile(cell.outputSchema as object);
  if (!validate(parsed)) throw new Error(`LLM cell '${cell.name}' output does not match schema: ${JSON.stringify(validate.errors)}`);
  return parsed;
}
