export const DIGEST_SETTINGS: Record<string, unknown>;
export const RECALL_ONLY_SETTINGS: Record<string, unknown>;
export function loadDistDigest(packageDir: string): Promise<Record<string, any>>;
export function countRawItems(raw: string): number;
export function digestPostBody(
  card: { item: { content: string; kind: string }; agent: string; force: boolean },
  input: { sessionID: string; messageID: string; project: string },
): Record<string, unknown>;
export function runDigestPipeline(input: Record<string, any>): Promise<Record<string, any>>;
