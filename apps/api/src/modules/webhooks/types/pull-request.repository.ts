import { PullRequestRecord } from './pull-request.types';

// Symbol token because TypeScript interfaces don't exist at runtime, so
// NestJS DI cannot bind on the interface itself. The webhooks module
// resolves this token; infrastructure/db provides the SQLite-backed
// implementation. Swapping persistence engines means swapping this
// binding — no changes inside modules/.
export const PULL_REQUEST_REPOSITORY = Symbol('PullRequestRepository');

export interface IPullRequestRepository {
  save(pr: PullRequestRecord): void;
  findByNodeId(nodeId: string): PullRequestRecord | undefined;
}
