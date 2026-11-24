import { Ajv } from "ajv";
import type { WorkflowContext } from "../core/context.js";
import type { LlmCell } from "../core/types.js";
import { interpolatePrompt } from "../core/expressions.js";

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

export async function runLlmCell(cell: LlmCell, wf: WorkflowContext): Promise<unknown> {
  const keyName = cell.key?.startsWith("env:") ? cell.key.slice(4) : (cell.key ?? "AI_GATEWAY_API_KEY");
  const key = wf.env(keyName);
  if (!key) throw new Error(`Missing API key environment variable: ${keyName}`);

  const prompt = interpolatePrompt(cell.prompt, wf);
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
  const body = await response.json() as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`LLM cell '${cell.name}' returned no text`);
  if (cell.outputSchema === undefined) return content;
  const parsed = parseModelJson(cell.name, content);
  const validate = new Ajv({ allErrors: true }).compile(cell.outputSchema as object);
  if (!validate(parsed)) throw new Error(`LLM cell '${cell.name}' output does not match schema: ${JSON.stringify(validate.errors)}`);
  return parsed;
}
