import { Injectable } from '@nestjs/common';
import { ConfigService } from '@/config';
import {
  IEmbeddingProvider,
  EmbedDocumentsResult,
  EmbedQueryResult,
} from '@/modules/embeddings/types/embedding-provider';

const VOYAGE_EMBEDDINGS_URL = 'https://api.voyageai.com/v1/embeddings';
// Voyage's per-request cap is 1000 inputs; 128 leaves headroom for
// future growth and keeps each request small enough that one rate-limit
// stall costs little. The seed corpus (~50 chunks) currently fits in a
// single batch.
const BATCH_SIZE = 128;
const DEFAULT_DIMENSION = 1024;

// In-provider retry policy for 429 responses. Voyage's free-tier
// embeddings quota resets on a ~30s window; 35s gives the window time
// to roll over plus a small safety margin. The provider does its own
// retry inside the worker job so a single rate-limit stall doesn't
// re-run the entire BullMQ job (Anthropic call, DB writes, octokit).
// On final exhaust we still set `retryAfterMs` on the thrown error so
// the worker-level BullMQ backoff (`reviewBackoffStrategy`) also
// honours the hint instead of falling back to exponential 1s/2s/4s.
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 35_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 60_000;

// Voyage uses asymmetric encoding: documents and queries get different
// `input_type` values. Mixing them degrades recall measurably, so we
// encode the discipline at the method level rather than letting the
// caller pass a free-form string.
type VoyageInputType = 'document' | 'query';

interface VoyageResponseBody {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { total_tokens: number };
}

// Typed error so the call site can branch on status without
// stringifying the message. NOTE: we never include the raw response
// body — Voyage's error payload can echo back parts of the input (or
// the API key on a misformed Authorization header) and a logged
// VoyageRequestError must be safe to read in a CI log or shared
// debugging session. Status + error_code is enough signal.
export class VoyageRequestError extends Error {
  readonly name = 'VoyageRequestError';
  readonly status: number;
  readonly errorCode?: string;
  // Surfaces to the BullMQ-level reviewBackoffStrategy when the
  // provider gives up after exhausting its own retries. Honoured by
  // the F4 closure with a 60s ceiling.
  readonly retryAfterMs?: number;
  override readonly cause?: unknown;

  constructor(
    message: string,
    opts: { status: number; errorCode?: string; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message);
    this.status = opts.status;
    this.errorCode = opts.errorCode;
    this.retryAfterMs = opts.retryAfterMs;
    this.cause = opts.cause;
  }
}

// Parses an RFC 9110 Retry-After header value. Supports the
// delta-seconds form (most APIs, including Voyage) and the
// HTTP-date form. Caps to MAX_RETRY_AFTER_MS so a hostile or
// malformed header can't park the provider for a long time.
export function parseRetryAfterMs(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const deltaMs = dateMs - Date.now();
    if (deltaMs > 0) return Math.min(deltaMs, MAX_RETRY_AFTER_MS);
  }

  return undefined;
}

@Injectable()
export class VoyageEmbeddingProvider implements IEmbeddingProvider {
  readonly modelName: string;
  readonly dimension: number = DEFAULT_DIMENSION;
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = config.voyageApiKey;
    this.modelName = config.embeddingModel;
  }

  async embedDocuments(texts: string[]): Promise<EmbedDocumentsResult> {
    if (texts.length === 0) return { vectors: [], tokensUsed: 0 };

    const vectors: number[][] = [];
    let tokensUsed = 0;
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const response = await this.callVoyage(batch, 'document');
      vectors.push(...this.sortByIndex(response, batch.length));
      tokensUsed += response.usage.total_tokens;
    }
    return { vectors, tokensUsed };
  }

  async embedQuery(text: string): Promise<EmbedQueryResult> {
    const response = await this.callVoyage([text], 'query');
    const ordered = this.sortByIndex(response, 1);
    return { vector: ordered[0], tokensUsed: response.usage.total_tokens };
  }

  private async callVoyage(
    input: string[],
    inputType: VoyageInputType,
  ): Promise<VoyageResponseBody> {
    // attempt 0 is the initial call; the loop runs up to MAX_RATE_LIMIT_RETRIES
    // additional iterations, so total attempts = MAX_RATE_LIMIT_RETRIES + 1.
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      let response: Response;
      try {
        response = await fetch(VOYAGE_EMBEDDINGS_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            input,
            model: this.modelName,
            input_type: inputType,
            output_dimension: this.dimension,
            truncation: true,
          }),
        });
      } catch (err) {
        throw new VoyageRequestError(
          'Voyage request failed (network or transport error)',
          { status: 0, cause: err },
        );
      }

      if (response.ok) {
        return (await response.json()) as VoyageResponseBody;
      }

      // Parse just enough of the body to extract `error_code` for
      // routing. We do NOT propagate the full body into the error
      // message; that body can contain echoed input or a misformatted
      // Authorization header value in some error paths.
      let errorCode: string | undefined;
      try {
        const body = JSON.parse(await response.text()) as { error_code?: string };
        if (typeof body.error_code === 'string') errorCode = body.error_code;
      } catch {
        // Body wasn't JSON — drop it on the floor. Status is the signal.
      }

      const isRateLimit = response.status === 429;
      const retryAfterMs = isRateLimit
        ? parseRetryAfterMs(response.headers.get('retry-after')) ??
          DEFAULT_RATE_LIMIT_BACKOFF_MS
        : undefined;
      const isLastAttempt = attempt === MAX_RATE_LIMIT_RETRIES;

      if (isRateLimit && !isLastAttempt) {
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
        continue;
      }

      throw new VoyageRequestError(
        `Voyage request failed: HTTP ${response.status}${errorCode ? ` (${errorCode})` : ''}`,
        { status: response.status, errorCode, retryAfterMs },
      );
    }

    // Unreachable — the loop either returns a parsed body or throws.
    // Present to satisfy strict TypeScript flow analysis.
    throw new Error(
      'VoyageEmbeddingProvider: retry loop exited without returning or throwing',
    );
  }

  private sortByIndex(body: VoyageResponseBody, expectedLength: number): number[][] {
    if (!Array.isArray(body.data) || body.data.length !== expectedLength) {
      throw new VoyageRequestError(
        `Voyage returned unexpected response shape: expected ${expectedLength} embeddings, got ${
          Array.isArray(body.data) ? body.data.length : 'non-array'
        }`,
        { status: 200 },
      );
    }
    const ordered: number[][] = new Array(expectedLength);
    for (const item of body.data) {
      if (item.index < 0 || item.index >= expectedLength) {
        throw new VoyageRequestError(
          `Voyage returned out-of-range index ${item.index} (expected 0..${expectedLength - 1})`,
          { status: 200 },
        );
      }
      ordered[item.index] = item.embedding;
    }
    return ordered;
  }
}
