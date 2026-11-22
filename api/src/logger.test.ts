import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: createLogger({ level: 'info', stream }) };
}

const PAN = 'ABCDE1234F';
const ACCT = '123456789012';

describe('logger redaction', () => {
  it('masks top-level and nested pan / bank_account fields', () => {
    const { lines, logger } = capture();
    logger.info(
      {
        pan: PAN,
        bank_account: ACCT,
        application: { pan: PAN, bank_account: ACCT },
        body: { documents: [{ type: 'PAN_CARD', payload: { pan: PAN } }] },
        callback: { payload: { result: { bank_account: ACCT } } },
      },
      'hello',
    );
    const out = lines.join('');
    expect(out).not.toContain(PAN);
    expect(out).not.toContain(ACCT);
    expect(out).toContain('234F');
    expect(out).toContain('9012');
  });

  it('scrubs raw values that slip into the message or error text', () => {
    const { lines, logger } = capture();
    logger.error({ err: new Error(`boom for ${PAN} / ${ACCT}`) }, `failed ${PAN}`);
    const out = lines.join('');
    expect(out).not.toContain(PAN);
    expect(out).not.toContain(ACCT);
  });

  it('masks gst / gstin (a GSTIN embeds the PAN)', () => {
    const { lines, logger } = capture();
    const GSTIN = `27${PAN}1Z5`;
    logger.info({ gst: GSTIN, body: { documents: [{ payload: { gstin: GSTIN } }] } }, 'gst');
    const out = lines.join('');
    expect(out).not.toContain(PAN);
    expect(out).toContain('F1Z5');
  });
});
