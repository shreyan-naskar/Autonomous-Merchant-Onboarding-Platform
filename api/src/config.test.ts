import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('provides sane defaults with an empty env', () => {
    const c = loadConfig({});
    expect(c.port).toBe(3000);
    expect(c.dbPath).toBe('./data/app.db');
    expect(c.mockProviderUrl).toBe('http://localhost:4000');
    expect(c.webhookUrl).toBe('http://localhost:3000/webhooks/provider');
    expect(c.hmacSecret.length).toBeGreaterThan(0);
    expect(c.demoMode).toBe(true);
    expect(c.thresholds).toEqual({ confidence: 0.8, risk: 70 });
  });

  it('uses short timings in demo mode and longer ones otherwise', () => {
    const demo = loadConfig({ DEMO_MODE: 'true' });
    expect(demo.timings.verificationTimeoutMs).toBe(30_000);
    expect(demo.timings.backoffBaseMs).toBe(1_000);

    const prod = loadConfig({ DEMO_MODE: 'false' });
    expect(prod.timings.verificationTimeoutMs).toBeGreaterThan(demo.timings.verificationTimeoutMs);
    expect(prod.timings.backoffBaseMs).toBeGreaterThan(demo.timings.backoffBaseMs);
  });

  it('reads explicit values and coerces types', () => {
    const c = loadConfig({
      PORT: '3100',
      DB_PATH: ':memory:',
      WEBHOOK_URL: 'http://api:3000/webhooks/provider',
      MOCK_PROVIDER_URL: 'http://mock:4000',
      HMAC_SECRET: 's3cret',
      CONFIDENCE_THRESHOLD: '0.9',
      RISK_THRESHOLD: '60',
    });
    expect(c).toMatchObject({
      port: 3100,
      dbPath: ':memory:',
      webhookUrl: 'http://api:3000/webhooks/provider',
      mockProviderUrl: 'http://mock:4000',
      hmacSecret: 's3cret',
      thresholds: { confidence: 0.9, risk: 60 },
    });
  });

  it('accepts the legacy .env names as aliases', () => {
    const c = loadConfig({
      API_PORT: '3200',
      PROVIDER_BASE_URL: 'http://legacy:4000',
      WEBHOOK_SECRET: 'legacy-secret',
    });
    expect(c.port).toBe(3200);
    expect(c.mockProviderUrl).toBe('http://legacy:4000');
    expect(c.hmacSecret).toBe('legacy-secret');
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow();
    expect(() => loadConfig({ CONFIDENCE_THRESHOLD: '1.5' })).toThrow();
    expect(() => loadConfig({ MOCK_PROVIDER_URL: 'not a url' })).toThrow();
    expect(() => loadConfig({ DEMO_MODE: 'maybe' })).toThrow();
  });
});
