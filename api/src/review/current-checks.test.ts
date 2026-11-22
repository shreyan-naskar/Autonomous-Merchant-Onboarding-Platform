import { ReviewQueueDtoSchema } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTask, startE2E, type E2E } from '../e2e.js';
import { sample } from '../testing.js';

/* The review queue carries each check's status now, next to the note written when the task opened. */

let e: E2E;
beforeEach(async () => {
  e = await startE2E();
});
afterEach(() => e.close());

const queue = async () => ReviewQueueDtoSchema.parse((await e.api().get('/review-tasks?status=OPEN')).body).items;

describe('GET /review-tasks: current_checks', () => {
  it('follows the verification rows after the task opened; the stored note does not change', async () => {
    const id = await e.submit(sample('gst-fail.json'));
    await e.drain();
    await e.deliver();
    await e.drain();

    const [item] = await queue();
    expect(item).toMatchObject({ application_id: id, reason: 'PAN_OK_GST_FAILED' });
    expect(item!.current_checks).toEqual([
      { kind: 'PAN', status: 'PASSED' },
      { kind: 'GST', status: 'FAILED' },
      { kind: 'BANK', status: 'PASSED' },
      { kind: 'RISK', status: 'PASSED' },
    ]);
    const d = await e.detail(id);
    expect(item!.note).toBe(openTask(d, 'PAN_OK_GST_FAILED')!.note);
    // The note was written when GST failed, before BANK and RISK answered; current_checks has them passed.
    expect(item!.note).toContain('BANK: pending');
    expect(item!.note).toContain('RISK: pending');
  });

  it('is null for checks never requested (a document task stops before verification)', async () => {
    await e.submit(sample('conflict.json'));
    await e.drain();
    const [item] = await queue();
    expect(item!.reason).toBe('DOC_CONFLICT');
    expect(item!.current_checks.every((c) => c.status === null)).toBe(true);
  });
});
