import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { cardClasses, inputClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { getEmployeeResult, setContributionWeights } from '../../services/quarterlyApi'
import type { EmployeeResult } from '../../types/api'
import { unitLabel } from '../../utils/labels'
import { parseId } from '../../utils/params'
import { InvalidLink } from '../common/InvalidLink'
import { ResultStatusBadge } from '../scores/ScoreBadges'
import { scoreText } from '../scores/scoreLabels'
import { EMPLOYEE_STATUS, PLACEMENT_LABELS, WEIGHTS_SOURCE } from './quarterLabels'

/** /scores/quarters/:quarterId/employees/:employeeId */
export function EmployeeResultPage() {
        const params = useParams()
        const quarterId = parseId(params.quarterId)
        const employeeId = parseId(params.employeeId)
        const valid = quarterId !== undefined && employeeId !== undefined
        const query = useApiQuery(
                valid ? `employee-result|${quarterId}|${employeeId}` : null,
                (signal) => getEmployeeResult(quarterId!, employeeId!, signal),
        )
        if (!valid)
                return (
                        <InvalidLink
                                backTo="/scores/employees"
                                backLabel="Back to employee results"
                        />
                )
        if (query.isLoading) return <LoadingState label="Loading the employee result…" />
        if (query.error !== undefined || !query.data) {
                return (
                        <>
                                <PageHeader
                                        title="Employee result"
                                        breadcrumbs={[
                                                {
                                                        label: 'Employee results',
                                                        to: '/scores/employees',
                                                },
                                                { label: 'Result' },
                                        ]}
                                />
                                <ErrorState error={query.error} onRetry={query.reload} />
                        </>
                )
        }
        return <ResultView key={query.data.employee.id} initial={query.data} />
}

function ResultView({ initial }: { initial: EmployeeResult }) {
        const [result, setResult] = useState(initial)
        const status = EMPLOYEE_STATUS[result.status]
        const outcome = result.normalization
        return (
                <>
                        <PageHeader
                                title={result.employee.full_name}
                                description={`${result.employee.employee_code} · home unit ${result.home_plant && result.home_department ? unitLabel(result.home_department, result.home_plant) : 'not attributed'}`}
                                breadcrumbs={[
                                        {
                                                label: 'Employee results',
                                                to: `/scores/employees?quarter=${result.quarter_id}`,
                                        },
                                        { label: result.employee.full_name },
                                ]}
                                meta={<Badge tone={status.tone}>{status.label}</Badge>}
                        />
                        <div className="space-y-4">
                                {result.issues.length > 0 && (
                                        <Alert tone="warning" title="Not ready for normalization">
                                                <ul className="list-disc space-y-0.5 pl-5">
                                                        {result.issues.map((i) => (
                                                                <li key={i}>{i}</li>
                                                        ))}
                                                </ul>
                                        </Alert>
                                )}
                                <section
                                        aria-labelledby="score-heading"
                                        className={`${cardClasses} space-y-3 p-4`}
                                >
                                        <h2
                                                id="score-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Quarterly score
                                        </h2>
                                        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                                                <div>
                                                        <dt className="font-medium text-slate-700">
                                                                Final (2 decimals)
                                                        </dt>
                                                        <dd className="text-lg font-semibold tabular-nums">
                                                                {scoreText(result.final_score)}
                                                        </dd>
                                                </div>
                                                <div>
                                                        <dt className="font-medium text-slate-700">
                                                                Exact
                                                        </dt>
                                                        <dd className="text-lg font-semibold tabular-nums">
                                                                {result.calculated_score ?? '—'}
                                                        </dd>
                                                </div>
                                                <div className="col-span-2">
                                                        <dt className="font-medium text-slate-700">
                                                                How it is built
                                                        </dt>
                                                        <dd>
                                                                {WEIGHTS_SOURCE[
                                                                        result.weights_source
                                                                ] ?? result.weights_source}
                                                        </dd>
                                                </div>
                                        </dl>
                                        <Table caption="Scored assignments">
                                                <thead>
                                                        <tr>
                                                                <Th>Assignment</Th>
                                                                <Th>Result</Th>
                                                                <Th align="right">Score</Th>
                                                                <Th align="right">Weight</Th>
                                                                <Th align="right">Contribution</Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {result.components.map((c) => (
                                                                <tr key={c.assignment_id}>
                                                                        <Td>
                                                                                {c.can_open_sheet ? (
                                                                                        <Link
                                                                                                to={`/scores/results/${c.sheet_id}`}
                                                                                                className={
                                                                                                        linkClasses
                                                                                                }
                                                                                        >
                                                                                                {unitLabel(
                                                                                                        c.department,
                                                                                                        c.plant,
                                                                                                )}
                                                                                        </Link>
                                                                                ) : (
                                                                                        unitLabel(
                                                                                                c.department,
                                                                                                c.plant,
                                                                                        )
                                                                                )}
                                                                                {c.is_primary && (
                                                                                        <Badge
                                                                                                tone="brand"
                                                                                                className="ml-2"
                                                                                        >
                                                                                                Primary
                                                                                        </Badge>
                                                                                )}
                                                                                {c.problems.length >
                                                                                        0 && (
                                                                                        <div className="text-xs text-amber-900">
                                                                                                {c.problems.join(
                                                                                                        '; ',
                                                                                                )}
                                                                                        </div>
                                                                                )}
                                                                        </Td>
                                                                        <Td>
                                                                                <ResultStatusBadge
                                                                                        status={
                                                                                                c.result_status
                                                                                        }
                                                                                />
                                                                        </Td>
                                                                        <Td align="right">
                                                                                {scoreText(c.score)}
                                                                                {c.score_source ===
                                                                                        'override' && (
                                                                                        <div className="text-xs text-slate-600">
                                                                                                approved
                                                                                                override
                                                                                        </div>
                                                                                )}
                                                                        </Td>
                                                                        <Td align="right">
                                                                                {c.weight
                                                                                        ? `${c.weight}%`
                                                                                        : '—'}
                                                                        </Td>
                                                                        <Td align="right">
                                                                                {c.contribution ??
                                                                                        '—'}
                                                                        </Td>
                                                                </tr>
                                                        ))}
                                                </TBody>
                                        </Table>
                                </section>
                                {result.can_set_weights && (
                                        <WeightsEditor result={result} onSaved={setResult} />
                                )}
                                {outcome && (
                                        <section
                                                aria-labelledby="norm-heading"
                                                className={`${cardClasses} space-y-2 p-4`}
                                        >
                                                <h2
                                                        id="norm-heading"
                                                        className="text-base font-semibold text-slate-900"
                                                >
                                                        Normalization
                                                </h2>
                                                <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                                                        <div>
                                                                <dt className="font-medium text-slate-700">
                                                                        Cohort
                                                                </dt>
                                                                <dd>
                                                                        <Link
                                                                                to={`/scores/normalization/${outcome.run_id}`}
                                                                                className={
                                                                                        linkClasses
                                                                                }
                                                                        >
                                                                                {
                                                                                        outcome.cohort_label
                                                                                }
                                                                        </Link>
                                                                </dd>
                                                        </div>
                                                        <div>
                                                                <dt className="font-medium text-slate-700">
                                                                        Rank
                                                                </dt>
                                                                <dd>{outcome.rank ?? '—'}</dd>
                                                        </div>
                                                        <div>
                                                                <dt className="font-medium text-slate-700">
                                                                        Group
                                                                </dt>
                                                                <dd>
                                                                        {outcome.group_label ??
                                                                                'Not placed yet'}
                                                                        {outcome.placement && (
                                                                                <div className="text-xs text-slate-600">
                                                                                        {
                                                                                                PLACEMENT_LABELS[
                                                                                                        outcome
                                                                                                                .placement
                                                                                                ]
                                                                                        }
                                                                                        {outcome.placed_by &&
                                                                                                ` by ${outcome.placed_by.username}`}
                                                                                </div>
                                                                        )}
                                                                        {outcome.placement_reason && (
                                                                                <div className="text-xs text-slate-600">
                                                                                        “
                                                                                        {
                                                                                                outcome.placement_reason
                                                                                        }
                                                                                        ”
                                                                                </div>
                                                                        )}
                                                                </dd>
                                                        </div>
                                                        <div>
                                                                <dt className="font-medium text-slate-700">
                                                                        Normalized rating
                                                                </dt>
                                                                <dd>
                                                                        {outcome.normalized_rating ??
                                                                                '—'}
                                                                </dd>
                                                        </div>
                                                </dl>
                                        </section>
                                )}
                        </div>
                </>
        )
}

function WeightsEditor({
        result,
        onSaved,
}: {
        result: EmployeeResult
        onSaved: (r: EmployeeResult) => void
}) {
        const [weights, setWeights] = useState<Record<number, string>>(() =>
                Object.fromEntries(result.components.map((c) => [c.assignment_id, c.weight ?? ''])),
        )
        const [saved, setSaved] = useState(false)
        const action = useAction()
        const hundredths = Object.values(weights).map((w) =>
                /^\d{1,3}(\.\d{1,2})?$/.test(w.trim()) ? Math.round(Number(w) * 100) : NaN,
        )
        const total = hundredths.every(Number.isFinite)
                ? hundredths.reduce((a, b) => a + b, 0) / 100
                : null

        async function handleSubmit(event: FormEvent) {
                event.preventDefault()
                setSaved(false)
                const updated = await action.run(() =>
                        setContributionWeights(
                                result.quarter_id,
                                result.employee.id,
                                result.components.map((c) => ({
                                        assignment_id: c.assignment_id,
                                        weight: weights[c.assignment_id].trim(),
                                })),
                        ),
                )
                if (updated) {
                        setSaved(true)
                        onSaved(updated)
                }
        }

        return (
                <form
                        onSubmit={handleSubmit}
                        aria-labelledby="weights-heading"
                        className={`${cardClasses} space-y-3 p-4`}
                >
                        <h2 id="weights-heading" className="text-base font-semibold text-slate-900">
                                Contribution weights
                        </h2>
                        <p className="text-sm text-slate-700">
                                How much each scored assignment counts towards the employee’s
                                quarterly score. They must total exactly 100 %; an unweighted
                                average is never used.
                        </p>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                {result.components.map((c) => (
                                        <label
                                                key={c.assignment_id}
                                                className="block space-y-1 text-sm"
                                        >
                                                <span className="font-medium text-slate-800">
                                                        Weight % for{' '}
                                                        {unitLabel(c.department, c.plant)}
                                                </span>
                                                <input
                                                        className={inputClasses}
                                                        inputMode="decimal"
                                                        value={weights[c.assignment_id]}
                                                        onChange={(e) =>
                                                                setWeights({
                                                                        ...weights,
                                                                        [c.assignment_id]:
                                                                                e.target.value,
                                                                })
                                                        }
                                                />
                                        </label>
                                ))}
                        </div>
                        <p aria-live="polite" className="text-sm font-medium text-slate-800">
                                {total === null
                                        ? 'Enter each weight with at most two decimals.'
                                        : `Total ${total.toFixed(2)} %`}
                        </p>
                        <ActionError error={action.error} title="The weights were not saved" />
                        {saved && <Alert title="Weights saved" />}
                        <Button
                                type="submit"
                                variant="primary"
                                isLoading={action.busy}
                                disabled={total !== 100}
                        >
                                Save weights
                        </Button>
                </form>
        )
}
