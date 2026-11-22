import { DOCUMENT_LABELS, VALIDATION_LABELS, type ApplicationDetailDto } from '@app/shared'
import { Eye, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { fieldName } from '../lib/fields.ts'
import { SEVERITY_ICON, toneOf } from '../lib/status.ts'
import { Badge, Button, Dialog } from './ui.tsx'
import { cx } from '../lib/tone.ts'
import { DOCUMENTS, VIEWER as C } from '../copy.ts'

type Doc = ApplicationDetailDto['documents'][number]

const documentFileUrl = (applicationId: string, documentId: number) => `/api/applications/${applicationId}/documents/${documentId}/file`

const IMAGE = /\.(png|jpe?g|webp)$/i
const PDF = /\.pdf$/i

/** The uploaded file next to what was read from it, so a reviewer can compare the two. */
function DocumentViewer({ app, doc, onClose }: { app: ApplicationDetailDto; doc: Doc; onClose: () => void }) {
  const url = documentFileUrl(app.id, doc.id)
  const name = doc.file_name ?? ''
  const label = DOCUMENT_LABELS[doc.type]
  const fields = app.extracted_fields.filter((f) => f.document_id === doc.id)
  return (
    <Dialog
      open
      size="xl"
      onClose={onClose}
      title={label}
      description={C.uploaded(PDF.test(name) ? C.pdf : C.image(name.split('.').pop()?.toUpperCase() ?? ''))}
      footer={
        <>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-control border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
          >
            <ExternalLink aria-hidden className="size-4" />
            {C.openTab}
          </a>
          <Button variant="primary" onClick={onClose}>
            {C.close}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-[1fr_240px]">
        <div className="flex min-h-64 items-center justify-center overflow-hidden rounded-control bg-neutral-100 ring-1 ring-neutral-200">
          {IMAGE.test(name) ? (
            <img src={url} alt={C.preview(label)} className="max-h-[65vh] w-full object-contain" />
          ) : PDF.test(name) ? (
            <iframe src={url} title={`${label} (PDF)`} className="h-[65vh] w-full bg-white" />
          ) : (
            <p className="p-6 text-center text-sm text-neutral-600">{C.noPreview}</p>
          )}
        </div>
        <div>
          <h3 className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">{C.read}</h3>
          {fields.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-500">{C.nothing}</p>
          ) : (
            <dl className="mt-2 space-y-3">
              {fields.map((f) => {
                const v = VALIDATION_LABELS[f.validation_status]
                return (
                  <div key={f.id}>
                    <dt className="text-xs text-neutral-500">{fieldName(f.field)}</dt>
                    <dd className={cx('mt-0.5 text-sm', /name|holder/.test(f.field) ? 'text-neutral-900' : 'font-mono', f.value?.includes('*') ? 'text-neutral-500' : 'text-neutral-900')}>{f.value ?? <span className="text-neutral-500">{C.notRead}</span>}</dd>
                    <dd className="mt-1 flex items-center gap-2">
                      <Badge tone={toneOf(v.severity)} icon={SEVERITY_ICON[v.severity]}>
                        {v.label}
                      </Badge>
                      <span className="tabular text-2xs text-neutral-500">{C.confidence(Math.round(f.confidence * 100))}</span>
                    </dd>
                  </div>
                )
              })}
            </dl>
          )}
          <p className="mt-4 text-2xs text-neutral-500">{C.footnote}</p>
        </div>
      </div>
    </Dialog>
  )
}

export function ViewDocumentButton({ app, doc, size = 'sm', children }: { app: ApplicationDetailDto; doc: Doc; size?: 'sm' | 'md'; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  if (doc.file_name === null) return null
  return (
    <>
      <Button size={size} icon={Eye} onClick={() => setOpen(true)}>
        {children ?? DOCUMENTS.view}
      </Button>
      {open && <DocumentViewer app={app} doc={doc} onClose={() => setOpen(false)} />}
    </>
  )
}
