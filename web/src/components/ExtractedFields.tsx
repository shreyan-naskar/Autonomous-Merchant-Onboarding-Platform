import type { ApplicationDetailDto, ValidationStatus } from '@app/shared'

const CHIP: Record<ValidationStatus, string> = {
  ok: 'bg-green-100 text-green-800',
  mismatch: 'bg-red-100 text-red-800',
  missing: 'bg-amber-100 text-amber-800',
  low_confidence: 'bg-orange-100 text-orange-800',
}

export function ExtractedFields({ fields }: { fields: ApplicationDetailDto['extracted_fields'] }) {
  if (fields.length === 0) return <p className="text-sm text-slate-500">Nothing extracted yet.</p>
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-xs uppercase text-slate-500">
        <tr>
          <th className="py-1">Field</th>
          <th>Value</th>
          <th className="w-40">Confidence</th>
          <th>Validation</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => {
          const pct = Math.round(f.confidence * 100)
          const bar = f.confidence >= 0.8 ? 'bg-green-500' : f.confidence >= 0.5 ? 'bg-amber-500' : 'bg-red-500'
          return (
            <tr key={f.id} className="border-t border-slate-100">
              <td className="py-1 font-mono text-xs">{f.field}</td>
              <td className="font-mono text-xs">{f.value ?? <span className="text-slate-400">—</span>}</td>
              <td>
                <div className="flex items-center gap-2">
                  <div className="h-2 w-24 rounded bg-slate-100" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                    <div className={`h-2 rounded ${bar}`} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs tabular-nums text-slate-600">{pct}%</span>
                </div>
              </td>
              <td>
                <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${CHIP[f.validation_status]}`}>{f.validation_status}</span>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
