import { Calculator, FileUp, Pencil } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import {
        CheckboxField,
        SelectField,
        TextAreaField,
        TextField,
} from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { buttonClasses, cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import {
        calculateScenario,
        getCompensationCycle,
        recordBudgetDecision,
        updateCompensationCycle,
} from '../../services/compensationApi'
import type { CompensationCycleDetail } from '../../types/api'
import { formatDate } from '../../utils/format'
import { parseId } from '../../utils/params'
import { History } from '../annual/AnnualEmployeePage'
import { InvalidLink } from '../common/InvalidLink'
import { CycleForm } from './CycleForm'
import {
        CR_METHOD,
        SCENARIO_STATUS,
        VARIANCE_STATE,
        chosenVersions,
        money,
} from './compensationLabels'
import { VersionChoices } from './VersionChoices'

/** /compensation/cycles/:cycleId */
export function CompensationCyclePage() {
        const cycleId = parseId(useParams().cycleId)
        const query = useApiQuery(
                cycleId === undefined ? null : `compensation-cycle|${cycleId}`,
                (signal) => getCompensationCycle(cycleId!, signal),
        )
        if (cycleId === undefined)
                return <InvalidLink backTo="/compensation" backLabel="Back to compensation" />
        if (query.isLoading) return <LoadingState label="Loading the compensation cycle…" />
        if (query.error !== undefined || !query.data) {
                return (
                        <>
                                <PageHeader
                                        title="Compensation cycle"
                                        breadcrumbs={[
                                                {
                                                        label: 'Compensation & budget',
                                                        to: '/compensation',
                                                },
                                                { label: 'Cycle' },
                                        ]}
                                />
                                <ErrorState error={query.error} onRetry={query.reload} />
                        </>
                )
        }
        return <CycleView key={query.data.id} initial={query.data} />
}

function CycleView({ initial }: { initial: CompensationCycleDetail }) {
        const [cycle, setCycle] = useState(initial)
        const [editing, setEditing] = useState(false)
        const [message, setMessage] = useState<string | null>(null)
        const open = cycle.status === 'OPEN'
        const a = cycle.actions
        const current = cycle.decisions.find((d) => d.status === 'CURRENT')
        return (
                <>
                        <PageHeader
                                title={cycle.name}
                                description={`${cycle.code} · annual results from ${cycle.pms_cycle.name} · ${cycle.currency}`}
                                breadcrumbs={[
                                        { label: 'Compensation & budget', to: '/compensation' },
                                        { label: cycle.name },
                                ]}
                                meta={
                                        <Badge tone={open ? 'neutral' : 'success'}>
                                                {open
                                                        ? 'Open'
                                                        : `Finalized ${formatDate(cycle.finalized_at)}`}
                                        </Badge>
                                }
                        />
                        <div className="space-y-4">
                                {message && <Alert title={message} />}
                                {editing ? (
                                        <CycleForm
                                                initial={cycle}
                                                submitLabel="Save the cycle"
                                                onCancel={() => setEditing(false)}
                                                onSubmit={(body) =>
                                                        updateCompensationCycle(cycle.id, body)
                                                }
                                                onSaved={(saved) => {
                                                        setCycle(saved)
                                                        setEditing(false)
                                                        setMessage('Cycle saved.')
                                                }}
                                        />
                                ) : (
                                        <section
                                                aria-labelledby="config-heading"
                                                className={`${cardClasses} space-y-3 p-4`}
                                        >
                                                <div className="flex flex-wrap items-center justify-between gap-2">
                                                        <h2
                                                                id="config-heading"
                                                                className="text-base font-semibold text-slate-900"
                                                        >
                                                                Configuration
                                                        </h2>
                                                        {a.can_manage && open && (
                                                                <Button
                                                                        size="sm"
                                                                        onClick={() =>
                                                                                setEditing(true)
                                                                        }
                                                                >
                                                                        <Pencil
                                                                                aria-hidden="true"
                                                                                className="size-4"
                                                                        />
                                                                        Edit
                                                                </Button>
                                                        )}
                                                </div>
                                                <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                                                        <div>
                                                                <dt className="font-medium text-slate-700">
                                                                        Effective date
                                                                </dt>
                                                                <dd>
                                                                        {formatDate(
                                                                                cycle.effective_date,
                                                                        )}
                                                                </dd>
                                                        </div>
                                                        <div>
                                                                <dt className="font-medium text-slate-700">
                                                                        Compa-ratio
                                                                </dt>
                                                                <dd>
                                                                        Current salary ÷{' '}
                                                                        {cycle.reference_label}
                                                                </dd>
                                                        </div>
                                                        <div className="sm:col-span-2">
                                                                <dt className="font-medium text-slate-700">
                                                                        Compa-ratio method
                                                                </dt>
                                                                <dd>
                                                                        {
                                                                                CR_METHOD[
                                                                                        cycle
                                                                                                .cr_method
                                                                                ].label
                                                                        }
                                                                        <div className="text-xs text-slate-600">
                                                                                {
                                                                                        CR_METHOD[
                                                                                                cycle
                                                                                                        .cr_method
                                                                                        ].detail
                                                                                }
                                                                        </div>
                                                                </dd>
                                                        </div>
                                                </dl>
                                                {cycle.notes && (
                                                        <p className="text-sm text-slate-700">
                                                                {cycle.notes}
                                                        </p>
                                                )}
                                        </section>
                                )}

                                <section aria-labelledby="policy-heading" className="space-y-2">
                                        <h2
                                                id="policy-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Approved matrices on{' '}
                                                {formatDate(cycle.effective_date)}
                                        </h2>
                                        <ul
                                                aria-label="Compensation matrices"
                                                className="space-y-1 text-sm"
                                        >
                                                {cycle.policy.map((p) => (
                                                        <li
                                                                key={p.type}
                                                                className="flex flex-wrap items-center gap-2"
                                                        >
                                                                <span className="font-medium text-slate-900">
                                                                        {p.label}
                                                                </span>
                                                                {p.status === 'APPROVED' ? (
                                                                        <Badge tone="success">
                                                                                Approved
                                                                        </Badge>
                                                                ) : (
                                                                        <Badge tone="warning">
                                                                                Awaiting approved
                                                                                configuration
                                                                        </Badge>
                                                                )}
                                                                {p.versions.map((v) => (
                                                                        <Link
                                                                                key={v.version_id}
                                                                                to={`/matrices/${v.matrix_id}/versions/${v.version_id}`}
                                                                                className={
                                                                                        linkClasses
                                                                                }
                                                                        >
                                                                                {v.code} version{' '}
                                                                                {v.version_no}
                                                                        </Link>
                                                                ))}
                                                        </li>
                                                ))}
                                        </ul>
                                        <p className="text-sm text-slate-600">
                                                Only versions approved by the CHRO and published
                                                produce a scenario that can be submitted. Values are
                                                company policy only once approved; none are assumed.
                                        </p>
                                </section>

                                <section
                                        aria-labelledby="baseline-heading"
                                        className={`${cardClasses} space-y-3 p-4`}
                                >
                                        <h2
                                                id="baseline-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Salary baseline
                                        </h2>
                                        {cycle.baselines.length === 0 ? (
                                                <p className="text-sm text-slate-700">
                                                        No salary baseline has been imported yet.
                                                </p>
                                        ) : (
                                                <ul
                                                        aria-label="Salary baseline versions"
                                                        className="space-y-1 text-sm"
                                                >
                                                        {cycle.baselines.map((b) => (
                                                                <li key={b.id}>
                                                                        Version {b.version_no}:{' '}
                                                                        {b.row_count} employees,{' '}
                                                                        {b.file_name} ·{' '}
                                                                        {b.imported_by?.username ??
                                                                                '—'}{' '}
                                                                        · {formatDate(b.created_at)}
                                                                </li>
                                                        ))}
                                                </ul>
                                        )}
                                        <div className="flex flex-wrap gap-2">
                                                {a.can_manage && open && (
                                                        <Link
                                                                to={`/compensation/cycles/${cycle.id}/baseline`}
                                                                className={buttonClasses(
                                                                        'secondary',
                                                                        'sm',
                                                                )}
                                                        >
                                                                <FileUp
                                                                        aria-hidden="true"
                                                                        className="size-4"
                                                                />
                                                                Import a salary baseline
                                                        </Link>
                                                )}
                                                {a.can_read_employees &&
                                                        cycle.baselines.length > 0 && (
                                                                <Link
                                                                        to={`/compensation/cycles/${cycle.id}/preview`}
                                                                        className={buttonClasses(
                                                                                'secondary',
                                                                                'sm',
                                                                        )}
                                                                >
                                                                        Preview one employee’s
                                                                        proposal
                                                                </Link>
                                                        )}
                                        </div>
                                </section>

                                <section
                                        aria-labelledby="budget-heading"
                                        className={`${cardClasses} space-y-3 p-4`}
                                >
                                        <h2
                                                id="budget-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Approved budget
                                        </h2>
                                        {current ? (
                                                <p className="text-sm">
                                                        <span className="text-lg font-semibold tabular-nums">
                                                                {money(
                                                                        current.approved_amount,
                                                                        cycle.currency,
                                                                )}
                                                        </span>{' '}
                                                        (version {current.version_no}, recorded by{' '}
                                                        {current.recorded_by?.username ?? '—'} on{' '}
                                                        {formatDate(current.recorded_at)}) —{' '}
                                                        {current.reason}
                                                </p>
                                        ) : (
                                                <p className="text-sm text-slate-700">
                                                        The budget owner has not recorded the
                                                        approved budget yet.
                                                </p>
                                        )}
                                        {cycle.decisions.length > 1 && (
                                                <Table caption="Budget decision history">
                                                        <thead>
                                                                <tr>
                                                                        <Th>Version</Th>
                                                                        <Th align="right">
                                                                                Approved budget
                                                                        </Th>
                                                                        <Th align="right">
                                                                                Replaces
                                                                        </Th>
                                                                        <Th>Reason</Th>
                                                                        <Th>Recorded</Th>
                                                                </tr>
                                                        </thead>
                                                        <TBody>
                                                                {cycle.decisions.map((d) => (
                                                                        <tr key={d.id}>
                                                                                <Td>
                                                                                        {
                                                                                                d.version_no
                                                                                        }
                                                                                        {d.status ===
                                                                                                'SUPERSEDED' && (
                                                                                                <div className="text-xs text-slate-600">
                                                                                                        superseded
                                                                                                </div>
                                                                                        )}
                                                                                </Td>
                                                                                <Td align="right">
                                                                                        {money(
                                                                                                d.approved_amount,
                                                                                        )}
                                                                                </Td>
                                                                                <Td align="right">
                                                                                        {money(
                                                                                                d.previous_amount,
                                                                                        )}
                                                                                </Td>
                                                                                <Td>{d.reason}</Td>
                                                                                <Td>
                                                                                        {d
                                                                                                .recorded_by
                                                                                                ?.username ??
                                                                                                '—'}
                                                                                        <div className="text-xs text-slate-600">
                                                                                                {formatDate(
                                                                                                        d.recorded_at,
                                                                                                )}
                                                                                        </div>
                                                                                </Td>
                                                                        </tr>
                                                                ))}
                                                        </TBody>
                                                </Table>
                                        )}
                                        {a.can_record_budget && open && (
                                                <DecisionForm
                                                        currency={cycle.currency}
                                                        onSaved={(saved) => {
                                                                setCycle(saved)
                                                                setMessage(
                                                                        'Approved budget recorded.',
                                                                )
                                                        }}
                                                        cycleId={cycle.id}
                                                />
                                        )}
                                </section>

                                <section aria-labelledby="scenarios-heading" className="space-y-2">
                                        <h2
                                                id="scenarios-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Scenarios
                                        </h2>
                                        {cycle.scenarios.length === 0 ? (
                                                <p className="text-sm text-slate-700">
                                                        No scenario has been calculated yet.
                                                </p>
                                        ) : (
                                                <Table caption="Budget scenarios">
                                                        <thead>
                                                                <tr>
                                                                        <Th>Scenario</Th>
                                                                        <Th>Status</Th>
                                                                        <Th align="right">
                                                                                Included
                                                                        </Th>
                                                                        <Th align="right">
                                                                                Requirement
                                                                        </Th>
                                                                        <Th>Against the budget</Th>
                                                                        <Th>Calculated</Th>
                                                                </tr>
                                                        </thead>
                                                        <TBody>
                                                                {cycle.scenarios.map((s) => (
                                                                        <tr key={s.id}>
                                                                                <Td>
                                                                                        <Link
                                                                                                to={`/compensation/scenarios/${s.id}`}
                                                                                                className={
                                                                                                        linkClasses
                                                                                                }
                                                                                        >
                                                                                                {
                                                                                                        s.scenario_no
                                                                                                }
                                                                                                .{' '}
                                                                                                {
                                                                                                        s.name
                                                                                                }
                                                                                        </Link>
                                                                                        {s.analysis_only && (
                                                                                                <div className="text-xs text-amber-900">
                                                                                                        Analysis
                                                                                                        only
                                                                                                </div>
                                                                                        )}
                                                                                </Td>
                                                                                <Td>
                                                                                        <Badge
                                                                                                tone={
                                                                                                        SCENARIO_STATUS[
                                                                                                                s
                                                                                                                        .status
                                                                                                        ]
                                                                                                                .tone
                                                                                                }
                                                                                        >
                                                                                                {
                                                                                                        SCENARIO_STATUS[
                                                                                                                s
                                                                                                                        .status
                                                                                                        ]
                                                                                                                .label
                                                                                                }
                                                                                        </Badge>
                                                                                </Td>
                                                                                <Td align="right">
                                                                                        {
                                                                                                s.included_count
                                                                                        }{' '}
                                                                                        of{' '}
                                                                                        {s.included_count +
                                                                                                s.excluded_count}
                                                                                </Td>
                                                                                <Td align="right">
                                                                                        {money(
                                                                                                s.total_increment,
                                                                                                cycle.currency,
                                                                                        )}
                                                                                </Td>
                                                                                <Td>
                                                                                        {s.variance ? (
                                                                                                <>
                                                                                                        <Badge
                                                                                                                tone={
                                                                                                                        VARIANCE_STATE[
                                                                                                                                s
                                                                                                                                        .variance
                                                                                                                                        .state
                                                                                                                        ]
                                                                                                                                .tone
                                                                                                                }
                                                                                                        >
                                                                                                                {
                                                                                                                        VARIANCE_STATE[
                                                                                                                                s
                                                                                                                                        .variance
                                                                                                                                        .state
                                                                                                                        ]
                                                                                                                                .label
                                                                                                                }
                                                                                                        </Badge>{' '}
                                                                                                        {money(
                                                                                                                s
                                                                                                                        .variance
                                                                                                                        .difference,
                                                                                                        )}
                                                                                                </>
                                                                                        ) : (
                                                                                                '—'
                                                                                        )}
                                                                                </Td>
                                                                                <Td>
                                                                                        {formatDate(
                                                                                                s.calculated_at,
                                                                                        )}
                                                                                        <div className="text-xs text-slate-600">
                                                                                                {s
                                                                                                        .calculated_by
                                                                                                        ?.username ??
                                                                                                        '—'}
                                                                                        </div>
                                                                                </Td>
                                                                        </tr>
                                                                ))}
                                                        </TBody>
                                                </Table>
                                        )}
                                        {a.can_manage && open && cycle.baselines.length > 0 && (
                                                <ScenarioForm cycle={cycle} />
                                        )}
                                </section>

                                <History entries={cycle.history} />
                        </div>
                </>
        )
}

function DecisionForm({
        cycleId,
        currency,
        onSaved,
}: {
        cycleId: number
        currency: string
        onSaved: (cycle: CompensationCycleDetail) => void
}) {
        const [amount, setAmount] = useState('')
        const [reason, setReason] = useState('')
        const [touched, setTouched] = useState(false)
        const action = useAction()
        const errors = {
                amount: /^\d{1,14}(\.\d{1,2})?$/.test(amount.trim())
                        ? undefined
                        : 'Enter an amount with at most two decimals.',
                reason:
                        reason.trim().length >= 10
                                ? undefined
                                : 'Give the reason or source (at least 10 characters).',
        }
        async function handleSubmit(event: FormEvent) {
                event.preventDefault()
                setTouched(true)
                if (errors.amount || errors.reason) return
                const saved = await action.run(() =>
                        recordBudgetDecision(cycleId, amount.trim(), reason.trim()),
                )
                if (saved) {
                        setAmount('')
                        setReason('')
                        setTouched(false)
                        onSaved(saved)
                }
        }
        return (
                <form
                        noValidate
                        onSubmit={handleSubmit}
                        aria-label="Record the approved budget"
                        className="space-y-3"
                >
                        <div className="max-w-xs">
                                <TextField
                                        label={`Company-approved budget (${currency})`}
                                        inputMode="decimal"
                                        value={amount}
                                        error={touched ? errors.amount : undefined}
                                        onChange={(e) => setAmount(e.target.value)}
                                />
                        </div>
                        <TextAreaField
                                label="Reason or source of the decision"
                                maxLength={1000}
                                value={reason}
                                error={touched ? errors.reason : undefined}
                                onChange={(e) => setReason(e.target.value)}
                        />
                        <ActionError error={action.error} title="The budget was not recorded" />
                        <Button type="submit" variant="primary" isLoading={action.busy}>
                                Record the approved budget
                        </Button>
                </form>
        )
}

function ScenarioForm({ cycle }: { cycle: CompensationCycleDetail }) {
        const navigate = useNavigate()
        const [name, setName] = useState('')
        const [baselineId, setBaselineId] = useState(String(cycle.baselines[0]?.id ?? ''))
        const [analysis, setAnalysis] = useState(false)
        const [overrides, setOverrides] = useState<Record<string, string>>({})
        const [touched, setTouched] = useState(false)
        const action = useAction()
        const error = name.trim() ? undefined : 'Name the scenario.'

        async function handleSubmit(event: FormEvent) {
                event.preventDefault()
                setTouched(true)
                if (error) return
                const created = await action.run(() =>
                        calculateScenario(cycle.id, {
                                name: name.trim(),
                                baseline_id: Number(baselineId) || null,
                                overrides: analysis ? chosenVersions(overrides) : null,
                        }),
                )
                if (created) navigate(`/compensation/scenarios/${created.id}`)
        }

        return (
                <form
                        noValidate
                        onSubmit={handleSubmit}
                        aria-label="Calculate a scenario"
                        className={`${cardClasses} space-y-3 p-4`}
                >
                        <h3 className="text-sm font-semibold text-slate-900">
                                Calculate a scenario
                        </h3>
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                <TextField
                                        label="Scenario name"
                                        maxLength={100}
                                        value={name}
                                        error={touched ? error : undefined}
                                        onChange={(e) => setName(e.target.value)}
                                />
                                <SelectField
                                        label="Salary baseline"
                                        value={baselineId}
                                        onChange={(e) => setBaselineId(e.target.value)}
                                        options={cycle.baselines.map((b) => ({
                                                value: String(b.id),
                                                label: `Version ${b.version_no} (${b.row_count} employees)`,
                                        }))}
                                />
                        </div>
                        <CheckboxField
                                label="Choose matrix versions for analysis (the scenario can’t be submitted)"
                                checked={analysis}
                                onChange={(e) => setAnalysis(e.target.checked)}
                        />
                        {analysis && (
                                <VersionChoices
                                        method={cycle.cr_method}
                                        value={overrides}
                                        onChange={setOverrides}
                                />
                        )}
                        <ActionError error={action.error} title="The scenario was not calculated" />
                        <Button type="submit" variant="primary" isLoading={action.busy}>
                                <Calculator aria-hidden="true" className="size-4" />
                                Calculate the scenario
                        </Button>
                </form>
        )
}
