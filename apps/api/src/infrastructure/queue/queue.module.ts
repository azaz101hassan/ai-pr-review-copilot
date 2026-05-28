import {
  DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleInit,
} from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  ConfigModule,
  ConfigService,
  parseSkipRedisProbe,
} from '@/config';
import {
  REVIEW_QUEUE,
  REVIEW_QUEUE_NAME,
} from '@/modules/reviews/types/review-queue';
import { formatBriefError } from '@/types';
import { BullMQReviewQueue } from './bullmq-review-queue';
import { NoopReviewQueue } from './noop-review-queue';

// Day-5 BullMQ queue boot probe. Calls `queue.client` (the underlying
// IORedis client) and pings; throws on failure so a misconfigured
// REDIS_URL or stopped Redis container fails the process at startup
// rather than at first webhook arrival. Paired with U2's GET /app
// probe so both upstream dependencies surface as fail-fast at boot.
// F31 closure. Exported + the boot logic split into a public
// runProbe() method so Day-8 health surfaces (and operator-triggered
// re-probes after a Redis restart) can re-run it without booting a
// fresh module. Mirrors GitHubAppService.runProbe()'s shape.
@Injectable()
export class QueueBootProbe implements OnModuleInit {
  private readonly logger = new Logger(QueueBootProbe.name);

  constructor(
    @InjectQueue(REVIEW_QUEUE_NAME)
    private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.runProbe();
  }

  async runProbe(): Promise<void> {
    if (this.config.skipRedisProbe) {
      this.logger.warn(
        `Redis PING probe skipped via SKIP_REDIS_PROBE=true. Production must leave this unset.`,
      );
      return;
    }
    try {
      // BullMQ's IRedisClient interface intentionally narrows to the
      // commands BullMQ itself uses; `ping` isn't on the abstract
      // surface but is universally available on every real Redis
      // adapter (ioredis, node-redis, bun-built-in). Cast to call it
      // — keeping the dependency on the abstract interface elsewhere
      // so a future client-library swap is one place.
      const client = (await this.queue.client) as unknown as {
        ping: () => Promise<string>;
      };
      const result = await client.ping();
      if (result !== 'PONG') {
        throw new Error(`unexpected PING response: ${result}`);
      }
      this.logger.log(
        `Redis PING OK — queue "${REVIEW_QUEUE_NAME}" ready.`,
      );
    } catch (err) {
      throw new Error(
        `Redis ping failed for queue "${REVIEW_QUEUE_NAME}" — check REDIS_URL: ${formatBriefError(err)}`,
      );
    }
  }
}

// QueueModule wires the BullMQ root + the per-queue registration —
// EXCEPT when SKIP_REDIS_PROBE=true, in which case the entire BullMQ
// stack is skipped and REVIEW_QUEUE is bound to a no-op implementation.
//
// This conditional dispatch happens at module-definition time so
// jest's CJS runtime never even loads bullmq's Queue class (which
// would otherwise spawn an IORedis connection attempt regardless of
// whether the test ever called the queue). Mirrors the
// ReviewsModule.forRoot pattern that gates the dry-run route on
// ConfigService.enableDryRun via the exported parseEnableDryRun
// helper.
//
// We deliberately import ConfigModule explicitly into BOTH async
// factories — Nest resolves the inject token by walking the module
// graph, and an unimported ConfigModule yields a "ConfigService
// provider not found" error at boot.
@Module({})
export class QueueModule {
  static forRoot(): DynamicModule {
    const skip = parseSkipRedisProbe(process.env.SKIP_REDIS_PROBE, false);
    if (skip) {
      return {
        module: QueueModule,
        providers: [
          {
            provide: REVIEW_QUEUE,
            useClass: NoopReviewQueue,
          },
        ],
        exports: [REVIEW_QUEUE],
        global: false,
      };
    }
    return {
      module: QueueModule,
      imports: [
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            connection: parseRedisUrl(config.redisUrl),
          }),
        }),
        BullModule.registerQueueAsync({
          name: REVIEW_QUEUE_NAME,
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (_config: ConfigService) => ({
            // BullMQ's default job options. Each retry inserts a fresh
            // `reviews` row (per-attempt contract from Day-5 plan); the
            // worker emits a terminal failure on the third try.
            //
            // Backoff is `type: 'custom'`. The actual delay function
            // lives on the @Processor decorator (see
            // `reviews.processor.ts:reviewBackoffStrategy`) so it has
            // access to the thrown error and can honour
            // AnthropicRequestError.retryAfterMs. Falls back to a
            // 1s/2s/4s exponential for errors without a retry-after.
            // F4 closure.
            defaultJobOptions: {
              attempts: 3,
              backoff: {
                type: 'custom',
              },
              // Auto-clean BullMQ's side of completed/failed jobs after
              // 24h or the most recent 1000, whichever comes first. The
              // SQLite `reviews` table is the durable record; BullMQ's
              // job rows are short-lived telemetry.
              removeOnComplete: { age: 86_400, count: 1000 },
              removeOnFail: { age: 86_400, count: 1000 },
            },
          }),
        }),
      ],
      providers: [
        QueueBootProbe,
        {
          provide: REVIEW_QUEUE,
          useClass: BullMQReviewQueue,
        },
      ],
      exports: [REVIEW_QUEUE, BullModule],
      global: false,
    };
  }
}

// Convert a redis://[user:pass]@host:port URL into the IORedis
// connection-options shape BullMQ accepts. BullMQ accepts a URL too
// in many versions, but the option-object form is forward-compat
// across minor versions and lets us pass extra fields (tls, family)
// later without API churn. Documented in the Day-5 Open Questions
// — IORedis option shape is pinned against the installed version.
export function parseRedisUrl(rawUrl: string): {
  host: string;
  port: number;
  password?: string;
  username?: string;
  tls?: Record<string, unknown>;
} {
  const url = new URL(rawUrl);
  return {
    host: url.hostname || 'localhost',
    port: url.port ? Number(url.port) : 6379,
    ...(url.password
      ? { password: decodeURIComponent(url.password) }
      : {}),
    ...(url.username
      ? { username: decodeURIComponent(url.username) }
      : {}),
    // rediss:// → TLS on. Empty object enables TLS with default
    // verification settings.
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}
