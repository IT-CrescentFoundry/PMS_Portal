import { Send } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { SelectField, TextField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { ReasonForm } from '../../components/common/ReasonForm'
import { StatCard } from '../../components/common/StatCard'
import { cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { decideScenario, getScenario, submitScenario } from '../../services/compensationApi'
import type { BudgetLine, BudgetScenario } from '../../types/api'
import { formatDate } from '../../utils/format'
import { parseId } from '../../utils/params'
import { History } from '../annual/AnnualEmployeePage'
import { InvalidLink } from '../common/InvalidLink'
import { scoreText } from '../scores/scoreLabels'
import { ProposalExplanation } from './ProposalExplanation'
import {
        CR_METHOD,
        EXCLUSIONS,
        MATRIX_TYPE_LABELS,
        SCENARIO_STATUS,
        VARIANCE_STATE,
        money,
        percent,
} from './compensationLabels'

/** /compensation/scenarios/:scenarioId */
export function ScenarioPage() {
        const scenarioId = parseId(useParams().scenarioId)
        const query = useApiQuery(
                scenarioId === undefined ? null : `budget-scenario|${scenarioId}`,
                (signal) => getScenario(scenarioId!, signal),
        )
        if (scenarioId === undefined)
                return <InvalidLink backTo="/compensation" backLabel="Back to compensation" />
        if (query.isLoading) return <LoadingState label="Loading the scenario…" />
        if (query.error !== undefined || !query.data) {
                return (
                        <>
                                <PageHeader
                                        title="Budget scenario"
                                        breadcrumbs={[
                                                {
                                                        label: 'Compensation & budget',
                                                        to: '/compensation',
                                                },
                                                { label: 'Scenario' },
                                        ]}
                                />
                                <ErrorState error={query.error} onRetry={query.reload} />
                        </>
                )
        }
        return <ScenarioView key={query.data.id} initial={query.data} />
}

function ScenarioView({ initial }: { initial: BudgetScenario }) {
        const [scenario, setScenario] = useState(initial)
        const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null)
        const [message, setMessage] = useState<string | null>(null)
        const action = useAction()
        const s = scenario
        const t = s.totals
        const status = SCENARIO_STATUS[s.status]

        async function handleSubmit() {
                const saved = await action.run(() => submitScenario(s.id))
                if (saved) {
                        setScenario(saved)
                        setMessage('Submitted to the CHRO for the final budget decision.')
                }
        }

        async function handleDecision(reason: string) {
                if (!deciding) return
                const saved = await action.run(() => decideScenario(s.id, deciding, reason))
                if (saved) {
                        setScenario(saved)
                        setDeciding(null)
                        setMessage(
                                deciding === 'approve'
                                        ? 'Approved as the final budget.'
                                        : 'Scenario rejected.',
                        )
                }
        }

        return (
                <>
                        <PageHeader
                                title={`Scenario ${s.scenario_no}: ${s.name}`}
                                description={`${s.cycle.name} · salary baseline version ${s.baseline_version_no} · ${CR_METHOD[s.cr_method].label} · matrices in force on ${formatDate(s.effective_date)}`}
                                breadcrumbs={[
                                        { label: 'Compensation & budget', to: '/compensation' },
                                        {
                                                label: s.cycle.name,
                                                to: `/compensation/cycles/${s.cycle.id}`,
                                        },
                                        { label: `Scenario ${s.scenario_no}` },
                                ]}
                                meta={
                                        <>
                                                <Badge tone={status.tone}>{status.label}</Badge>
                                                {s.analysis_only && (
                                                        <Badge tone="warning">Analysis only</Badge>
                                                )}
                                        </>
                                }
                        />
                        <div className="space-y-4">
                                {message && <Alert title={message} />}
                                {s.analysis_only && (
                                        <Alert tone="warning" title="Analysis only">
                                                Calculated with chosen matrix versions instead of
                                                the approved versions in force, so it can’t be
                                                submitted or produce a final decision.
                                        </Alert>
                                )}
                                {s.stale_reasons.length > 0 && (
                                        <Alert tone="warning" title="This scenario is out of date">
                                                <ul className="list-disc space-y-1 pl-5">
                                                        {s.stale_reasons.map((r) => (
                                                                <li key={r}>{r}</li>
                                                        ))}
                                                </ul>
                                                Calculate a new scenario; this one stays as it was
                                                calculated.
                                        </Alert>
                                )}
                                {s.decision_reason && (
                                        <Alert
                                                tone={s.status === 'REJECTED' ? 'danger' : 'info'}
                                                title={`${status.label} by ${s.decided_by?.username ?? '—'} on ${formatDate(s.decided_at)}`}
                                        >
                                                {s.decision_reason}
                                        </Alert>
                                )}
                                {s.note && <p className="text-sm text-slate-700">{s.note}</p>}

                                <section aria-labelledby="totals-heading" className="space-y-2">
                                        <h2
                                                id="totals-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Initial budget requirement
                                        </h2>
                                        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                                                <StatCard
                                                        label="Employees included"
                                                        value={`${t.included} of ${t.population}`}
                                                        hint={
                                                                t.excluded
                                                                        ? `${t.excluded} excluded (listed below)`
                                                                        : undefined
                                                        }
                                                />
                                                <StatCard
                                                        label="Current salaries (included)"
                                                        value={money(t.total_current_salary)}
                                                />
                                                <StatCard
                                                        label={`Increment requirement (${s.currency})`}
                                                        value={money(t.total_increment)}
                                                />
                                                <StatCard
                                                        label="Average increment"
                                                        value={percent(t.average_increment_percent)}
                                                />
                                        </dl>
                                        {t.rounding_difference !== null && (
                                                <p className="text-sm text-slate-700">
                                                        Unrounded requirement{' '}
                                                        {money(t.total_increment_exact)}; rounding
                                                        each employee’s amount to the cent adds{' '}
                                                        {money(t.rounding_difference)}. Rounding is
                                                        never redistributed.
                                                        {t.negative_adjustments > 0 &&
                                                                ` ${t.negative_adjustments} employee(s) have a negative adjustment.`}
                                                </p>
                                        )}
                                </section>

                                <BudgetComparison scenario={s} />

                                {Object.keys(t.reconciliation).length > 0 && (
                                        <section
                                                aria-labelledby="reconcile-heading"
                                                className={`${cardClasses} space-y-2 p-4`}
                                        >
                                                <h2
                                                        id="reconcile-heading"
                                                        className="text-base font-semibold text-slate-900"
                                                >
                                                        Reconciliation
                                                </h2>
                                                <ul className="space-y-1 text-sm">
                                                        <li>
                                                                Sum of employee amounts:{' '}
                                                                {money(
                                                                        String(
                                                                                t.reconciliation
                                                                                        .lines_total,
                                                                        ),
                                                                )}
                                                        </li>
                                                        <li>
                                                                Sum of the unit breakdown:{' '}
                                                                {money(
                                                                        String(
                                                                                t.reconciliation
                                                                                        .units_total,
                                                                        ),
                                                                )}
                                                        </li>
                                                        <li>
                                                                Each employee counted once (primary
                                                                plant attribution):{' '}
                                                                {t.reconciliation
                                                                        .employees_counted_once
                                                                        ? 'yes'
                                                                        : 'no'}
                                                        </li>
                                                        <li>
                                                                Every employee included or excluded
                                                                with a reason:{' '}
                                                                {t.reconciliation
                                                                        .every_employee_accounted
                                                                        ? 'yes'
                                                                        : 'no'}
                                                        </li>
                                                </ul>
                                        </section>
                                )}

                                <section aria-labelledby="matrices-heading" className="space-y-2">
                                        <h2
                                                id="matrices-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Matrix versions used
                                        </h2>
                                        {s.matrix_versions.length === 0 ? (
                                                <p className="text-sm text-slate-700">
                                                        No matrix was applied (every employee was
                                                        excluded first).
                                                </p>
                                        ) : (
                                                <ul
                                                        aria-label="Matrix versions used"
                                                        className="space-y-1 text-sm"
                                                >
                                                        {s.matrix_versions.map((v) => (
                                                                <li key={v.version_id}>
                                                                        {MATRIX_TYPE_LABELS[
                                                                                v.type
                                                                        ] ?? v.type}
                                                                        :{' '}
                                                                        <Link
                                                                                to={`/matrices/${v.matrix_id}/versions/${v.version_id}`}
                                                                                className={
                                                                                        linkClasses
                                                                                }
                                                                        >
                                                                                {v.code} version{' '}
                                                                                {v.version_no}
                                                                        </Link>
                                                                        {v.status !== 'PUBLISHED' &&
                                                                                ` (${v.status.toLowerCase()})`}
                                                                </li>
                                                        ))}
                                                </ul>
                                        )}
                                </section>

                                {t.excluded > 0 && (
                                        <Table caption="Excluded employees by reason">
                                                <thead>
                                                        <tr>
                                                                <Th>Reason</Th>
                                                                <Th align="right">Employees</Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {Object.entries(t.excluded_by_reason).map(
                                                                ([code, count]) => (
                                                                        <tr key={code}>
                                                                                <Td>
                                                                                        {EXCLUSIONS[
                                                                                                code
                                                                                        ] ?? code}
                                                                                </Td>
                                                                                <Td align="right">
                                                                                        {count}
                                                                                </Td>
                                                                        </tr>
                                                                ),
                                                        )}
                                                </TBody>
                                        </Table>
                                )}

                                {t.by_unit.length > 0 && (
                                        <section
                                                aria-labelledby="units-heading"
                                                className="space-y-2"
                                        >
                                                <h2
                                                        id="units-heading"
                                                        className="text-base font-semibold text-slate-900"
                                                >
                                                        By plant and department
                                                </h2>
                                                <Table caption="Requirement by plant and department">
                                                        <thead>
                                                                <tr>
                                                                        <Th>Plant</Th>
                                                                        <Th>Department</Th>
                                                                        <Th align="right">
                                                                                Included
                                                                        </Th>
                                                                        <Th align="right">
                                                                                Excluded
                                                                        </Th>
                                                                        <Th align="right">
                                                                                Current salaries
                                                                        </Th>
                                                                        <Th align="right">
                                                                                Increment
                                                                        </Th>
                                                                </tr>
                                                        </thead>
                                                        <TBody>
                                                                {t.by_unit.map((u) => (
                                                                        <tr
                                                                                key={`${u.plant?.id ?? 'none'}-${u.department?.id ?? 'none'}`}
                                                                        >
                                                                                <Td>
                                                                                        {u.plant
                                                                                                ?.name ??
                                                                                                'No primary plant'}
                                                                                </Td>
                                                                                <Td>
                                                                                        {u
                                                                                                .department
                                                                                                ?.name ??
                                                                                                '—'}
                                                                                </Td>
                                                                                <Td align="right">
                                                                                        {u.included}
                                                                                </Td>
                                                                                <Td align="right">
                                                                                        {u.excluded}
                                                                                </Td>
                                                                                {u.suppressed ? (
                                                                                        <Td
                                                                                                align="right"
                                                                                                colSpan={
                                                                                                        2
                                                                                                }
                                                                                        >
                                                                                                <span className="text-xs text-slate-600">
                                                                                                        Hidden:
                                                                                                        fewer
                                                                                                        than
                                                                                                        3
                                                                                                        employees
                                                                                                </span>
                                                                                        </Td>
                                                                                ) : (
                                                                                        <>
                                                                                                <Td align="right">
                                                                                                        {money(
                                                                                                                u.current_salary,
                                                                                                        )}
                                                                                                </Td>
                                                                                                <Td align="right">
                                                                                                        {money(
                                                                                                                u.increment,
                                                                                                        )}
                                                                                                </Td>
                                                                                        </>
                                                                                )}
                                                                        </tr>
                                                                ))}
                                                        </TBody>
                                                </Table>
                                        </section>
                                )}

                                {s.lines === null ? (
                                        <p className="text-sm text-slate-700">
                                                Employee-level amounts are visible only to
                                                compensation roles.
                                        </p>
                                ) : (
                                        <Lines lines={s.lines} currency={s.currency} />
                                )}

                                {(s.actions.can_submit ||
                                        s.actions.can_approve ||
                                        s.actions.can_reject) && (
                                        <section
                                                aria-labelledby="decision-heading"
                                                className={`${cardClasses} space-y-3 p-4`}
                                        >
                                                <h2
                                                        id="decision-heading"
                                                        className="text-base font-semibold text-slate-900"
                                                >
                                                        Decision
                                                </h2>
                                                <ActionError
                                                        error={action.error}
                                                        title="Nothing was changed"
                                                />
                                                {deciding ? (
                                                        <ReasonForm
                                                                label={
                                                                        deciding === 'approve'
                                                                                ? 'Reason for approving this scenario as the final budget'
                                                                                : 'Reason for rejecting this scenario'
                                                                }
                                                                submitLabel={
                                                                        deciding === 'approve'
                                                                                ? 'Approve the final budget'
                                                                                : 'Reject the scenario'
                                                                }
                                                                tone={
                                                                        deciding === 'approve'
                                                                                ? 'primary'
                                                                                : 'danger'
                                                                }
                                                                minLength={10}
                                                                busy={action.busy}
                                                                onSubmit={handleDecision}
                                                                onCancel={() => setDeciding(null)}
                                                        />
                                                ) : (
                                                        <div className="flex flex-wrap gap-2">
                                                                {s.actions.can_submit && (
                                                                        <Button
                                                                                variant="primary"
                                                                                isLoading={
                                                                                        action.busy
                                                                                }
                                                                                onClick={
                                                                                        handleSubmit
                                                                                }
                                                                        >
                                                                                <Send
                                                                                        aria-hidden="true"
                                                                                        className="size-4"
                                                                                />
                                                                                Submit to the CHRO
                                                                        </Button>
                                                                )}
                                                                {s.actions.can_approve && (
                                                                        <Button
                                                                                variant="primary"
                                                                                onClick={() =>
                                                                                        setDeciding(
                                                                                                'approve',
                                                                                        )
                                                                                }
                                                                        >
                                                                                Approve…
                                                                        </Button>
                                                                )}
                                                                {s.actions.can_reject && (
                                                                        <Button
                                                                                variant="danger"
                                                                                onClick={() =>
                                                                                        setDeciding(
                                                                                                'reject',
                                                                                        )
                                                                                }
                                                                        >
                                                                                Reject…
                                                                        </Button>
                                                                )}
                                                        </div>
                                                )}
                                                {s.status === 'SUBMITTED' &&
                                                        !s.actions.can_approve &&
                                                        s.actions.can_reject && (
                                                                <p className="text-sm text-slate-700">
                                                                        Approval needs the approved
                                                                        budget recorded by someone
                                                                        other than you.
                                                                </p>
                                                        )}
                                        </section>
                                )}

                                <History entries={s.history} />
                        </div>
                </>
        )
}

function BudgetComparison({ scenario }: { scenario: BudgetScenario }) {
        const v = scenario.variance
        return (
                <section
                        aria-labelledby="budget-heading"
                        className={`${cardClasses} space-y-2 p-4`}
                >
                        <h2 id="budget-heading" className="text-base font-semibold text-slate-900">
                                Against the approved budget
                        </h2>
                        {!v ? (
                                <p className="text-sm text-slate-700">
                                        The budget owner has not recorded the approved budget yet.
                                </p>
                        ) : (
                                <>
                                        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                                                <div>
                                                        <dt className="font-medium text-slate-700">
                                                                Approved budget (version{' '}
                                                                {v.decision_version})
                                                        </dt>
                                                        <dd className="tabular-nums">
                                                                {money(
                                                                        v.approved_budget,
                                                                        scenario.currency,
                                                                )}
                                                        </dd>
                                                </div>
                                                <div>
                                                        <dt className="font-medium text-slate-700">
                                                                Requirement
                                                        </dt>
                                                        <dd className="tabular-nums">
                                                                {money(
                                                                        v.requirement,
                                                                        scenario.currency,
                                                                )}
                                                        </dd>
                                                </div>
                                                <div>
                                                        <dt className="font-medium text-slate-700">
                                                                Difference (budget − requirement)
                                                        </dt>
                                                        <dd className="tabular-nums">
                                                                {money(v.difference)} (
                                                                {percent(v.difference_percent)} of
                                                                the requirement)
                                                        </dd>
                                                </div>
                                                <div>
                                                        <dt className="font-medium text-slate-700">
                                                                Result
                                                        </dt>
                                                        <dd>
                                                                <Badge
                                                                        tone={
                                                                                VARIANCE_STATE[
                                                                                        v.state
                                                                                ].tone
                                                                        }
                                                                >
                                                                        {
                                                                                VARIANCE_STATE[
                                                                                        v.state
                                                                                ].label
                                                                        }
                                                                </Badge>
                                                        </dd>
                                                </div>
                                        </dl>
                                        <p className="text-sm text-slate-700">
                                                {v.state === 'OVER_BUDGET'
                                                        ? `Overspend of ${money(v.overspend, scenario.currency)}.`
                                                        : `Unallocated balance of ${money(v.unallocated_balance, scenario.currency)}.`}{' '}
                                                Individual increments are never changed to fit the
                                                budget; revise the matrices or calculate another
                                                scenario instead.
                                        </p>
                                </>
                        )}
                </section>
        )
}

function Lines({ lines, currency }: { lines: BudgetLine[]; currency: string }) {
        const [search, setSearch] = useState('')
        const [show, setShow] = useState('ALL')
        const needle = search.trim().toLowerCase()
        const visible = lines.filter(
                (l) =>
                        (show === 'ALL' || l.status === show) &&
                        (!needle ||
                                l.employee.full_name.toLowerCase().includes(needle) ||
                                l.employee.employee_code.toLowerCase().includes(needle)),
        )
        return (
                <section aria-labelledby="lines-heading" className="space-y-2">
                        <h2 id="lines-heading" className="text-base font-semibold text-slate-900">
                                Employees
                        </h2>
                        <div className="flex flex-wrap items-end gap-3">
                                <div className="w-64">
                                        <TextField
                                                label="Search by name or code"
                                                value={search}
                                                onChange={(e) => setSearch(e.target.value)}
                                        />
                                </div>
                                <div className="w-48">
                                        <SelectField
                                                label="Show"
                                                value={show}
                                                onChange={(e) => setShow(e.target.value)}
                                                options={[
                                                        { value: 'ALL', label: 'Everyone' },
                                                        { value: 'INCLUDED', label: 'Included' },
                                                        { value: 'EXCLUDED', label: 'Excluded' },
                                                ]}
                                        />
                                </div>
                        </div>
                        <Table caption="Employee proposals">
                                <thead>
                                        <tr>
                                                <Th>Employee</Th>
                                                <Th align="right">Annual score</Th>
                                                <Th align="right">Compa-ratio</Th>
                                                <Th align="right">Rating</Th>
                                                <Th align="right">Increment</Th>
                                                <Th align="right">Amount</Th>
                                                <Th align="right">New salary</Th>
                                        </tr>
                                </thead>
                                <TBody>
                                        {visible.map((l) => (
                                                <tr key={l.employee.id}>
                                                        <Td>
                                                                {l.employee.full_name}
                                                                <div className="text-xs text-slate-600">
                                                                        {l.employee.employee_code}
                                                                        {l.plant &&
                                                                                ` · ${l.plant.name}`}
                                                                        {l.department &&
                                                                                ` · ${l.department.name}`}
                                                                </div>
                                                                {l.status === 'EXCLUDED' && (
                                                                        <div className="text-xs text-amber-900">
                                                                                Excluded:{' '}
                                                                                {EXCLUSIONS[
                                                                                        l.exclusion_code ??
                                                                                                ''
                                                                                ] ??
                                                                                        l.exclusion_code}
                                                                        </div>
                                                                )}
                                                                <details className="mt-1">
                                                                        <summary className="cursor-pointer text-xs text-brand-700">
                                                                                How this was
                                                                                calculated
                                                                        </summary>
                                                                        <div className="mt-2">
                                                                                <ProposalExplanation
                                                                                        line={l}
                                                                                        currency={
                                                                                                currency
                                                                                        }
                                                                                />
                                                                        </div>
                                                                </details>
                                                        </Td>
                                                        <Td align="right">
                                                                {scoreText(l.annual_score)}
                                                        </Td>
                                                        <Td align="right">
                                                                {l.compa_ratio ?? '—'}
                                                        </Td>
                                                        <Td align="right">
                                                                {l.performance_rating ?? '—'}
                                                        </Td>
                                                        <Td align="right">
                                                                {percent(l.increment_percent)}
                                                        </Td>
                                                        <Td align="right">
                                                                {money(l.increment_amount)}
                                                        </Td>
                                                        <Td align="right">{money(l.new_salary)}</Td>
                                                </tr>
                                        ))}
                                </TBody>
                        </Table>
                        {visible.length === 0 && (
                                <p className="text-sm text-slate-700">No employee matches.</p>
                        )}
                </section>
        )
}
