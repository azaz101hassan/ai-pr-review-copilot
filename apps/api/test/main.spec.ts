import { NestFactory } from '@nestjs/core';
import { bootstrap } from '@/main';

jest.mock('@nestjs/core', () => ({
  NestFactory: { create: jest.fn() },
}));

describe('apps/api bootstrap', () => {
  const create = NestFactory.create as jest.Mock;

  beforeEach(() => {
    create.mockReset();
  });

  function stubApp() {
    const listen = jest.fn().mockResolvedValue(undefined);
    create.mockResolvedValue({
      enableShutdownHooks: jest.fn(),
      useGlobalPipes: jest.fn(),
      listen,
    });
    return listen;
  }

  it('binds the HTTP server to 127.0.0.1 (R15 loopback)', async () => {
    const listen = stubApp();
    await bootstrap();
    expect(listen).toHaveBeenCalledTimes(1);
    const [, host] = listen.mock.calls[0];
    expect(host).toBe('127.0.0.1');
  });

  it('honors PORT env var when present and stays loopback-bound', async () => {
    const listen = stubApp();
    const originalPort = process.env.PORT;
    process.env.PORT = '4242';
    try {
      await bootstrap();
      const [port, host] = listen.mock.calls[0];
      expect(port).toBe(4242);
      expect(host).toBe('127.0.0.1');
    } finally {
      if (originalPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = originalPort;
      }
    }
  });
});
