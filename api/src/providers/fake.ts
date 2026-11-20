import type { ProviderRequest, VerificationKind } from '@app/shared';
import { ProviderRequestError, type ProviderClient } from './client.js';

export interface FakeCall {
  kind: VerificationKind;
  body: ProviderRequest;
  request_id: string;
}

export interface FakeProviderClient extends ProviderClient {
  /** Accepted requests, in order. */
  readonly calls: FakeCall[];
  /** Kinds whose requests currently reject (provider unreachable). */
  readonly failing: Set<VerificationKind>;
  /** The latest accepted call for a kind. */
  last(kind: VerificationKind): FakeCall | undefined;
}

/**
 * In-memory ProviderClient for unit tests: accepts every request with a
 * predictable request_id and never calls back (tests post callbacks
 * themselves). Add a kind to `failing` to simulate an unreachable provider.
 */
export function createFakeProviderClient(): FakeProviderClient {
  const calls: FakeCall[] = [];
  const failing = new Set<VerificationKind>();
  let seq = 0;
  return {
    calls,
    failing,
    last: (kind) => calls.filter((c) => c.kind === kind).at(-1),
    async request(kind, body) {
      if (failing.has(kind)) throw new ProviderRequestError(kind, 'fake provider unavailable', 503);
      const request_id = `fake-${kind.toLowerCase()}-${++seq}`;
      calls.push({ kind, body, request_id });
      return { request_id };
    },
  };
}
