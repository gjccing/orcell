#!/usr/bin/env node
import { resolve } from "node:path";
import { runWorkflow } from "./core/run.js";
import { validateWorkflow } from "./xml/validator.js";

const [command, ...args] = process.argv.slice(2);
if (!(["validate", "run"].includes(command ?? "")) || args.length !== 1) {
  console.error("Usage: orcell <validate|run> <workflow.xml>");
  process.exitCode = 2;
} else {
  const path = resolve(args[0]);
  try {
    await validateWorkflow(path);
    if (command === "validate") {
      console.log(`Valid XML/XSD: ${path}`);
    } else {
      const result = await runWorkflow(path);
      if (result !== undefined) {
        process.stdout.write(`${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
