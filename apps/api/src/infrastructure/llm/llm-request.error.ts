import type { ToolCallRecord } from '@/modules/reviews/types/review.types';

/**
 * Typed error wrapping any LLM SDK failure. Both AnthropicLlmReviewer
 * and OpenRouterLlmReviewer throw this — call sites in ReviewsService
 * and ReviewsProcessor branch on `status` + `errorCode` without
 * stringifying the message.
 *
 * SCRUB DISCIPLINE: never include the response body, the request
 * payload, the API key, the diff text, or any rule body in the message
 * or in any field on this error. The SDKs' default APIError.message
 * stringifies the body; the adapters intentionally construct their own
 * message from `status` + `errorCode` only. `cause` is kept for
 * debugging but consumers should treat it as opaque and not stringify
 * it into logs without auditing what it carries.
 */
export class LlmRequestError extends Error {
  readonly name = 'LlmRequestError';
  readonly status: number;
  readonly errorCode?: string;
  readonly serverMessage?: string;
  readonly turnCount?: number;
  readonly toolCalls?: ToolCallRecord[];
  readonly retryAfterMs?: number;
  override readonly cause?: unknown;

  constructor(
    message: string,
    opts: {
      status: number;
      errorCode?: string;
      serverMessage?: string;
      turnCount?: number;
      toolCalls?: ToolCallRecord[];
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.status = opts.status;
    this.errorCode = opts.errorCode;
    this.serverMessage = opts.serverMessage;
    this.turnCount = opts.turnCount;
    this.toolCalls = opts.toolCalls;
    this.retryAfterMs = opts.retryAfterMs;
    this.cause = opts.cause;
  }
}
