import { DOMParser } from "@xmldom/xmldom";
import type { ExecutableCell, CodeCell, LlmCell } from "../core/types.js";

function textWithoutAnnotations(element: Element): string {
  let text = "";
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 3 || node.nodeType === 4) text += node.nodeValue ?? "";
    // comment-start / comment-end (including annotation text) are not executable.
  }
  return text;
}

function required(element: Element, name: string): string {
  const value = element.getAttribute(name)?.trim();
  if (!value) throw new Error(`<${element.tagName}> requires @${name}`);
  return value;
}

function directChild(element: Element, tagName: string): Element | undefined {
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && (node as Element).tagName === tagName) return node as Element;
  }
  return undefined;
}

export function parseWorkflow(xml: string): ExecutableCell[] {
  const errors: string[] = [];
  const document = new DOMParser({
    errorHandler: {
      warning: (message) => errors.push(message),
      error: (message) => errors.push(message),
      fatalError: (message) => errors.push(message),
    },
  }).parseFromString(xml, "application/xml");
  if (errors.length) throw new Error(`Invalid XML: ${errors.join("; ")}`);
  const root = document.documentElement;
  if (root.tagName !== "workflow") throw new Error("Expected <workflow> root");

  const cells: ExecutableCell[] = [];
  const names = new Set<string>();
  for (let node = root.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (["description", "comment-start", "comment-end"].includes(element.tagName)) continue;
    if (!["code", "llm"].includes(element.tagName)) {
      throw new Error(`Unsupported element <${element.tagName}> in <workflow>`);
    }
    const name = required(element, "name");
    if (names.has(name)) throw new Error(`Duplicate cell name: ${name}`);
    names.add(name);

    if (element.tagName === "code") {
      const cell: CodeCell = {
        kind: "code", name, lang: required(element, "lang"),
        source: textWithoutAnnotations(element),
        version: element.getAttribute("version") ?? undefined,
        dependencies: element.getAttribute("dependencies") ?? undefined,
      };
      cells.push(cell);
    } else {
      const prompt = directChild(element, "prompt");
      if (!prompt) throw new Error(`<llm name="${name}"> requires <prompt>`);
      const output = directChild(element, "output");
      const cell: LlmCell = {
        kind: "llm", name, model: required(element, "model"),
        key: element.getAttribute("key") ?? undefined,
        prompt: textWithoutAnnotations(prompt),
        outputSchema: output ? JSON.parse(textWithoutAnnotations(output)) : undefined,
        maxOutputTokens: element.hasAttribute("max-output-tokens") ? Number(element.getAttribute("max-output-tokens")) : undefined,
        temperature: element.hasAttribute("temperature") ? Number(element.getAttribute("temperature")) : undefined,
        reasoningEffort: element.getAttribute("reasoning-effort") ?? undefined,
      };
      cells.push(cell);
    }
  }
  return cells;
}
