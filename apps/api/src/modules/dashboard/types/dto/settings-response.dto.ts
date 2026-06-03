import { SeverityLevel } from '@/modules/reviews/reviews.service';
import { KnowledgeSourceRecord } from '@/modules/embeddings/types/knowledge-source.types';

// Positive-allowlist response shape for GET /dashboard/settings.
//
// Only the fields listed here are ever returned. The controller
// builds this DTO explicitly from ConfigService properties and
// repository data — the raw ConfigService instance is never passed
// to a serializer. This is the enforcement mechanism for the
// no-secrets-in-the-settings-response invariant.
//
// Fields deliberately NOT included:
// - anthropicApiKey, voyageApiKey, appPrivateKey, githubWebhookSecret
// - appId, redisUrl, dogfoodRepos, databasePath
// - evalBaseline (not yet plumbed)
export class SettingsResponseDto {
  model!: string;
  embeddingModel!: string;
  chromaCollection!: string;
  knowledgeSources!: Array<{
    id: string;
    name: string;
    description: string | null;
  }>;
  severityGate!: {
    allowed: SeverityLevel[];
    default: SeverityLevel;
  };

  constructor(params: {
    model: string;
    embeddingModel: string;
    chromaCollection: string;
    knowledgeSources: Pick<KnowledgeSourceRecord, 'id' | 'name' | 'description'>[];
    severityGate: {
      allowed: SeverityLevel[];
      default: SeverityLevel;
    };
  }) {
    this.model = params.model;
    this.embeddingModel = params.embeddingModel;
    this.chromaCollection = params.chromaCollection;
    this.knowledgeSources = params.knowledgeSources.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
    }));
    this.severityGate = params.severityGate;
  }
}
