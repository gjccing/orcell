import Ajv from "ajv";
import type { WorkflowContext } from "../core/context.js";
import type { LlmCell } from "../core/types.js";
import { interpolatePrompt } from "../core/expressions.js";

export async function runLlmCell(cell: LlmCell, wf: WorkflowContext): Promise<unknown> {
  const keyName = cell.key?.startsWith("env:") ? cell.key.slice(4) : (cell.key ?? "AI_GATEWAY_API_KEY");
  const key = wf.env(keyName);
  if (!key) throw new Error(`Missing API key environment variable: ${keyName}`);

  const prompt = interpolatePrompt(cell.prompt, wf);
  const payload: Record<string, unknown> = {
    model: cell.model,
    messages: [{ role: "user", content: prompt }],
  };
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
  const body = await response.json() as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`LLM cell '${cell.name}' returned no text`);
  if (cell.outputSchema === undefined) return content;
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { throw new Error(`LLM cell '${cell.name}' returned invalid JSON`); }
  const validate = new Ajv({ allErrors: true }).compile(cell.outputSchema as object);
  if (!validate(parsed)) throw new Error(`LLM cell '${cell.name}' output does not match schema: ${JSON.stringify(validate.errors)}`);
  return parsed;
}
