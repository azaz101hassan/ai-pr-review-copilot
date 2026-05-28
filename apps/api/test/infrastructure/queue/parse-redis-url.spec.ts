import { parseRedisUrl } from '@/infrastructure/queue';

describe('parseRedisUrl', () => {
  it('parses a bare host:port', () => {
    expect(parseRedisUrl('redis://localhost:6379')).toEqual({
      host: 'localhost',
      port: 6379,
    });
  });

  it('parses a URL with password', () => {
    expect(parseRedisUrl('redis://:secret@redis.internal:6380')).toEqual({
      host: 'redis.internal',
      port: 6380,
      password: 'secret',
    });
  });

  it('parses a URL with both username and password', () => {
    expect(parseRedisUrl('redis://user:secret@host:6379')).toEqual({
      host: 'host',
      port: 6379,
      username: 'user',
      password: 'secret',
    });
  });

  it('URL-decodes percent-encoded password chars', () => {
    expect(
      parseRedisUrl('redis://:p%40ss%21@host:6379').password,
    ).toBe('p@ss!');
  });

  it('enables TLS for the rediss:// scheme', () => {
    const parsed = parseRedisUrl('rediss://host:6380');
    expect(parsed.tls).toEqual({});
  });

  it('defaults port to 6379 when omitted', () => {
    expect(parseRedisUrl('redis://localhost').port).toBe(6379);
  });
});
