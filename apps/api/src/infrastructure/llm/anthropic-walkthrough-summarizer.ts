// apps/api/src/infrastructure/llm/anthropic-walkthrough-summarizer.ts
import type Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import {
  IWalkthroughSummarizer,
  WalkthroughSummarizerInput,
  WalkthroughSummarizerResult,
} from '@/modules/reviews/types/walkthrough-summarizer';
import { WALKTHROUGH_SUMMARIZER_SYSTEM_PROMPT } from './walkthrough-summarizer.prompt';

// 1500ms keeps this best-effort seam off the review critical path;
// a slow LLM call returns null rather than delaying the whole review.
const DEFAULT_TIMEOUT_MS = 1500;
// 250 tokens ≈ the 80–160 word prose target for a 1-2 paragraph intro;
// caps the user-message response size and per-call cost.
const MAX_TOKENS = 250;
// Caps the number of retrieved rules included in the user message to
// avoid a pathological retrieval count blowing out the prompt size.
const MAX_RULES_IN_PROMPT = 20;

// Substrings that should NOT appear in the intro when findings
// are present. Lowercased substring match; the post-call guard
// rejects the intro and returns null on any hit.
const FORBIDDEN_WHEN_FINDINGS_PRESENT = [
  'no issues',
  'clean refactor',
  'low risk',
  'looks good',
  'no problems',
];

export interface AnthropicWalkthroughSummarizerOptions {
  model: string;
  timeoutMs?: number;
}

export class AnthropicWalkthroughSummarizer implements IWalkthroughSummarizer {
  private readonly logger = new Logger(AnthropicWalkthroughSummarizer.name);

  constructor(
    private readonly client: Anthropic,
    private readonly options: AnthropicWalkthroughSummarizerOptions,
  ) {}

  async summarize(
    input: WalkthroughSummarizerInput,
  ): Promise<WalkthroughSummarizerResult | null> {
    const userMessage = buildUserMessage(input);
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Hold the timeout handle so it can be cleared in finally once the
    // race settles, whichever side wins. Without this, a fast API
    // resolution leaves the timer pending — a leaked handle that keeps
    // the event loop alive ~timeoutMs and trips Jest open-handle warnings.
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    let response: Anthropic.Messages.Message;
    try {
      // NOTE: the timeout fires via Promise.race and returns null promptly,
      // but it does NOT abort the in-flight HTTP request — an accepted,
      // bounded tradeoff for this best-effort once-per-review seam.
      response = (await Promise.race([
        this.client.messages.create({
          model: this.options.model,
          max_tokens: MAX_TOKENS,
          system: WALKTHROUGH_SUMMARIZER_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        }),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`summarizer timeout after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ])) as Anthropic.Messages.Message;
    } catch (err) {
      this.logger.warn(
        `summarizer.failed ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }

    // Belt-and-suspenders backstop: extractText is hardened, but wrap it
    // anyway so any unforeseen throw from a malformed response funnels to null.
    let intro: string | null;
    try {
      intro = extractText(response);
    } catch {
      return null;
    }
    if (!intro) return null;

    if (input.findings.length > 0 && containsForbiddenPhrase(intro)) {
      this.logger.warn('summarizer.rejected forbidden-phrase-with-findings');
      return null;
    }
    return { intro };
  }
}

function buildUserMessage(input: WalkthroughSummarizerInput): string {
  const findingsBlock =
    input.findings.length === 0
      ? 'Findings: none.'
      : `Findings (${input.findings.length}):\n${input.findings
          .map((f) => `- [${f.severity}] ${f.rule_id}: ${f.title}`)
          .join('\n')}`;
  const rulesBlock =
    input.retrievedRules.length === 0
      ? 'Rules retrieved: none.'
      : `Rules retrieved (${input.retrievedRules.length}):\n${input.retrievedRules
          .slice(0, MAX_RULES_IN_PROMPT)
          .map((r) => `- ${r.rule_id} (from ${r.source}): ${r.title}`)
          .join('\n')}`;
  return [
    '<diff>',
    input.diff,
    '</diff>',
    '',
    findingsBlock,
    '',
    rulesBlock,
    '',
    'Write the 1-2 paragraph summary now.',
  ].join('\n');
}

function extractText(response: Anthropic.Messages.Message): string | null {
  if (!response || !Array.isArray(response.content)) return null;
  const block = response.content.find(
    (b): b is Anthropic.Messages.TextBlock => b?.type === 'text',
  );
  if (!block || typeof block.text !== 'string') return null;
  const trimmed = block.text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function containsForbiddenPhrase(intro: string): boolean {
  const lower = intro.toLowerCase();
  return FORBIDDEN_WHEN_FINDINGS_PRESENT.some((phrase) =>
    lower.includes(phrase),
  );
}
