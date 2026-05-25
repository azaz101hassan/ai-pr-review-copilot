import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  Optional,
  RawBodyRequest,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConfigService } from '@/config';

const PREFIX = 'sha256=';
const HEX_DIGEST_LENGTH = 64; // SHA-256 produces 32 bytes => 64 hex chars

@Injectable()
export class GithubSignatureGuard implements CanActivate {
  private readonly logger = new Logger(GithubSignatureGuard.name);
  private readonly secret: string;

  // @Optional() so tests can construct the guard with a raw secret string
  // instead of standing up the full ConfigService. Validation runs
  // regardless of source — ConfigService already validated, but tests
  // exercise the construction-time error path by passing raw strings.
  constructor(@Optional() configOrSecret?: ConfigService | string) {
    const resolved =
      typeof configOrSecret === 'string'
        ? configOrSecret
        : configOrSecret
          ? configOrSecret.githubWebhookSecret
          : process.env.GITHUB_WEBHOOK_SECRET;

    if (
      !resolved ||
      resolved === 'undefined' ||
      resolved === 'null' ||
      resolved.length < 16
    ) {
      throw new Error(
        'GITHUB_WEBHOOK_SECRET is missing, a placeholder ("undefined"/"null"), or shorter than 16 characters. Generate one with `openssl rand -hex 32` and put it in apps/api/.env before starting apps/api.',
      );
    }
    this.secret = resolved;
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<RawBodyRequest<Request>>();

    const rawBody = req.rawBody;
    if (!rawBody) {
      this.logger.warn(
        'req.rawBody is undefined — check that NestFactory.create({ rawBody: true }) is set in main.ts.',
      );
      throw new UnauthorizedException('Missing raw body');
    }

    const headerRaw = req.headers?.['x-hub-signature-256'];
    const header =
      typeof headerRaw === 'string'
        ? headerRaw
        : Array.isArray(headerRaw)
          ? headerRaw[0]
          : undefined;

    if (!header || !header.startsWith(PREFIX)) {
      throw new UnauthorizedException('Missing or malformed signature header');
    }

    const provided = header.slice(PREFIX.length);
    if (
      provided.length !== HEX_DIGEST_LENGTH ||
      !/^[a-f0-9]+$/i.test(provided)
    ) {
      throw new UnauthorizedException('Malformed signature value');
    }

    const expected = createHmac('sha256', this.secret)
      .update(rawBody)
      .digest('hex');

    const providedBuf = Buffer.from(provided, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (providedBuf.length !== expectedBuf.length) {
      throw new UnauthorizedException('Signature length mismatch');
    }

    let matches: boolean;
    try {
      matches = timingSafeEqual(providedBuf, expectedBuf);
    } catch {
      throw new UnauthorizedException('Signature comparison failed');
    }

    if (!matches) {
      throw new UnauthorizedException('Signature mismatch');
    }
    return true;
  }
}
