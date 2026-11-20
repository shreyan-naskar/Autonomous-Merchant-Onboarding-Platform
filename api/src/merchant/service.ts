import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { merchantAccounts } from '../db/schema.js';

/** The internal service that issues merchant IDs. */
export interface MerchantService {
  /**
   * Issue (or return the already-issued) merchant ID for an application.
   * Idempotent per application: calling it again never creates a second ID.
   * Rejects when the service is unavailable.
   */
  createMerchant(applicationId: string, now: number): Promise<{ merchantId: string; created: boolean }>;
}

export interface SimulatedMerchantService extends MerchantService {
  /** When true every call fails, simulating an outage. Settable at runtime (POST /admin/merchant-service). */
  fail: boolean;
  /** Calls received (including failed ones), for tests and the demo. */
  readonly calls: number;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** `MID-` + 8 random uppercase alphanumerics. */
export function generateMerchantId(pick: (n: number) => number = randomInt): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[pick(ALPHABET.length)];
  return `MID-${s}`;
}

export class MerchantServiceUnavailableError extends Error {
  constructor() {
    super('Merchant ID service unavailable (simulated failure)');
    this.name = 'MerchantServiceUnavailableError';
  }
}

/**
 * Simulated internal merchant ID service. Its ledger is the
 * `merchant_accounts` table: the MID is the primary key (globally unique) and
 * `application_id` is unique, which is the idempotency key. A random ID that
 * collides with an existing one is regenerated.
 */
export function createSimulatedMerchantService(
  db: Db,
  { fail = false, generate = () => generateMerchantId() }: { fail?: boolean; generate?: () => string } = {},
): SimulatedMerchantService {
  let calls = 0;
  const existing = (applicationId: string) =>
    db.select().from(merchantAccounts).where(eq(merchantAccounts.applicationId, applicationId)).get();

  const service: SimulatedMerchantService = {
    fail,
    get calls() {
      return calls;
    },
    async createMerchant(applicationId, now) {
      calls++;
      if (service.fail) throw new MerchantServiceUnavailableError();
      for (let i = 0; i < 20; i++) {
        const prior = existing(applicationId);
        if (prior) return { merchantId: prior.merchantId, created: false };
        const inserted = db
          .insert(merchantAccounts)
          .values({ merchantId: generate(), applicationId, createdAt: now })
          .onConflictDoNothing()
          .returning()
          .get();
        if (inserted) return { merchantId: inserted.merchantId, created: true };
        // Conflict: either a concurrent call issued one for this application
        // (the next loop returns it) or the random ID collided (regenerate).
      }
      throw new Error('Could not generate a unique merchant ID');
    },
  };
  return service;
}
