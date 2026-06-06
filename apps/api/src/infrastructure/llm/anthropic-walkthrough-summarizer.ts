// apps/api/src/infrastructure/llm/anthropic-walkthrough-summarizer.ts
import type Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import {
  IWalkthroughSummarizer,
  WalkthroughSummarizerInput,
  WalkthroughSummarizerResult,
} from '@/modules/reviews/types/walkthrough-summarizer';
import { WALKTHROUGH_SUMMARIZER_SYSTEM_PROMPT } from '@/infrastructure/llm/walkthrough-summarizer.prompt';
import { SUMMARIZER_MAX_TOKENS, SUMMARIZER_DEFAULT_TIMEOUT_MS } from '@/infrastructure/llm/llm.constants';
import { buildSummarizerUserMessage } from '@/infrastructure/llm/helpers/build-summarizer-user-message';
import { violatesFindingsGuard } from '@/infrastructure/llm/helpers/summarizer-findings-guard';

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
    // Orchestration mirrors its sibling summarizer (openrouter); keep the timeout + never-throws handling in sync.
    const userMessage = buildSummarizerUserMessage(input);
    const timeoutMs = this.options.timeoutMs ?? SUMMARIZER_DEFAULT_TIMEOUT_MS;

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
          max_tokens: SUMMARIZER_MAX_TOKENS,
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

    if (violatesFindingsGuard(intro, input.findings)) {
      this.logger.warn('summarizer.rejected forbidden-phrase-with-findings');
      return null;
    }
    return { intro };
  }
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
