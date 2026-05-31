import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@/config';
import {
  IReviewRepository,
  REVIEW_REPOSITORY,
  ReviewFilterSpec,
} from '@/modules/reviews/types/review.repository';
import {
  IPullRequestRepository,
  PULL_REQUEST_REPOSITORY,
} from '@/modules/webhooks/types/pull-request.repository';
import {
  IKnowledgeChunkRepository,
  KNOWLEDGE_CHUNK_REPOSITORY,
} from '@/modules/embeddings/types/knowledge-chunk.repository';
import {
  IKnowledgeSourceRepository,
  KNOWLEDGE_SOURCE_REPOSITORY,
} from '@/modules/embeddings/types/knowledge-source.repository';
import { ALLOWED_SEVERITIES, DEFAULT_SEVERITY } from '@/modules/reviews/reviews.service';
import { FilterSpecDto } from './types/dto/filter-spec.dto';
import { SettingsResponseDto } from './types/dto/settings-response.dto';
import {
  AnalyticsResponse,
  FilterOptionsResponse,
  HydratedChunk,
  ReviewDetailResponse,
  ReviewListResponse,
} from './types/dashboard-response.types';

// Maximum number of items per filter-population list (repos, authors, recent PRs).
const FILTER_POPULATION_LIMIT = 100;

// Default page size for the reviews list.
const DEFAULT_LIMIT = 50;

@Injectable()
export class DashboardService {
  constructor(
    @Inject(REVIEW_REPOSITORY) private readonly reviewRepo: IReviewRepository,
    @Inject(PULL_REQUEST_REPOSITORY) private readonly prRepo: IPullRequestRepository,
    @Inject(KNOWLEDGE_CHUNK_REPOSITORY) private readonly chunkRepo: IKnowledgeChunkRepository,
    @Inject(KNOWLEDGE_SOURCE_REPOSITORY) private readonly sourceRepo: IKnowledgeSourceRepository,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reviews list
  // ---------------------------------------------------------------------------

  getReviews(dto: FilterSpecDto): ReviewListResponse {
    const spec = dtoToFilterSpec(dto);
    const limit = dto.limit ?? DEFAULT_LIMIT;
    const offset = dto.offset ?? 0;

    const items = this.reviewRepo.findFiltered(spec, { limit, offset });
    const total = this.reviewRepo.countFiltered(spec);

    return { items, total, offset, limit };
  }

  // ---------------------------------------------------------------------------
  // Review detail
  // ---------------------------------------------------------------------------

  getReviewDetail(id: string): ReviewDetailResponse {
    const result = this.reviewRepo.findByIdWithFindings(id);
    if (!result) {
      throw new NotFoundException(`Review ${id} not found`);
    }

    const { review, findings } = result;

    // Parse the stored JSON array of chunk IDs and hydrate each one.
    let chunkIds: string[] = [];
    try {
      const parsed: unknown = JSON.parse(review.retrieved_chunk_ids);
      if (Array.isArray(parsed)) {
        chunkIds = parsed.filter((x): x is string => typeof x === 'string');
      }
    } catch {
      // Malformed JSON in the column — treat as no chunks
    }

    const retrievedChunks = this.hydrateChunks(chunkIds);

    return { review, findings, retrievedChunks };
  }

  // ---------------------------------------------------------------------------
  // Analytics aggregate
  // ---------------------------------------------------------------------------

  getAnalytics(dto: FilterSpecDto): AnalyticsResponse {
    const spec = dtoToFilterSpec(dto);
    return this.reviewRepo.aggregateByFilter(spec);
  }

  // ---------------------------------------------------------------------------
  // Filter population
  // ---------------------------------------------------------------------------

  getFilterOptions(dto: FilterSpecDto): FilterOptionsResponse {
    const spec = dtoToFilterSpec(dto);

    const repos = this.reviewRepo.distinctRepos(spec, FILTER_POPULATION_LIMIT);
    const authors = this.reviewRepo.distinctAuthors(spec, FILTER_POPULATION_LIMIT);
    const recentPrs = this.prRepo.findRecentMatching(spec, FILTER_POPULATION_LIMIT);

    return { repos, authors, recentPrs };
  }

  // ---------------------------------------------------------------------------
  // Settings (positive allowlist — never return raw ConfigService)
  // ---------------------------------------------------------------------------

  async getSettings(): Promise<SettingsResponseDto> {
    const sources = this.sourceRepo.listAll();

    return new SettingsResponseDto({
      model: this.config.anthropicModel,
      embeddingModel: this.config.embeddingModel,
      chromaCollection: this.config.chromaCollection,
      knowledgeSources: sources.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      })),
      severityGate: {
        allowed: [...ALLOWED_SEVERITIES],
        default: DEFAULT_SEVERITY,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  // Hydrates chunk IDs to their full record or a { id, missing: true }
  // placeholder when the chunk no longer exists in knowledge_chunks.
  private hydrateChunks(ids: string[]): HydratedChunk[] {
    if (ids.length === 0) return [];

    const found = this.chunkRepo.findByIds(ids);
    const foundMap = new Map(found.map((c) => [c.id, c]));

    return ids.map((id): HydratedChunk => {
      const chunk = foundMap.get(id);
      if (!chunk) {
        return { id, missing: true };
      }
      return {
        id: chunk.id,
        missing: false,
        source_id: chunk.source_id,
        rule_id: chunk.rule_id,
        title: chunk.title,
        body: chunk.body,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// DTO → FilterSpec mapper
// ---------------------------------------------------------------------------

function dtoToFilterSpec(dto: FilterSpecDto): ReviewFilterSpec {
  return {
    repo: dto.repo,
    author: dto.author,
    prNodeId: dto.pr_node_id,
    sinceMs: dto.since,
    untilMs: dto.until,
  };
}
