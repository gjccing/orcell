import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XmlDocument, XsdValidator } from "libxml2-wasm";

const SCHEMA_PATH = fileURLToPath(new URL("../../schemas/workflow.xsd", import.meta.url));

/** Validate both XML well-formedness and the exact v0.0.1 XSD contract. */
export async function validateWorkflow(path: string): Promise<void> {
  const [xmlSource, schemaSource] = await Promise.all([
    readFile(path),
    readFile(SCHEMA_PATH),
  ]);
  const schemaDocument = XmlDocument.fromBuffer(schemaSource);
  try {
    const validator = XsdValidator.fromDoc(schemaDocument);
    try {
      const workflowDocument = XmlDocument.fromBuffer(xmlSource);
      try {
        validator.validate(workflowDocument);
      } finally {
        workflowDocument.dispose();
      }
    } finally {
      validator.dispose();
    }
  } catch (error) {
    throw new Error(`XML/XSD validation failed for '${path}': ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    schemaDocument.dispose();
  }
}
