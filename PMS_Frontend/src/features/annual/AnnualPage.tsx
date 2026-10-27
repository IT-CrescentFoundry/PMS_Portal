import { Calculator, Settings2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { SelectField, TextField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { buttonClasses, cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import {
        calculateAnnual,
        listAnnualCycles,
        listAnnualRows,
        setAnnualRule,
} from '../../services/annualApi'
import type { AnnualCycle, AnnualRow } from '../../types/api'
import { plural } from '../../utils/format'
import { unitLabel } from '../../utils/labels'
import { parseId, withParams } from '../../utils/params'
import { scoreText } from '../scores/scoreLabels'
import { ruleText, standing } from './annualLabels'

/** /annual */
export function AnnualPage() {
        const [params, setParams] = useSearchParams()
        const cycles = useApiQuery('annual-cycles', (signal) => listAnnualCycles(signal))
        const header = (
                <PageHeader
                        title="Annual performance"
                        description="Annual scores calculated from the four published quarterly employee results. A missing or unpublished quarter is never counted as zero; the CHRO approves each annual result, and adjustments are requested as deviations."
                        actions={
                                <Link
                                        to="/annual/deviations"
                                        className={buttonClasses('secondary', 'sm')}
                                >
                                        Annual deviations
                                </Link>
                        }
                />
        )
        if (cycles.isLoading)
                return (
                        <>
                                {header}
                                <LoadingState label="Loading PMS cycles…" />
                        </>
                )
        if (cycles.error !== undefined || !cycles.data)
                return (
                        <>
                                {header}
                                <ErrorState error={cycles.error} onRetry={cycles.reload} />
                        </>
                )
        if (cycles.data.length === 0)
                return (
                        <>
                                {header}
                                <EmptyState title="No PMS cycle has been set up yet" />
                        </>
                )
        const chosen = parseId(params.get('cycle'))
        const cycle = cycles.data.find((c) => c.id === chosen) ?? cycles.data[0]
        return (
                <>
                        {header}
                        <CycleView
                                key={cycle.id}
                                cycles={cycles.data}
                                cycle={cycle}
                                onCycle={(id) =>
                                        setParams(withParams(params, { cycle: id }), {
                                                replace: true,
                                        })
                                }
                                onRuleChanged={cycles.reload}
                        />
                </>
        )
}

function CycleView({
        cycles,
        cycle,
        onCycle,
        onRuleChanged,
}: {
        cycles: AnnualCycle[]
        cycle: AnnualCycle
        onCycle: (id: number) => void
        onRuleChanged: () => void
}) {
        const [search, setSearch] = useState('')
        const rows = useApiQuery(`annual-rows|${cycle.id}|${search}`, (signal) =>
                listAnnualRows({ cycleId: cycle.id, search: search || undefined }, signal),
        )
        const action = useAction()
        const [message, setMessage] = useState<string | null>(null)
        const [editingRule, setEditingRule] = useState(false)
        const canCalculate = rows.data?.some((r) => r.actions.can_calculate) ?? false

        async function handleCalculate() {
                setMessage(null)
                const counts = await action.run(() => calculateAnnual(cycle.id))
                if (counts) {
                        setMessage(
                                `${plural(counts.calculated, 'annual result')} calculated · ${counts.unchanged} unchanged · ${counts.incomplete} waiting for quarters`,
                        )
                        rows.reload()
                }
        }

        return (
                <div className="space-y-4">
                        <div
                                className={`${cardClasses} grid gap-4 p-4 md:grid-cols-[minmax(0,20rem)_1fr]`}
                        >
                                <SelectField
                                        label="PMS cycle"
                                        value={String(cycle.id)}
                                        onChange={(e) => onCycle(Number(e.target.value))}
                                        options={cycles.map((c) => ({
                                                value: String(c.id),
                                                label: c.name,
                                        }))}
                                />
                                <div className="space-y-1 text-sm">
                                        <p className="font-medium text-slate-800">Annual rule</p>
                                        <p className="text-slate-700">
                                                Weighted average of the published quarterly scores:{' '}
                                                {ruleText(cycle.rule)}, rounded half up to{' '}
                                                {cycle.rule.decimals} decimals.
                                        </p>
                                        <p className="text-xs text-slate-600">
                                                Rule version {cycle.rule.version}.{' '}
                                                {cycle.rule.description}
                                        </p>
                                        {cycle.can_set_rule && !editingRule && (
                                                <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={() => setEditingRule(true)}
                                                >
                                                        <Settings2
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        Change the quarter weights…
                                                </Button>
                                        )}
                                </div>
                        </div>
                        {editingRule && (
                                <RuleEditor
                                        cycle={cycle}
                                        onCancel={() => setEditingRule(false)}
                                        onSaved={() => {
                                                setEditingRule(false)
                                                onRuleChanged()
                                                rows.reload()
                                        }}
                                />
                        )}
                        {message && <Alert title={message} />}
                        <ActionError
                                error={action.error}
                                title="The annual results were not calculated"
                        />
                        <div className="flex flex-wrap items-end gap-3">
                                <div className="w-full max-w-xs">
                                        <TextField
                                                label="Search employees"
                                                type="search"
                                                value={search}
                                                onChange={(e) => setSearch(e.target.value)}
                                        />
                                </div>
                                {canCalculate && (
                                        <Button
                                                variant="primary"
                                                isLoading={action.busy}
                                                onClick={handleCalculate}
                                        >
                                                <Calculator aria-hidden="true" className="size-4" />
                                                Calculate annual results
                                        </Button>
                                )}
                        </div>
                        {rows.isLoading && !rows.data ? (
                                <LoadingState label="Loading annual results…" />
                        ) : rows.error !== undefined || !rows.data ? (
                                <ErrorState error={rows.error} onRetry={rows.reload} />
                        ) : rows.data.length === 0 ? (
                                <EmptyState title="No employees with results in this cycle">
                                        Employees appear once they have a scored KPI sheet in one of
                                        the cycle's quarters.
                                </EmptyState>
                        ) : (
                                <AnnualTable cycle={cycle} rows={rows.data} />
                        )}
                </div>
        )
}

function AnnualTable({ cycle, rows }: { cycle: AnnualCycle; rows: AnnualRow[] }) {
        const numbers = cycle.quarters.map((q) => q.quarter_number)
        return (
                <Table caption={`Annual results for ${cycle.name}`}>
                        <thead>
                                <tr>
                                        <Th>Employee</Th>
                                        {numbers.map((n) => (
                                                <Th key={n} align="right">
                                                        Q{n}
                                                </Th>
                                        ))}
                                        <Th align="right">Calculated</Th>
                                        <Th align="right">Adjusted</Th>
                                        <Th align="right">Final</Th>
                                        <Th>Status</Th>
                                </tr>
                        </thead>
                        <TBody>
                                {rows.map((row) => {
                                        const current = row.draft ?? row.published
                                        const s = standing(row)
                                        return (
                                                <tr key={row.employee.id}>
                                                        <Td>
                                                                <Link
                                                                        to={`/annual/cycles/${cycle.id}/employees/${row.employee.id}`}
                                                                        className={linkClasses}
                                                                >
                                                                        {row.employee.full_name}
                                                                </Link>
                                                                <div className="text-xs text-slate-600">
                                                                        {row.employee.employee_code}
                                                                        {row.home_plant &&
                                                                        row.home_department
                                                                                ? ` · ${unitLabel(row.home_department, row.home_plant)}`
                                                                                : ''}
                                                                </div>
                                                        </Td>
                                                        {numbers.map((n) => {
                                                                const q = row.quarters.find(
                                                                        (x) =>
                                                                                x.quarter_number ===
                                                                                n,
                                                                )
                                                                return (
                                                                        <Td key={n} align="right">
                                                                                {q?.score !=
                                                                                null ? (
                                                                                        scoreText(
                                                                                                q.score,
                                                                                        )
                                                                                ) : (
                                                                                        <span className="text-xs text-slate-600">
                                                                                                Not
                                                                                                published
                                                                                        </span>
                                                                                )}
                                                                                {q &&
                                                                                        q
                                                                                                .correction_ids
                                                                                                .length >
                                                                                                0 && (
                                                                                                <div className="text-xs text-amber-900">
                                                                                                        Being
                                                                                                        corrected
                                                                                                </div>
                                                                                        )}
                                                                        </Td>
                                                                )
                                                        })}
                                                        <Td align="right">
                                                                {current
                                                                        ? scoreText(
                                                                                  current.calculated_score,
                                                                          )
                                                                        : '—'}
                                                        </Td>
                                                        <Td align="right">
                                                                {current?.adjusted_score
                                                                        ? scoreText(
                                                                                  current.adjusted_score,
                                                                          )
                                                                        : '—'}
                                                        </Td>
                                                        <Td align="right">
                                                                <span className="font-semibold">
                                                                        {current
                                                                                ? scoreText(
                                                                                          current.final_score,
                                                                                  )
                                                                                : '—'}
                                                                </span>
                                                        </Td>
                                                        <Td>
                                                                <Badge tone={s.tone}>
                                                                        {s.label}
                                                                </Badge>
                                                                {row.pending_deviation && (
                                                                        <div className="mt-1 text-xs text-amber-900">
                                                                                Deviation pending
                                                                        </div>
                                                                )}
                                                        </Td>
                                                </tr>
                                        )
                                })}
                        </TBody>
                </Table>
        )
}

function RuleEditor({
        cycle,
        onCancel,
        onSaved,
}: {
        cycle: AnnualCycle
        onCancel: () => void
        onSaved: () => void
}) {
        const numbers = cycle.quarters.map((q) => q.quarter_number)
        const [weights, setWeights] = useState<Record<number, string>>(() =>
                Object.fromEntries(
                        numbers.map((n) => [n, cycle.rule.quarter_weights[String(n)] ?? '0']),
                ),
        )
        const action = useAction()
        const hundredths = Object.values(weights).map((w) =>
                /^\d{1,3}(\.\d{1,2})?$/.test(w.trim()) ? Math.round(Number(w) * 100) : NaN,
        )
        const total = hundredths.every(Number.isFinite)
                ? hundredths.reduce((a, b) => a + b, 0) / 100
                : null

        async function handleSubmit(event: FormEvent) {
                event.preventDefault()
                const saved = await action.run(() =>
                        setAnnualRule(
                                cycle.id,
                                numbers.map((n) => ({
                                        quarter_number: n,
                                        weight: weights[n].trim(),
                                })),
                        ),
                )
                if (saved) onSaved()
        }

        return (
                <form
                        onSubmit={handleSubmit}
                        aria-labelledby="rule-heading"
                        className={`${cardClasses} space-y-3 p-4`}
                >
                        <h2 id="rule-heading" className="text-base font-semibold text-slate-900">
                                Quarter weights of the annual score
                        </h2>
                        <p className="text-sm text-slate-700">
                                Each quarter's share of the annual score; they must total exactly
                                100 %. A quarter weighted 0 is not required. The rule can change
                                only until an annual result of the cycle is approved, and every
                                result keeps the rule it used.
                        </p>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                                {numbers.map((n) => (
                                        <TextField
                                                key={n}
                                                label={`Weight % of Q${n}`}
                                                inputMode="decimal"
                                                value={weights[n]}
                                                onChange={(e) =>
                                                        setWeights({
                                                                ...weights,
                                                                [n]: e.target.value,
                                                        })
                                                }
                                        />
                                ))}
                        </div>
                        <p aria-live="polite" className="text-sm font-medium text-slate-800">
                                {total === null
                                        ? 'Enter each weight with at most two decimals.'
                                        : `Total ${total.toFixed(2)} %`}
                        </p>
                        <ActionError error={action.error} title="The rule was not changed" />
                        <div className="flex flex-wrap gap-2">
                                <Button
                                        type="submit"
                                        variant="primary"
                                        isLoading={action.busy}
                                        disabled={total !== 100}
                                >
                                        Save the rule
                                </Button>
                                <Button variant="ghost" onClick={onCancel}>
                                        Cancel
                                </Button>
                        </div>
                </form>
        )
}
