export interface CodeCell {
  kind: "code";
  name: string;
  lang: string;
  source: string;
  version?: string;
  dependencies?: string;
}

export interface LlmCell {
  kind: "llm";
  name: string;
  model: string;
  key?: string;
  prompt: string;
  outputSchema?: unknown;
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
}

export type ExecutableCell = CodeCell | LlmCell;
