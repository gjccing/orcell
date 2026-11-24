import type { CodeLanguageLoader } from "./types.js";

/** Execute a JS cell with the locally installed Node.js runtime. */
export const jsLoader: CodeLanguageLoader = {
  lang: "javascript",
  compiler: null,
  compile(source) {
    return source;
  },
};
