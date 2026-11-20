import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import {
  ApplicationStatusSchema,
  CreateApplicationJsonSchema,
  CreateApplicationMultipartFieldsSchema,
  DOCUMENT_TYPES,
  ListApplicationsQuerySchema,
  MAX_UPLOAD_BYTES,
  UPLOAD_MIME_TYPES,
  UpdateApplicationSchema,
  type ApplicationFields,
  type DocumentType,
  type UpdateApplication,
} from '@app/shared';
import { Router, type Request } from 'express';
import multer from 'multer';
import type { Db } from '../../db/client.js';
import { getApplicationDetail, listApplications } from '../../domain/queries.js';
import {
  submitApplication,
  updateApplication,
  type NewApplicationInput,
  type NewDocumentInput,
} from '../../domain/applications.js';
import { BadRequestError, NotFoundError } from '../../errors.js';
import type { Logger } from '../../logger.js';
import { toDetailDto, toSummaryDto } from '../dto.js';

export interface ApplicationsRouterDeps {
  db: Db;
  logger: Logger;
  uploadDir: string;
  now: () => number;
}

function toInput(f: ApplicationFields | UpdateApplication): Partial<NewApplicationInput> {
  return { merchantName: f.merchant_name, pan: f.pan, gst: f.gst, bankAccount: f.bank_account, ifsc: f.ifsc };
}

/** HTML forms send empty inputs as ""; treat those as absent. */
function dropEmpty(body: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body ?? {}).filter(([, v]) => v !== ''));
}

function uploadedFiles(req: Request): Express.Multer.File[] {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  return files ? Object.values(files).flat() : [];
}

export function applicationsRouter({ db, logger, uploadDir, now }: ApplicationsRouterDeps): Router {
  // Multipart only; multer passes JSON requests straight through. Files are
  // stored under a random name: the client's file name is never used on disk.
  const upload = multer({
    storage: multer.diskStorage({
      // Created on first upload rather than at startup.
      destination: (_req, _file, cb) => {
        mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
      },
      filename: (_req, file, cb) =>
        cb(null, `${randomUUID()}${UPLOAD_MIME_TYPES[file.mimetype as keyof typeof UPLOAD_MIME_TYPES] ?? ''}`),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: DOCUMENT_TYPES.length, fields: 20, fieldSize: 64 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype in UPLOAD_MIME_TYPES) cb(null, true);
      else cb(new BadRequestError(`Unsupported file type for ${file.fieldname}`, { allowed: Object.keys(UPLOAD_MIME_TYPES) }));
    },
  }).fields(DOCUMENT_TYPES.map((name) => ({ name, maxCount: 1 })));

  const router = Router();

  router.post('/', upload, async (req, res) => {
    const files = uploadedFiles(req);
    try {
      let fields: ApplicationFields;
      let docs: NewDocumentInput[];
      const via = req.is('multipart/form-data') ? 'multipart' : 'json';

      if (via === 'multipart') {
        const parsed = CreateApplicationMultipartFieldsSchema.parse(dropEmpty(req.body));
        const { documents: structured = [], ...rest } = parsed;
        fields = rest;
        docs = [
          ...structured.map((d) => ({ type: d.type, payload: d.payload })),
          ...files.map((f) => ({ type: f.fieldname as DocumentType, path: f.path })),
        ];
        const types = docs.map((d) => d.type);
        const dupes = types.filter((t, i) => types.indexOf(t) !== i);
        if (dupes.length) throw new BadRequestError('Each document type may appear at most once', { duplicates: dupes });
      } else {
        const parsed = CreateApplicationJsonSchema.parse(req.body);
        const { documents: structured, ...rest } = parsed;
        fields = rest;
        docs = structured.map((d) => ({ type: d.type, payload: d.payload }));
      }

      const app = submitApplication(db, toInput(fields) as NewApplicationInput, docs, { now: now(), via });
      logger.info(
        { application_id: app.id, via, document_types: docs.map((d) => d.type) },
        'application submitted',
      );
      const detail = getApplicationDetail(db, app.id)!;
      res.status(201).location(`/applications/${app.id}`).json(toDetailDto(detail, now()));
    } catch (err) {
      // Nothing references the saved files if intake failed; remove them.
      await Promise.all(files.map((f) => unlink(f.path).catch(() => undefined)));
      throw err;
    }
  });

  router.get('/', (req, res) => {
    const q = ListApplicationsQuerySchema.parse(req.query);
    const status = q.status === undefined ? undefined : ApplicationStatusSchema.parse(q.status);
    const t = now();
    const items = listApplications(db, { status, limit: q.limit }).map((row) => toSummaryDto(row, t));
    res.json({ items, count: items.length });
  });

  router.get('/:id', (req, res) => {
    const detail = getApplicationDetail(db, req.params.id);
    if (!detail) throw new NotFoundError('Application not found');
    res.json(toDetailDto(detail, now()));
  });

  router.patch('/:id', (req, res) => {
    const patch = UpdateApplicationSchema.parse(req.body);
    const app = updateApplication(db, req.params.id, toInput(patch), { now: now() });
    logger.info({ application_id: app.id, fields: Object.keys(patch) }, 'application updated');
    res.json(toDetailDto(getApplicationDetail(db, app.id)!, now()));
  });

  return router;
}
