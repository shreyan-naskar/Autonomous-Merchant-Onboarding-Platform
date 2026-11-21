import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { merchantAccounts } from '../db/schema.js';

export interface MerchantService {
  /** Idempotent per application: asking again never issues a second ID. */
  createMerchant(applicationId: string, now: number): Promise<{ merchantId: string; created: boolean }>;
}

export interface SimulatedMerchantService extends MerchantService {
  /** Demo switch: every call fails while true. */
  fail: boolean;
  readonly calls: number;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

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

/** The ledger is merchant_accounts: a unique application_id is the idempotency key. */
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
