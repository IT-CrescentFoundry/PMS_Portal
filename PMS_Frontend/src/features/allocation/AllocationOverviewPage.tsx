import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { CheckboxField, SelectField, TextField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { ReasonForm } from '../../components/common/ReasonForm'
import { StatCard } from '../../components/common/StatCard'
import { buttonClasses, cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import {
        getAllocationOverview,
        getAllocationReport,
        setDiscretionPolicy,
        startDistribution,
        startProposal,
        type OverviewFilters,
} from '../../services/allocationApi'
import type {
        AllocationOverview,
        AllocationStatus,
        AllocationUnit,
        DiscretionMode,
        DiscretionPolicy,
} from '../../types/api'
import { parseId } from '../../utils/params'
import { InvalidLink } from '../common/InvalidLink'
import { EXCLUSIONS, money } from '../compensation/compensationLabels'
import { ALLOCATION_STATUS, DISCRETION, policyText } from './allocationLabels'

/** /allocations/cycles/:cycleId */
export function AllocationOverviewPage() {
        const cycleId = parseId(useParams().cycleId)
        const [filters, setFilters] = useState<OverviewFilters>({})
        const query = useApiQuery(
                cycleId === undefined
                        ? null
                        : `allocation-overview|${cycleId}|${JSON.stringify(filters)}`,
                (signal) => getAllocationOverview(cycleId!, filters, signal),
        )
        if (cycleId === undefined)
                return <InvalidLink backTo="/allocations" backLabel="Back to allocations" />
        if (query.isLoading && !query.data) return <LoadingState label="Loading allocations…" />
        if (query.error !== undefined || !query.data) {
                return (
                        <>
                                <PageHeader
                                        title="Increment allocations"
                                        breadcrumbs={[
                                                {
                                                        label: 'Increment allocations',
                                                        to: '/allocations',
                                                },
                                                { label: 'Cycle' },
                                        ]}
                                />
                                <ErrorState error={query.error} onRetry={query.reload} />
                        </>
                )
        }
        return (
                <Overview
                        data={query.data}
                        filters={filters}
                        onFilters={setFilters}
                        onChanged={query.reload}
                />
        )
}

function Overview({
        data,
        filters,
        onFilters,
        onChanged,
}: {
        data: AllocationOverview
        filters: OverviewFilters
        onFilters: (f: OverviewFilters) => void
        onChanged: () => void
}) {
        const c = data.cycle
        const s = data.summary
        const cur = c.currency
        return (
                <>
                        <PageHeader
                                title={c.name}
                                description="Distribution of the approved company budget, departments' proposals and their approval. Nothing is adjusted automatically to fit a budget."
                                breadcrumbs={[
                                        { label: 'Increment allocations', to: '/allocations' },
                                        { label: c.name },
                                ]}
                                meta={
                                        c.budget_finalized ? (
                                                <Badge tone="success">
                                                        Company budget approved
                                                </Badge>
                                        ) : (
                                                <Badge tone="warning">
                                                        {c.revision_no > 0
                                                                ? `Budget revision ${c.revision_no} in progress`
                                                                : 'Company budget not approved yet'}
                                                </Badge>
                                        )
                                }
                        />
                        <div className="space-y-4">
                                {!c.budget_finalized && (
                                        <Alert tone="warning" title="Allocation is paused">
                                                Distribution and proposals continue once the CHRO
                                                approves the company budget.
                                        </Alert>
                                )}
                                {s && (
                                        <section
                                                aria-labelledby="summary-heading"
                                                className="space-y-2"
                                        >
                                                <h2
                                                        id="summary-heading"
                                                        className="text-base font-semibold text-slate-900"
                                                >
                                                        Company
                                                </h2>
                                                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                                        <StatCard
                                                                label={`Approved company budget (${cur})`}
                                                                value={money(s.budget)}
                                                        />
                                                        <StatCard
                                                                label="Distributed to plants"
                                                                value={money(
                                                                        s.distributed_to_plants,
                                                                )}
                                                                hint={`Unallocated ${money(s.unallocated_company)} · rounding ${money(s.rounding_residual)}`}
                                                        />
                                                        <StatCard
                                                                label="Distributed to departments"
                                                                value={money(
                                                                        s.distributed_to_units,
                                                                )}
                                                                hint={`Left at plant level ${money(s.unallocated_plants)}`}
                                                        />
                                                        <StatCard
                                                                label="Matrix recommendation"
                                                                value={money(s.recommended_total)}
                                                        />
                                                        <StatCard
                                                                label="Proposed by departments"
                                                                value={money(s.proposed_total)}
                                                                hint="Open and approved proposals"
                                                        />
                                                        <StatCard
                                                                label="Approved by the CHRO"
                                                                value={money(s.approved_total)}
                                                        />
                                                </dl>
                                                <p className="text-sm text-slate-700">
                                                        {Object.entries(s.by_status)
                                                                .map(
                                                                        ([k, n]) =>
                                                                                `${ALLOCATION_STATUS[k as AllocationStatus]?.label ?? k}: ${n}`,
                                                                )
                                                                .join(' · ')}
                                                        {s.stale > 0 && ` · ${s.stale} out of date`}
                                                </p>
                                                <ul
                                                        aria-label="Reconciliation"
                                                        className="space-y-0.5 text-sm text-slate-700"
                                                >
                                                        <li>
                                                                Department recommendations add up to
                                                                the approved budget's scenario:{' '}
                                                                {s.reconciliation
                                                                        .units_recommended_total ===
                                                                s.reconciliation
                                                                        .scenario_recommended_total
                                                                        ? 'yes'
                                                                        : 'no'}
                                                        </li>
                                                        <li>
                                                                Every included employee in exactly
                                                                one department:{' '}
                                                                {s.reconciliation
                                                                        .every_included_employee_in_one_unit
                                                                        ? 'yes'
                                                                        : 'no'}
                                                        </li>
                                                        <li>
                                                                No employee in two approved
                                                                allocations:{' '}
                                                                {s.reconciliation
                                                                        .no_employee_in_two_approved_proposals
                                                                        ? 'yes'
                                                                        : 'no'}
                                                        </li>
                                                        <li>
                                                                Approved allocations within their
                                                                department budgets:{' '}
                                                                {s.reconciliation
                                                                        .approved_within_unit_budgets
                                                                        ? 'yes'
                                                                        : 'no'}
                                                        </li>
                                                </ul>
                                        </section>
                                )}
                                <DistributionPanel data={data} />
                                <PolicyPanel
                                        cycleId={c.id}
                                        policy={data.policy}
                                        canSet={data.actions.can_set_policy}
                                        onSaved={onChanged}
                                />
                                <Units data={data} filters={filters} onFilters={onFilters} />
                                {data.excluded.length > 0 && (
                                        <Table caption="Excluded employees">
                                                <thead>
                                                        <tr>
                                                                <Th>Employee</Th>
                                                                <Th>Department</Th>
                                                                <Th>Reason</Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {data.excluded.map((x) => (
                                                                <tr key={x.employee.id}>
                                                                        <Td>
                                                                                {
                                                                                        x.employee
                                                                                                .full_name
                                                                                }
                                                                                <div className="text-xs text-slate-600">
                                                                                        {
                                                                                                x
                                                                                                        .employee
                                                                                                        .employee_code
                                                                                        }
                                                                                </div>
                                                                        </Td>
                                                                        <Td>
                                                                                {x.department &&
                                                                                x.plant
                                                                                        ? `${x.department.name} — ${x.plant.name}`
                                                                                        : 'No primary unit'}
                                                                        </Td>
                                                                        <Td>
                                                                                {EXCLUSIONS[
                                                                                        x.code ?? ''
                                                                                ] ?? x.code}
                                                                                {x.reason && (
                                                                                        <div className="text-xs text-slate-600">
                                                                                                {
                                                                                                        x.reason
                                                                                                }
                                                                                        </div>
                                                                                )}
                                                                        </Td>
                                                                </tr>
                                                        ))}
                                                </TBody>
                                        </Table>
                                )}
                                {s &&
                                        Object.keys(s.excluded_by_reason).length > 0 &&
                                        data.excluded.length === 0 && (
                                                <p className="text-sm text-slate-700">
                                                        Excluded employees:{' '}
                                                        {Object.entries(s.excluded_by_reason)
                                                                .map(
                                                                        ([k, n]) =>
                                                                                `${EXCLUSIONS[k] ?? k} ${n}`,
                                                                )
                                                                .join(' · ')}
                                                </p>
                                        )}
                                {data.actions.can_read_employees && (
                                        <EmployeeReport cycleId={c.id} />
                                )}
                        </div>
                </>
        )
}

function DistributionPanel({ data }: { data: AllocationOverview }) {
        const navigate = useNavigate()
        const [revising, setRevising] = useState(false)
        const action = useAction()
        const d = data.distribution
        const draftId = data.actions.draft_distribution_id

        async function start(reason: string | null) {
                const created = await action.run(() => startDistribution(data.cycle.id, reason))
                if (created) navigate(`/allocations/distributions/${created.id}`)
        }

        return (
                <section
                        aria-labelledby="distribution-heading"
                        className={`${cardClasses} space-y-2 p-4`}
                >
                        <h2
                                id="distribution-heading"
                                className="text-base font-semibold text-slate-900"
                        >
                                Distribution
                        </h2>
                        {d ? (
                                <p className="text-sm">
                                        <Link
                                                to={`/allocations/distributions/${d.id}`}
                                                className={linkClasses}
                                        >
                                                Version {d.version_no}
                                        </Link>{' '}
                                        is in force: {money(d.totals.plants_total)} to plants,{' '}
                                        {money(d.totals.units_total)} to departments.
                                </p>
                        ) : (
                                <p className="text-sm text-slate-700">
                                        The budget owner has not published a distribution yet.
                                </p>
                        )}
                        <ActionError
                                error={action.error}
                                title="The distribution was not started"
                        />
                        {data.actions.can_distribute && data.cycle.budget_finalized && (
                                <div className="flex flex-wrap gap-2">
                                        {draftId ? (
                                                <Link
                                                        to={`/allocations/distributions/${draftId}`}
                                                        className={buttonClasses('primary', 'sm')}
                                                >
                                                        Continue the draft
                                                </Link>
                                        ) : d ? (
                                                revising ? (
                                                        <div className="w-full">
                                                                <ReasonForm
                                                                        label="Why does the distribution change?"
                                                                        hint="At least 10 characters; recorded with the new version."
                                                                        minLength={10}
                                                                        submitLabel="Start a revised version"
                                                                        busy={action.busy}
                                                                        onSubmit={(reason) =>
                                                                                start(reason)
                                                                        }
                                                                        onCancel={() =>
                                                                                setRevising(false)
                                                                        }
                                                                />
                                                        </div>
                                                ) : (
                                                        <Button
                                                                size="sm"
                                                                onClick={() => setRevising(true)}
                                                        >
                                                                Revise the distribution…
                                                        </Button>
                                                )
                                        ) : (
                                                <Button
                                                        size="sm"
                                                        variant="primary"
                                                        isLoading={action.busy}
                                                        onClick={() => start(null)}
                                                >
                                                        Distribute the budget
                                                </Button>
                                        )}
                                </div>
                        )}
                </section>
        )
}

function PolicyPanel({
        cycleId,
        policy,
        canSet,
        onSaved,
}: {
        cycleId: number
        policy: DiscretionPolicy
        canSet: boolean
        onSaved: () => void
}) {
        const [editing, setEditing] = useState(false)
        const [mode, setMode] = useState<DiscretionMode>(policy.mode)
        const [inc, setInc] = useState(policy.max_increase_points ?? '')
        const [dec, setDec] = useState(policy.max_decrease_points ?? '')
        const action = useAction()

        async function handleSubmit(event: FormEvent) {
                event.preventDefault()
                const limits = mode === 'WITHIN_LIMITS'
                const saved = await action.run(() =>
                        setDiscretionPolicy(cycleId, {
                                mode,
                                max_increase_points: limits ? inc.trim() || null : null,
                                max_decrease_points: limits ? dec.trim() || null : null,
                        }),
                )
                if (saved) {
                        setEditing(false)
                        onSaved()
                }
        }

        return (
                <section
                        aria-labelledby="policy-heading"
                        className={`${cardClasses} space-y-2 p-4`}
                >
                        <h2 id="policy-heading" className="text-base font-semibold text-slate-900">
                                Department discretion
                        </h2>
                        <p className="text-sm text-slate-800">{policyText(policy)}</p>
                        <p className="text-xs text-slate-600">
                                Every change keeps the matrix recommendation beside it and needs a
                                reason; nothing is final before the CHRO approves it.
                        </p>
                        {canSet &&
                                (editing ? (
                                        <form
                                                onSubmit={handleSubmit}
                                                noValidate
                                                aria-label="Discretion policy"
                                                className="space-y-3"
                                        >
                                                <SelectField
                                                        label="Policy"
                                                        value={mode}
                                                        onChange={(e) =>
                                                                setMode(
                                                                        e.target
                                                                                .value as DiscretionMode,
                                                                )
                                                        }
                                                        options={(
                                                                Object.keys(
                                                                        DISCRETION,
                                                                ) as DiscretionMode[]
                                                        ).map((m) => ({
                                                                value: m,
                                                                label: DISCRETION[m].label,
                                                        }))}
                                                        hint={DISCRETION[mode].detail}
                                                />
                                                {mode === 'WITHIN_LIMITS' && (
                                                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                                                <TextField
                                                                        label="Largest increase (percentage points)"
                                                                        inputMode="decimal"
                                                                        value={inc}
                                                                        onChange={(e) =>
                                                                                setInc(
                                                                                        e.target
                                                                                                .value,
                                                                                )
                                                                        }
                                                                />
                                                                <TextField
                                                                        label="Largest decrease (percentage points)"
                                                                        inputMode="decimal"
                                                                        value={dec}
                                                                        onChange={(e) =>
                                                                                setDec(
                                                                                        e.target
                                                                                                .value,
                                                                                )
                                                                        }
                                                                />
                                                        </div>
                                                )}
                                                <ActionError
                                                        error={action.error}
                                                        title="The policy was not saved"
                                                />
                                                <div className="flex flex-wrap gap-2">
                                                        <Button
                                                                type="submit"
                                                                variant="primary"
                                                                isLoading={action.busy}
                                                        >
                                                                Save the policy
                                                        </Button>
                                                        <Button
                                                                variant="ghost"
                                                                onClick={() => setEditing(false)}
                                                        >
                                                                Cancel
                                                        </Button>
                                                </div>
                                        </form>
                                ) : (
                                        <Button size="sm" onClick={() => setEditing(true)}>
                                                Change the policy
                                        </Button>
                                ))}
                </section>
        )
}

const STATUS_FILTERS: (AllocationStatus | 'NOT_STARTED')[] = [
        'NOT_STARTED',
        'DRAFT',
        'ADMIN_REVIEW',
        'CHRO_REVIEW',
        'APPROVED',
        'RETURNED',
        'REJECTED',
]

function Units({
        data,
        filters,
        onFilters,
}: {
        data: AllocationOverview
        filters: OverviewFilters
        onFilters: (f: OverviewFilters) => void
}) {
        const plants = new Map(data.units.map((u) => [u.plant.id, u.plant.name]))
        const departments = new Map(data.units.map((u) => [u.department.id, u.department.name]))
        return (
                <section aria-labelledby="units-heading" className="space-y-2">
                        <h2 id="units-heading" className="text-base font-semibold text-slate-900">
                                Departments
                        </h2>
                        <div className="flex flex-wrap items-end gap-3">
                                <div className="w-48">
                                        <SelectField
                                                label="Plant"
                                                value={String(filters.plantId ?? '')}
                                                onChange={(e) =>
                                                        onFilters({
                                                                ...filters,
                                                                plantId:
                                                                        Number(e.target.value) ||
                                                                        undefined,
                                                        })
                                                }
                                                options={[
                                                        { value: '', label: 'All plants' },
                                                        ...[...plants].map(([id, name]) => ({
                                                                value: String(id),
                                                                label: name,
                                                        })),
                                                ]}
                                        />
                                </div>
                                <div className="w-48">
                                        <SelectField
                                                label="Department"
                                                value={String(filters.departmentId ?? '')}
                                                onChange={(e) =>
                                                        onFilters({
                                                                ...filters,
                                                                departmentId:
                                                                        Number(e.target.value) ||
                                                                        undefined,
                                                        })
                                                }
                                                options={[
                                                        { value: '', label: 'All departments' },
                                                        ...[...departments].map(([id, name]) => ({
                                                                value: String(id),
                                                                label: name,
                                                        })),
                                                ]}
                                        />
                                </div>
                                <div className="w-56">
                                        <SelectField
                                                label="Proposal status"
                                                value={filters.status ?? ''}
                                                onChange={(e) =>
                                                        onFilters({
                                                                ...filters,
                                                                status: (e.target.value ||
                                                                        undefined) as OverviewFilters['status'],
                                                        })
                                                }
                                                options={[
                                                        { value: '', label: 'Any status' },
                                                        ...STATUS_FILTERS.map((k) => ({
                                                                value: k,
                                                                label: ALLOCATION_STATUS[k].label,
                                                        })),
                                                ]}
                                        />
                                </div>
                                <CheckboxField
                                        label="Out of date only"
                                        checked={!!filters.staleOnly}
                                        onChange={(e) =>
                                                onFilters({
                                                        ...filters,
                                                        staleOnly: e.target.checked,
                                                })
                                        }
                                />
                        </div>
                        {data.units.length === 0 ? (
                                <p className="text-sm text-slate-700">No department matches.</p>
                        ) : (
                                <Table caption="Department allocations">
                                        <thead>
                                                <tr>
                                                        <Th>Department</Th>
                                                        <Th align="right">Budget</Th>
                                                        <Th align="right">Recommended</Th>
                                                        <Th align="right">Proposed</Th>
                                                        <Th align="right">Approved</Th>
                                                        <Th align="right">Remaining</Th>
                                                        <Th>Status</Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {data.units.map((u) => (
                                                        <UnitRow
                                                                key={`${u.plant.id}-${u.department.id}`}
                                                                cycleId={data.cycle.id}
                                                                unit={u}
                                                        />
                                                ))}
                                        </TBody>
                                </Table>
                        )}
                </section>
        )
}

function UnitRow({ cycleId, unit: u }: { cycleId: number; unit: AllocationUnit }) {
        const navigate = useNavigate()
        const action = useAction()
        const status = ALLOCATION_STATUS[u.latest?.status ?? 'NOT_STARTED']
        const stale = (u.latest?.stale_reasons.length ?? 0) > 0

        async function start() {
                const created = await action.run(() =>
                        startProposal(cycleId, u.plant.id, u.department.id),
                )
                if (created) navigate(`/allocations/proposals/${created.id}`)
        }

        return (
                <tr>
                        <Td>
                                {u.department.name} — {u.plant.name}
                                <div className="text-xs text-slate-600">
                                        {u.included} included · {u.excluded} excluded
                                        {u.suppressed && ' · amounts hidden for small groups'}
                                </div>
                        </Td>
                        <Td align="right">{money(u.distributed)}</Td>
                        <Td align="right">{money(u.recommended)}</Td>
                        <Td align="right">{money(u.proposed)}</Td>
                        <Td align="right">{money(u.approved)}</Td>
                        <Td align="right">{money(u.difference)}</Td>
                        <Td>
                                <Badge tone={status.tone}>{status.label}</Badge>
                                {stale && (
                                        <div className="text-xs font-medium text-amber-900">
                                                Out of date
                                        </div>
                                )}
                                <div className="mt-1 flex flex-wrap gap-2">
                                        {u.latest && (
                                                <Link
                                                        to={`/allocations/proposals/${u.latest.id}`}
                                                        className={linkClasses}
                                                >
                                                        Open version {u.latest.version_no}
                                                </Link>
                                        )}
                                        {u.can_start && (
                                                <Button
                                                        size="sm"
                                                        isLoading={action.busy}
                                                        onClick={start}
                                                >
                                                        {u.latest
                                                                ? 'Start the next version'
                                                                : 'Start the proposal'}
                                                </Button>
                                        )}
                                </div>
                                <ActionError
                                        error={action.error}
                                        title="The proposal was not started"
                                />
                        </Td>
                </tr>
        )
}

function EmployeeReport({ cycleId }: { cycleId: number }) {
        const [search, setSearch] = useState('')
        const [applied, setApplied] = useState('')
        const report = useApiQuery(`allocation-report|${cycleId}|${applied}`, (signal) =>
                getAllocationReport(cycleId, { search: applied }, signal),
        )
        return (
                <section aria-labelledby="report-heading" className="space-y-2">
                        <h2 id="report-heading" className="text-base font-semibold text-slate-900">
                                Employees (latest version of each department)
                        </h2>
                        <form
                                className="flex flex-wrap items-end gap-2"
                                onSubmit={(e) => {
                                        e.preventDefault()
                                        setApplied(search.trim())
                                }}
                        >
                                <div className="w-64">
                                        <TextField
                                                label="Search employees"
                                                value={search}
                                                onChange={(e) => setSearch(e.target.value)}
                                        />
                                </div>
                                <Button type="submit">Search</Button>
                        </form>
                        {report.isLoading ? (
                                <LoadingState label="Loading employees…" />
                        ) : report.error !== undefined || !report.data ? (
                                <ErrorState error={report.error} onRetry={report.reload} />
                        ) : report.data.length === 0 ? (
                                <p className="text-sm text-slate-700">No proposal lines yet.</p>
                        ) : (
                                <Table caption="Employee allocations">
                                        <thead>
                                                <tr>
                                                        <Th>Employee</Th>
                                                        <Th align="right">Recommended</Th>
                                                        <Th align="right">Proposed</Th>
                                                        <Th align="right">Difference</Th>
                                                        <Th>Status</Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {report.data.map((x) => (
                                                        <tr
                                                                key={`${x.proposal_id}-${x.employee.id}`}
                                                        >
                                                                <Td>
                                                                        {x.employee.full_name}
                                                                        <div className="text-xs text-slate-600">
                                                                                {
                                                                                        x.employee
                                                                                                .employee_code
                                                                                }{' '}
                                                                                ·{' '}
                                                                                {x.department.name}{' '}
                                                                                — {x.plant.name}
                                                                        </div>
                                                                </Td>
                                                                <Td align="right">
                                                                        {x.recommended_percent} %
                                                                        <div className="text-xs text-slate-600">
                                                                                {money(
                                                                                        x.recommended_amount,
                                                                                )}
                                                                        </div>
                                                                </Td>
                                                                <Td align="right">
                                                                        {x.proposed_percent} %
                                                                        <div className="text-xs text-slate-600">
                                                                                {money(
                                                                                        x.proposed_amount,
                                                                                )}
                                                                        </div>
                                                                </Td>
                                                                <Td align="right">
                                                                        {money(x.difference)}
                                                                        {x.reason && (
                                                                                <div className="text-xs text-slate-600">
                                                                                        {x.reason}
                                                                                </div>
                                                                        )}
                                                                </Td>
                                                                <Td>
                                                                        <Link
                                                                                to={`/allocations/proposals/${x.proposal_id}`}
                                                                                className={
                                                                                        linkClasses
                                                                                }
                                                                        >
                                                                                {
                                                                                        ALLOCATION_STATUS[
                                                                                                x
                                                                                                        .status
                                                                                        ].label
                                                                                }{' '}
                                                                                (v{x.version_no})
                                                                        </Link>
                                                                        {x.stale && (
                                                                                <div className="text-xs text-amber-900">
                                                                                        Out of date
                                                                                </div>
                                                                        )}
                                                                </Td>
                                                        </tr>
                                                ))}
                                        </TBody>
                                </Table>
                        )}
                </section>
        )
}
