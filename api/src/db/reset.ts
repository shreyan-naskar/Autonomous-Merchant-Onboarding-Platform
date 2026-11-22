import type { Db } from './client.js';
import { applications, auditLog, callbackEvents, documents, extractedFields, jobs, merchantAccounts, reviewTasks, verifications } from './schema.js';

/** Delete every row, children before parents, in one transaction. Returns row counts per table. Demo / tests only. */
export function resetAllData(db: Db): Record<string, number> {
  const tables = {
    callback_events: callbackEvents,
    audit_log: auditLog,
    review_tasks: reviewTasks,
    extracted_fields: extractedFields,
    verifications,
    documents,
    merchant_accounts: merchantAccounts,
    jobs,
    applications,
  };
  return db.transaction(
    (tx) => Object.fromEntries(Object.entries(tables).map(([name, t]) => [name, tx.delete(t).run().changes])),
    { behavior: 'immediate' },
  );
}
