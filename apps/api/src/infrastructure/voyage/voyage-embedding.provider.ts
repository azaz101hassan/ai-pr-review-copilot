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
  override readonly cause?: unknown;

  constructor(message: string, opts: { status: number; errorCode?: string; cause?: unknown }) {
    super(message);
    this.status = opts.status;
    this.errorCode = opts.errorCode;
    this.cause = opts.cause;
  }
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
      throw new VoyageRequestError('Voyage request failed (network or transport error)', {
        status: 0,
        cause: err,
      });
    }

    if (!response.ok) {
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
      throw new VoyageRequestError(
        `Voyage request failed: HTTP ${response.status}${errorCode ? ` (${errorCode})` : ''}`,
        { status: response.status, errorCode },
      );
    }

    return (await response.json()) as VoyageResponseBody;
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
