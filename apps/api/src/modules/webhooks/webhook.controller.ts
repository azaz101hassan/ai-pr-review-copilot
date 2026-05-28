import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { GithubSignatureGuard } from '@/guards';
import { WebhookService } from './webhook.service';
import { GithubWebhookPayload } from './types/github-webhook-payload.types';

@Controller('webhooks')
export class WebhookController {
  constructor(private readonly service: WebhookService) {}

  @Post('github')
  @HttpCode(200)
  @UseGuards(GithubSignatureGuard)
  async receive(
    @Headers('x-github-event') event: string | undefined,
    @Headers('x-github-delivery') delivery: string | undefined,
    @Req() req: RawBodyRequest<Request>,
    @Body() payload: GithubWebhookPayload,
  ) {
    if (!event) {
      throw new BadRequestException('Missing X-GitHub-Event header');
    }
    if (!delivery) {
      throw new BadRequestException('Missing X-GitHub-Delivery header');
    }

    // rawBody is the bytes GitHub signed. The guard above rejects any
    // request that arrives without rawBody, so reaching this controller
    // implies it's present. We don't fall back to JSON.stringify(payload)
    // — that produces bytes that diverge from what was signed (key
    // ordering, whitespace, unicode escaping) and would silently lie
    // about what we received. If rawBody is somehow missing here, it
    // means the guard wiring is broken; surface it loudly.
    if (!req.rawBody) {
      throw new InternalServerErrorException(
        'rawBody missing after guard accepted the request — main.ts rawBody:true wiring is broken',
      );
    }

    return this.service.handleDelivery({
      event,
      delivery,
      action: payload?.action ?? null,
      payload: payload ?? {},
      rawPayload: req.rawBody.toString('utf8'),
    });
  }
}
