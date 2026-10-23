export function promptSections(prompt: string): { user: string; assistant: string };
export function splitSentences(text: string): string[];
export function cannedBaselineResponse(
  prompt: string,
  hooks?: { transcript?: (entry: { sentenceCount: number; itemCount: number }) => void },
): { text: string };
