import { ArrowRight } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button, Card, ErrorAlert, PageHeader } from '../components/ui.tsx'
import { SCENARIOS as C } from '../copy.ts'
import { SCENARIOS, useApplyScenario, type Scenario } from '../lib/scenarios.ts'

/** Router state the Submit page reads to pre-fill the form. */
export interface ScenarioRouteState {
  scenario: string
}

export function Scenarios() {
  const navigate = useNavigate()
  const apply = useApplyScenario()

  const start = (s: Scenario) =>
    apply.mutate(s, {
      // No toast: the Submit page shows the scenario, and the amber banner any switch that is on.
      onSuccess: () => {
        navigate('/submit', { state: { scenario: s.id } satisfies ScenarioRouteState })
      },
    })

  return (
    <>
      <PageHeader title={C.title} subtitle={C.subtitle} />
      {apply.error && (
        <div className="mb-4">
          <ErrorAlert error={apply.error} title={C.switchesError} />
        </div>
      )}
      <ul className="grid gap-4 lg:grid-cols-2">
        {SCENARIOS.map((s, i) => {
          const meta = C.meta[s.id]
          return (
            <li key={s.id}>
              <Card className="h-full">
                <article className="flex h-full flex-col gap-4" aria-labelledby={`scenario-${s.id}`}>
                  <h2 id={`scenario-${s.id}`} className="flex gap-2.5 text-sm font-semibold text-accent-700">
                    <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-50 text-2xs font-bold text-accent-800">{i + 1}</span>
                    <span className="pt-0.5">{s.caption}</span>
                  </h2>
                  {meta && (
                    <dl className="space-y-2 text-sm">
                      <div>
                        <dt className="text-2xs font-semibold tracking-wide text-neutral-500 uppercase">{C.setup}</dt>
                        <dd className="mt-0.5 text-neutral-800">{meta.setup}</dd>
                      </div>
                      <div>
                        <dt className="text-2xs font-semibold tracking-wide text-neutral-500 uppercase">{C.outcome}</dt>
                        <dd className="mt-0.5 text-neutral-800">{meta.outcome}</dd>
                      </div>
                    </dl>
                  )}
                  <div className="mt-auto flex justify-end">
                    <Button
                      size="sm"
                      variant="primary"
                      icon={ArrowRight}
                      loading={apply.isPending && apply.variables?.id === s.id}
                      disabled={apply.isPending}
                      onClick={() => start(s)}
                      aria-label={C.startLabel(s.caption)}
                    >
                      {C.start}
                    </Button>
                  </div>
                </article>
              </Card>
            </li>
          )
        })}
      </ul>
    </>
  )
}
