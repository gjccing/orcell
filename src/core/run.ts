import { resolve } from "node:path";
import { WorkflowContext } from "./context.js";
import { RunLogger } from "./logger.js";
import { EnvironmentLoader } from "../loaders/environment.js";
import { loadWorkflow } from "../xml/workflow.js";
import { runCodeCell } from "../runners/code.js";
import { runLlmCell } from "../runners/llm.js";

export async function runWorkflow(path: string): Promise<unknown> {
  const workflowPath = resolve(path);
  const cells = await loadWorkflow(workflowPath);
  const wf = new WorkflowContext();
  const loader = new EnvironmentLoader();
  const logger = new RunLogger();
  let result: unknown;
  await logger.write("run-start", { workflow: workflowPath, cells: cells.length });
  try {
    // TODO: a workflow loop so one LLM cell can judge one item at a time. See README.md.
    for (const cell of cells) {
      await logger.write("cell-start", { cell: cell.name, kind: cell.kind });
      result = cell.kind === "code"
        ? await runCodeCell(cell, wf, workflowPath, loader, logger)
        : await runLlmCell(cell, wf, logger);
      wf.recordReturn(cell.name, result);
      if (cell.kind === "llm") await logger.write("return", { cell: cell.name, value: result });
      await logger.write("cell-end", { cell: cell.name });
    }
    await logger.write("run-end", { result });
    return result;
  } catch (error) {
    await logger.write("run-error", { message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await logger.flush();
  }
}
