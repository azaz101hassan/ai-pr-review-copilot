// apps/api/src/modules/reviews/types/walkthrough-summarizer.ts

// The walkthrough prose summarizer is a separate LLM seam from
// the agent loop. The agent loop produces findings; this
// summarizer produces a 1-2 paragraph plain-English description
// of what the PR does. It runs AFTER the agent loop on the
// success path and is allowed to fail without affecting the
// review row's terminal state.
//
// Mirrors the ILlmReviewer / WALKTHROUGH_SUMMARIZER pattern:
// interface and token in modules/reviews/types/; concrete
// implementation in infrastructure/llm/. Consumers inject the
// interface; the module binding picks the provider.

export const WALKTHROUGH_SUMMARIZER = Symbol('WalkthroughSummarizer');

export interface WalkthroughSummarizerInput {
  diff: string;
  findings: Array<{
    rule_id: string;
    title: string;
    severity: 'error' | 'warning' | 'info';
  }>;
  retrievedRules: Array<{
    rule_id: string;
    source: string;
    title: string;
  }>;
}

export interface WalkthroughSummarizerResult {
  intro: string;
}

export interface IWalkthroughSummarizer {
  // Single one-shot LLM call. Returns the intro string on
  // success, or null when the call fails for any reason
  // (timeout, 4xx, malformed response, post-call sanity check
  // rejection). Never throws into the caller.
  summarize(
    input: WalkthroughSummarizerInput,
  ): Promise<WalkthroughSummarizerResult | null>;
}
