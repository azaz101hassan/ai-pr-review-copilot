import { Injectable, Logger } from '@nestjs/common';
import {
  EnqueueResult,
  IReviewQueue,
  ReviewJobData,
} from '@/modules/reviews/types/review-queue';

// No-op IReviewQueue used in tests (and any other context where
// SKIP_REDIS_PROBE=true). Returns 'added' for every enqueue without
// touching Redis. Production NEVER wires this — QueueModule.forRoot()
// only registers it when ConfigService.skipRedisProbe is true.
@Injectable()
export class NoopReviewQueue implements IReviewQueue {
  private readonly logger = new Logger(NoopReviewQueue.name);

  async enqueueReview(data: ReviewJobData): Promise<EnqueueResult> {
    this.logger.debug(
      `noop enqueue jobId=${data.pr_node_id} head_sha=${data.head_sha}`,
    );
    return { jobId: data.pr_node_id, result: 'added' };
  }
}
