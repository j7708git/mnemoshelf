export const MIN_NEEDLE_CHARS: number;
export function normalizeForMatch(value: unknown): string;
export function needleLength(needle: string): number;
export function isUsableNeedle(needle: string): boolean;
export function includesNeedle(haystack: string | string[], needle: string): boolean;
export function missingNeedles(haystack: string | string[], needles: string[]): string[];
export function hitNeedles(haystack: string | string[], needles: string[]): string[];
