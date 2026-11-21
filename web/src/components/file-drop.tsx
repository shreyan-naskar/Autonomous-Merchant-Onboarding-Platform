import { FileText, UploadCloud, X } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type DragEvent } from 'react'
import { cx } from '../lib/tone.ts'

const ACCEPT = 'application/pdf,image/png,image/jpeg'
const MAX_BYTES = 5 * 1024 * 1024
const ALLOWED = ['application/pdf', 'image/png', 'image/jpeg']

const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** A real file input underneath, so it stays keyboard and screen-reader friendly. */
export function FileDrop({
  label,
  hint,
  file,
  onChange,
  error,
}: {
  label: string
  hint?: string
  file?: File
  onChange: (file: File | undefined) => void
  error?: string
}) {
  const id = useId()
  const [over, setOver] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const preview = useMemo(() => (file && file.type.startsWith('image/') ? URL.createObjectURL(file) : null), [file])
  useEffect(() => () => (preview ? URL.revokeObjectURL(preview) : undefined), [preview])

  const accept = (f: File | undefined) => {
    if (!f) return
    if (!ALLOWED.includes(f.type)) {
      setLocalError('Only PDF, PNG or JPEG files')
      return
    }
    if (f.size > MAX_BYTES) {
      setLocalError('Files must be 5 MB or smaller')
      return
    }
    setLocalError(null)
    onChange(f)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    accept(e.dataTransfer.files?.[0])
  }
  const shownError = localError ?? error

  return (
    <div className="space-y-1">
      <span id={`${id}-label`} className="block text-xs font-medium text-neutral-700">
        {label}
      </span>
      {file ? (
        <div className="flex items-center gap-3 rounded-control border border-neutral-300 bg-white p-2">
          {preview ? (
            <img src={preview} alt={`Preview of ${file.name}`} className="size-12 rounded object-cover ring-1 ring-neutral-200" />
          ) : (
            <span className="flex size-12 items-center justify-center rounded bg-neutral-100 text-neutral-500">
              <FileText aria-hidden className="size-5" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-neutral-900">{file.name}</div>
            <div className="text-xs text-neutral-500">{size(file.size)}</div>
          </div>
          <button type="button" onClick={() => onChange(undefined)} className="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800" aria-label={`Remove ${file.name}`}>
            <X aria-hidden className="size-4" />
          </button>
        </div>
      ) : (
        <label
          htmlFor={id}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          className={cx(
            'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-control border border-dashed px-3 py-4 text-center transition-colors',
            'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent-600',
            over ? 'border-accent-600 bg-accent-50' : shownError ? 'border-danger-500 bg-white' : 'border-neutral-300 bg-white hover:border-neutral-400',
          )}
        >
          <UploadCloud aria-hidden className="size-5 text-neutral-400" />
          <span className="text-sm text-neutral-700">
            <span className="font-medium text-accent-800">Choose a file</span> or drag it here
          </span>
          <input
            id={id}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-hint`}
            onChange={(e) => {
              accept(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </label>
      )}
      <p id={`${id}-hint`} className={cx('text-xs', shownError ? 'text-danger-700' : 'text-neutral-500')}>
        {shownError ?? hint}
      </p>
    </div>
  )
}
