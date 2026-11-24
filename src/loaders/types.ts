/** Runtime-specific source compilation; environment provisioning is shared. */
export interface CodeLanguageLoader {
  readonly lang: "javascript" | "typescript";
  readonly compiler: string | null;
  compile(source: string, cellName: string): string;
}
