export const FORBIDDEN_PATTERNS: Array<{ name: string; regex: RegExp }>;
export function privacyFindings(text: string): string[];
export function loadFixtures(fixtureDir: string): Promise<{
  conversations: Record<string, any>;
  expectations: Record<string, any>;
  turns: number;
  version: string;
  fingerprint: string;
}>;
export function estimateModelCalls(fixtures: Record<string, any>): number;
