import {
  BadRequestException,
  InternalServerErrorException,
  RawBodyRequest,
} from '@nestjs/common';
import { Request } from 'express';
import {
  GithubWebhookPayload,
  WebhookController,
  WebhookHandlerStatus,
  WebhookService,
} from '@/modules/webhooks';

function makeService() {
  const handleDelivery = jest.fn(
    async (): Promise<{ status: WebhookHandlerStatus }> => ({
      status: 'processed',
    }),
  );
  return {
    instance: { handleDelivery } as unknown as WebhookService,
    handleDelivery,
  };
}

function makeReq(
  rawBody: Buffer | undefined,
): RawBodyRequest<Request> {
  return { rawBody } as unknown as RawBodyRequest<Request>;
}

const VALID_PAYLOAD: GithubWebhookPayload = {
  action: 'opened',
  pull_request: {
    node_id: 'PR_unit',
    number: 1,
    title: 't',
    state: 'open',
    head: { sha: 'a'.repeat(40) },
    base: { sha: 'b'.repeat(40) },
    user: { login: 'octocat' },
    created_at: '2026-05-24T00:00:00Z',
    updated_at: '2026-05-24T00:00:00Z',
  },
  repository: { full_name: 'octocat/hello-world' },
};

const VALID_RAW = Buffer.from(JSON.stringify(VALID_PAYLOAD));

describe('WebhookController', () => {
  describe('header validation', () => {
    it('rejects with BadRequestException when X-GitHub-Event is missing', async () => {
      const { instance, handleDelivery } = makeService();
      const controller = new WebhookController(instance);

      await expect(
        controller.receive(
          undefined,
          'delivery-id',
          makeReq(VALID_RAW),
          VALID_PAYLOAD,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(handleDelivery).not.toHaveBeenCalled();
    });

    it('rejects with BadRequestException when X-GitHub-Delivery is missing', async () => {
      const { instance, handleDelivery } = makeService();
      const controller = new WebhookController(instance);

      await expect(
        controller.receive(
          'pull_request',
          undefined,
          makeReq(VALID_RAW),
          VALID_PAYLOAD,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(handleDelivery).not.toHaveBeenCalled();
    });
  });

  describe('rawBody invariant', () => {
    it('rejects with InternalServerErrorException when rawBody is missing (guard wiring broken)', async () => {
      const { instance, handleDelivery } = makeService();
      const controller = new WebhookController(instance);

      await expect(
        controller.receive(
          'pull_request',
          'delivery-id',
          makeReq(undefined),
          VALID_PAYLOAD,
        ),
      ).rejects.toThrow(InternalServerErrorException);
      expect(handleDelivery).not.toHaveBeenCalled();
    });
  });

  describe('happy path delegation', () => {
    it('forwards the raw bytes verbatim — does not re-serialize the parsed body', async () => {
      const { instance, handleDelivery } = makeService();
      const controller = new WebhookController(instance);

      // Raw bytes with whitespace that JSON.stringify(payload) would NOT
      // produce — proves the controller uses req.rawBody, not the parsed
      // payload, for the rawPayload field.
      const rawWithWhitespace = Buffer.from(
        '{\n  "action": "opened",\n  "pull_request": { "node_id": "PR_unit" }\n}',
      );

      await controller.receive(
        'pull_request',
        'd-roundtrip',
        makeReq(rawWithWhitespace),
        VALID_PAYLOAD,
      );

      expect(handleDelivery).toHaveBeenCalledTimes(1);
      expect(handleDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'pull_request',
          delivery: 'd-roundtrip',
          action: 'opened',
          payload: VALID_PAYLOAD,
          rawPayload: rawWithWhitespace.toString('utf8'),
        }),
      );
    });

    it('coerces missing payload.action to null on the WebhookDelivery shape', async () => {
      const { instance, handleDelivery } = makeService();
      const controller = new WebhookController(instance);

      const payloadWithoutAction = {
        zen: 'Anything added dilutes everything else.',
      } as unknown as GithubWebhookPayload;
      const raw = Buffer.from(JSON.stringify(payloadWithoutAction));

      await controller.receive(
        'ping',
        'd-ping',
        makeReq(raw),
        payloadWithoutAction,
      );

      expect(handleDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ action: null, event: 'ping' }),
      );
    });
  });
});
