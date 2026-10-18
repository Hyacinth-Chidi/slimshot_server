import { createRedisClient } from './redis-client';

describe('createRedisClient', () => {
  it('fails a command quickly when Redis cannot be reached, instead of waiting for it forever', async () => {
    // Port 1 on localhost refuses at once: an outage without any network.
    const client = createRedisClient('redis://127.0.0.1:1');
    client.on('error', () => undefined);
    try {
      const started = Date.now();
      await expect(client.get('anything')).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      client.disconnect();
    }
  }, 6_000);
});
