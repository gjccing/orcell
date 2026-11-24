import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XmlCData, XmlDocument, XmlElement, XmlText, XsdValidator } from "libxml2-wasm";
import type { CodeCell, ExecutableCell, LlmCell } from "../core/types.js";

const SCHEMA_PATH = fileURLToPath(new URL("../../schemas/workflow.xsd", import.meta.url));

function textWithoutAnnotations(element: XmlElement): string {
  let text = "";
  for (let node = element.firstChild; node; node = node.next) {
    if (node instanceof XmlText || node instanceof XmlCData) text += node.content;
  }
  return text;
}

function child(element: XmlElement, name: string): XmlElement | undefined {
  for (let node = element.firstChild; node; node = node.next) {
    if (node instanceof XmlElement && node.name === name) return node;
  }
  return undefined;
}

function required(element: XmlElement, name: string): string {
  const value = element.attr(name)?.value.trim();
  if (!value) throw new Error(`<${element.name}> requires @${name}`);
  return value;
}

function optional(element: XmlElement, name: string): string | undefined {
  return element.attr(name)?.value;
}

function cellsFrom(root: XmlElement): ExecutableCell[] {
  const cells: ExecutableCell[] = [];
  for (let node = root.firstChild; node; node = node.next) {
    if (!(node instanceof XmlElement)) continue;
    if (node.name === "description" || node.name === "comment-start" || node.name === "comment-end") continue;
    if (node.name !== "code" && node.name !== "llm") {
      throw new Error(`Unsupported element <${node.name}> in <workflow>`);
    }
    const name = required(node, "name");
    if (node.name === "code") {
      const cell: CodeCell = {
        kind: "code",
        name,
        lang: required(node, "lang"),
        source: textWithoutAnnotations(node),
        version: optional(node, "version"),
        dependencies: optional(node, "dependencies"),
      };
      cells.push(cell);
    } else {
      const prompt = child(node, "prompt");
      if (!prompt) throw new Error(`<llm name="${name}"> requires <prompt>`);
      const output = child(node, "output");
      const maxOutputTokens = optional(node, "max-output-tokens");
      const temperature = optional(node, "temperature");
      const cell: LlmCell = {
        kind: "llm",
        name,
        model: required(node, "model"),
        key: optional(node, "key"),
        prompt: textWithoutAnnotations(prompt),
        outputSchema: output ? JSON.parse(textWithoutAnnotations(output)) as unknown : undefined,
        maxOutputTokens: maxOutputTokens !== undefined ? Number(maxOutputTokens) : undefined,
        temperature: temperature !== undefined ? Number(temperature) : undefined,
        reasoningEffort: optional(node, "reasoning-effort"),
      };
      cells.push(cell);
    }
  }
  return cells;
}

async function openValidated(path: string): Promise<XmlDocument> {
  const [xmlSource, schemaSource] = await Promise.all([
    readFile(path),
    readFile(SCHEMA_PATH),
  ]);
  const schemaDocument = XmlDocument.fromBuffer(schemaSource);
  let validator: XsdValidator | undefined;
  let workflowDocument: XmlDocument | undefined;
  try {
    validator = XsdValidator.fromDoc(schemaDocument);
    workflowDocument = XmlDocument.fromBuffer(xmlSource);
    validator.validate(workflowDocument);
    const document = workflowDocument;
    workflowDocument = undefined;
    return document;
  } catch (error) {
    workflowDocument?.dispose();
    throw new Error(`XML/XSD validation failed for '${path}': ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    validator?.dispose();
    schemaDocument.dispose();
  }
}

/** Validate well-formedness and the v0.0.3 XSD contract. */
export async function validateWorkflow(path: string): Promise<void> {
  const document = await openValidated(path);
  document.dispose();
}

/** Validate, then project executable cells. Comment markers stay out of the source. */
export async function loadWorkflow(path: string): Promise<ExecutableCell[]> {
  const document = await openValidated(path);
  try {
    return cellsFrom(document.root);
  } finally {
    document.dispose();
  }
}
