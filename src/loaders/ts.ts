import ts from "typescript";
import type { CodeLanguageLoader } from "./types.js";

/** Transpile a TS cell to ESM; execution still uses the Node.js worker. */
export const tsLoader: CodeLanguageLoader = {
  lang: "typescript",
  compiler: `typescript@${ts.version}`,
  compile(source, cellName) {
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        verbatimModuleSyntax: false,
      },
      fileName: "cell.ts",
      reportDiagnostics: true,
    });
    const failures = compiled.diagnostics?.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ) ?? [];
    if (failures.length) {
      throw new Error(
        `Cell '${cellName}' failed to transpile: ${failures
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
          .join("; ")}`,
      );
    }
    return compiled.outputText;
  },
};
