import type { RepoContextErrorReason } from '@/modules/reviews/types/repo-context-provider';

export function formatProviderError(
  reason: RepoContextErrorReason,
  message: string,
): string {
  return `${reason}: ${message}`;
}
