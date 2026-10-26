import { Check } from 'lucide-react'
import { Badge } from '../../components/common/Badge'
import { SelectField } from '../../components/common/Fields'
import type { NormalizationRunStatus, Quarter, QuarterStatus } from '../../types/api'
import { quarterLabel } from '../kpi/kpiLabels'
import { COHORT_STATUS, PHASES } from './quarterLabels'

/** Where the quarter is in its review steps. */
export function PhaseStepper({ status }: { status: QuarterStatus }) {
        const current = PHASES.findIndex((p) => p.status === status)
        return (
                <ol
                        aria-label="Quarter steps"
                        className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
                >
                        {PHASES.map((phase, index) => {
                                const done = current > index || status === 'PUBLISHED'
                                const here = index === current
                                return (
                                        <li
                                                key={phase.status}
                                                aria-current={here ? 'step' : undefined}
                                                className={`rounded-md border p-2 text-sm ${here ? 'border-brand-500 bg-brand-50' : done ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-white'}`}
                                        >
                                                <span className="flex items-center gap-1 font-semibold text-slate-900">
                                                        {done && (
                                                                <Check
                                                                        aria-hidden="true"
                                                                        className="size-4 text-emerald-700"
                                                                />
                                                        )}
                                                        {index + 1}. {phase.label}
                                                        {done && (
                                                                <span className="sr-only">
                                                                        {' '}
                                                                        (done)
                                                                </span>
                                                        )}
                                                </span>
                                                <span className="block text-xs text-slate-600">
                                                        {phase.detail}
                                                </span>
                                        </li>
                                )
                        })}
                </ol>
        )
}

export function CohortStatusBadge({ status }: { status: NormalizationRunStatus }) {
        const { label, tone } = COHORT_STATUS[status]
        return <Badge tone={tone}>{label}</Badge>
}

/** Quarter choice shared by the quarterly pages (the URL keeps it). */
export function QuarterSelect({
        quarters,
        quarter,
        onChange,
}: {
        quarters: Quarter[]
        quarter: Quarter
        onChange: (id: number) => void
}) {
        return (
                <SelectField
                        label="Quarter"
                        value={String(quarter.id)}
                        onChange={(e) => onChange(Number(e.target.value))}
                        options={quarters.map((q) => ({
                                value: String(q.id),
                                label: quarterLabel(q),
                        }))}
                />
        )
}
