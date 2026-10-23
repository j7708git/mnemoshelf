export function makeSanitizer(input?: { home?: string; roots?: string[] }): (value: unknown) => string;
export function gitInfo(repoRoot: string): {
  head: string | null;
  short: string | null;
  dirty: boolean | null;
  dirtyFileCount: number | null;
};
export function renderMarkdown(report: Record<string, any>, sanitize?: (value: unknown) => string): string;
export function writeReport(
  report: Record<string, any>,
  outDir: string,
): Promise<{ jsonPath: string; mdPath: string }>;
