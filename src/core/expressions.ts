import type { WorkflowContext } from "./context.js";

function drill(value: unknown, path: string): unknown {
  return path ? path.split(".").reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value) : value;
}

export function interpolatePrompt(prompt: string, wf: WorkflowContext): string {
  return prompt.replace(/\{\{([\s\S]*?)\}\}/g, (_match, raw: string) => {
    const expr = raw.trim();
    const method = /^wf\.(getState|getReturn|getReturns|env)\(\s*["']([^"']+)["']\s*\)(?:\.([\w.]+))?$/.exec(expr);
    const fromLabel = /^([\w-]+)\.return(?:\.([\w.]+))?$/.exec(expr);
    let value: unknown;
    if (method) {
      const [, fn, key, path = ""] = method;
      switch (fn) {
        case "getState": value = wf.getState(key); break;
        case "getReturn": value = wf.getReturn(key); break;
        case "getReturns": value = wf.getReturns(key); break;
        case "env": value = wf.env(key); break;
      }
      value = drill(value, path);
    } else if (fromLabel) {
      value = drill(wf.getReturn(fromLabel[1]), fromLabel[2] ?? "");
    } else {
      throw new Error(`Unsupported prompt expression: ${expr}`);
    }
    if (value === undefined) throw new Error(`Unresolved prompt expression: ${expr}`);
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}
