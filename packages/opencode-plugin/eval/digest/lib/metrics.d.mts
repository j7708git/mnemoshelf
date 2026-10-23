export function evaluateTurn(input: {
  id: string;
  expectation: Record<string, unknown>;
  actual: Record<string, unknown>;
}): Record<string, any>;
export function aggregateMetrics(
  turns: Record<string, any>[],
  input: { digestTimeoutMs: number; modelLatencies: number[]; crossProjectLeaks: number },
): Record<string, any>;
export function softThresholds(metrics: Record<string, any>): Array<{
  id: string;
  label: string;
  actual: number | null;
  threshold: number;
  met: boolean;
}>;
export function hardConditions(metrics: Record<string, any>): Array<{
  id: string;
  label: string;
  actual: unknown;
  ok: boolean;
}>;
