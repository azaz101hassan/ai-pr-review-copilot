import type { WalkthroughSummarizerInput } from '@/modules/reviews/types/walkthrough-summarizer';

// Substrings that should NOT appear in the intro when findings are
// present. Lowercased substring match; the post-call guard rejects the
// intro and returns null on any hit. Module-private so neither provider
// can fork the list.
const FORBIDDEN_WHEN_FINDINGS_PRESENT = [
  'no issues',
  'clean refactor',
  'low risk',
  'looks good',
  'no problems',
];

export function violatesFindingsGuard(
  intro: string,
  findings: WalkthroughSummarizerInput['findings'],
): boolean {
  if (findings.length === 0) return false;
  const lower = intro.toLowerCase();
  return FORBIDDEN_WHEN_FINDINGS_PRESENT.some((phrase) =>
    lower.includes(phrase),
  );
}
