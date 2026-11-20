import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createMockApp } from './app.js';

describe('mock providers app', () => {
  it('starts in-process on a random port and serves /health', async () => {
    const server = createMockApp().listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok', service: 'mock-providers' });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
