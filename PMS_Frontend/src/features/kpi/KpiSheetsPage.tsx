import { FileSpreadsheet, Lock, Search } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { AssignmentTypeBadge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { SelectField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import {
        buttonClasses,
        cardClasses,
        inputClasses,
        linkClasses,
} from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import {
        createSheet,
        listQuarters,
        listSheets,
        startScoring,
        type SheetListParams,
} from '../../services/kpiApi'
import { listOrgUnits } from '../../services/organizationApi'
import type { OrgUnit, Quarter, SheetRow, StartScoringResult } from '../../types/api'
import { plural } from '../../utils/format'
import { parseId, withParams } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { canStartScoring, canWriteKpi } from '../auth/permissions'
import { OrgFilters } from '../organization/OrgFilters'
import { defaultQuarter, quarterLabel } from './kpiLabels'
import { QuarterStatusBadge, SheetStatusBadge } from './StatusBadges'

export function KpiSheetsPage() {
        const [params, setParams] = useSearchParams()
        const quarters = useApiQuery('quarters', (signal) => listQuarters(signal))
        const units = useApiQuery('org-units', (signal) => listOrgUnits({}, signal))

        if (quarters.isLoading) return <LoadingState label="Loading quarters…" />
        if (quarters.error !== undefined || !quarters.data)
                return <ErrorState error={quarters.error} onRetry={quarters.reload} />
        if (quarters.data.length === 0) {
                return (
                        <>
                                <PageHeader title="Quarterly KPI sheets" />
                                <EmptyState title="No PMS cycle has been set up yet" />
                        </>
                )
        }
        const chosen = parseId(params.get('quarter'))
        const quarter = quarters.data.find((q) => q.id === chosen) ?? defaultQuarter(quarters.data)!

        return (
                <SheetsForQuarter
                        quarters={quarters.data}
                        quarter={quarter}
                        units={units.data}
                        onQuarterStarted={quarters.reload}
                        params={params}
                        setParams={setParams}
                />
        )
}

interface SheetsProps {
        quarters: Quarter[]
        quarter: Quarter
        units: OrgUnit[] | undefined
        onQuarterStarted: () => void
        params: URLSearchParams
        setParams: (params: URLSearchParams) => void
}

function SheetsForQuarter({
        quarters,
        quarter,
        units,
        onQuarterStarted,
        params,
        setParams,
}: SheetsProps) {
        const user = useCurrentUser()
        const navigate = useNavigate()
        const [started, setStarted] = useState<StartScoringResult | null>(null)
        const request: SheetListParams = {
                quarterId: quarter.id,
                plantId: parseId(params.get('plant_id')),
                departmentId: parseId(params.get('department_id')),
                search: (params.get('q') ?? '').trim() || undefined,
        }
        const sheets = useApiQuery(
                `sheets|${JSON.stringify(request)}|${quarter.status}`,
                (signal) => listSheets(request, signal),
                { keepPreviousData: true },
        )
        const create = useAction()
        const configurable = quarter.status === 'DRAFT'

        async function handleCreate(row: SheetRow) {
                const sheet = await create.run(() =>
                        createSheet({
                                assignment_id: row.assignment.id,
                                quarter_id: quarter.id,
                        }),
                )
                if (sheet) navigate(`/kpi/sheets/${sheet.id}`)
        }

        function handleSearch(event: FormEvent<HTMLFormElement>) {
                event.preventDefault()
                const value = new FormData(event.currentTarget).get('q')
                setParams(
                        withParams(params, {
                                q: typeof value === 'string' ? value.trim() : '',
                        }),
                )
        }

        const rows = sheets.data?.rows ?? []
        const counts = {
                none: rows.filter((r) => r.sheet === null).length,
                draft: rows.filter((r) => r.sheet?.status === 'DRAFT').length,
                done: rows.filter((r) => r.sheet && r.sheet.status !== 'DRAFT').length,
        }

        return (
                <>
                        <PageHeader
                                title="Quarterly KPI sheets"
                                description="Each employee assignment has one KPI sheet per quarter: KPIs, weightages totalling 100% and quarterly targets. An employee working in two plants has a separate sheet for each."
                                meta={<QuarterStatusBadge status={quarter.status} />}
                                actions={
                                        canWriteKpi(user) &&
                                        configurable && (
                                                <Link
                                                        to={`/kpi/upload?quarter=${quarter.id}`}
                                                        className={buttonClasses('secondary')}
                                                >
                                                        <FileSpreadsheet
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        Upload from Excel
                                                </Link>
                                        )
                                }
                        />

                        <section
                                aria-label="Filters"
                                className={`${cardClasses} mb-4 space-y-4 p-4`}
                        >
                                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                                        <div className="sm:col-span-2">
                                                <SelectField
                                                        label="Quarter"
                                                        value={String(quarter.id)}
                                                        onChange={(e) =>
                                                                setParams(
                                                                        withParams(params, {
                                                                                quarter: e.target
                                                                                        .value,
                                                                        }),
                                                                )
                                                        }
                                                        options={quarters.map((q) => ({
                                                                value: String(q.id),
                                                                label: quarterLabel(q),
                                                        }))}
                                                />
                                        </div>
                                        <OrgFilters
                                                units={units ?? []}
                                                plantId={request.plantId}
                                                departmentId={request.departmentId}
                                                disabled={units === undefined}
                                                onChange={({ plantId, departmentId }) =>
                                                        setParams(
                                                                withParams(params, {
                                                                        plant_id: plantId,
                                                                        department_id: departmentId,
                                                                }),
                                                        )
                                                }
                                        />
                                </div>
                                <form
                                        role="search"
                                        onSubmit={handleSearch}
                                        className="flex max-w-md items-end gap-2"
                                >
                                        <div className="flex-1 space-y-1">
                                                <label
                                                        htmlFor="sheet-search"
                                                        className="block text-sm font-medium text-slate-800"
                                                >
                                                        Search by employee code or name
                                                </label>
                                                <div className="relative">
                                                        <Search
                                                                aria-hidden="true"
                                                                className="pointer-events-none absolute top-3 left-3 size-4 text-slate-400"
                                                        />
                                                        <input
                                                                key={request.search ?? ''}
                                                                id="sheet-search"
                                                                name="q"
                                                                type="search"
                                                                maxLength={100}
                                                                defaultValue={request.search ?? ''}
                                                                className={`${inputClasses} pl-9`}
                                                        />
                                                </div>
                                        </div>
                                        <Button type="submit">Search</Button>
                                </form>
                        </section>

                        {started && started.quarter.id === quarter.id && (
                                <div className="mb-4">
                                        <Alert
                                                title={`Scoring started for ${started.quarter.name}`}
                                        >
                                                {plural(started.locked_sheets, 'published sheet')}{' '}
                                                locked.
                                                {started.unpublished_sheets > 0 &&
                                                        ` ${plural(started.unpublished_sheets, 'draft sheet')} had not been published and cannot be scored.`}
                                        </Alert>
                                </div>
                        )}
                        {!configurable && (
                                <div className="mb-4">
                                        <Alert
                                                tone="info"
                                                title={`Scoring has started for ${quarter.name}`}
                                        >
                                                Published KPI sheets are locked. A change now needs
                                                a deviation approved by both the HR Head and the
                                                Plant Head.
                                        </Alert>
                                </div>
                        )}
                        {canStartScoring(user) && configurable && (
                                <StartScoring
                                        quarter={quarter}
                                        drafts={counts.draft + counts.none}
                                        onStarted={(result) => {
                                                setStarted(result)
                                                onQuarterStarted()
                                        }}
                                />
                        )}
                        <div className="mb-4">
                                <ActionError
                                        error={create.error}
                                        title="The sheet could not be created"
                                />
                        </div>

                        {sheets.isLoading ? (
                                <LoadingState label="Loading KPI sheets…" />
                        ) : sheets.error !== undefined || !sheets.data ? (
                                <ErrorState error={sheets.error} onRetry={sheets.reload} />
                        ) : rows.length === 0 ? (
                                <EmptyState title="No employees in this view">
                                        No employee assignment in your access is active during{' '}
                                        {quarter.name}.
                                </EmptyState>
                        ) : (
                                <>
                                        <p
                                                className="mb-2 text-sm text-slate-600"
                                                aria-live="polite"
                                        >
                                                {sheets.isStale
                                                        ? 'Updating…'
                                                        : `${plural(rows.length, 'assignment')}: ${counts.done} published or locked, ${counts.draft} draft, ${counts.none} without a sheet.`}
                                        </p>
                                        <Table
                                                caption={`KPI sheets for ${quarter.name}`}
                                                busy={sheets.isStale}
                                        >
                                                <thead>
                                                        <tr>
                                                                <Th>Employee</Th>
                                                                <Th>Assignment</Th>
                                                                <Th>Sheet</Th>
                                                                <Th align="right">KPIs</Th>
                                                                <Th align="right">Weightage</Th>
                                                                <Th>
                                                                        <span className="sr-only">
                                                                                Action
                                                                        </span>
                                                                </Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {rows.map((row) => (
                                                                <SheetListRow
                                                                        key={row.assignment.id}
                                                                        row={row}
                                                                        canCreate={
                                                                                canWriteKpi(user) &&
                                                                                configurable
                                                                        }
                                                                        busy={create.busy}
                                                                        onCreate={() =>
                                                                                handleCreate(row)
                                                                        }
                                                                />
                                                        ))}
                                                </TBody>
                                        </Table>
                                </>
                        )}
                </>
        )
}

function SheetListRow({
        row,
        canCreate,
        busy,
        onCreate,
}: {
        row: SheetRow
        canCreate: boolean
        busy: boolean
        onCreate: () => void
}) {
        const { assignment, sheet } = row
        const offTotal =
                sheet !== null && sheet.item_count > 0 && Math.round(sheet.total * 100) !== 10_000
        return (
                <tr>
                        <Td className="min-w-44">
                                <span className="font-medium">{assignment.employee.full_name}</span>
                                <p className="font-mono text-xs text-slate-600">
                                        {assignment.employee.employee_code}
                                </p>
                        </Td>
                        <Td className="min-w-56">
                                <div className="flex flex-wrap items-center gap-2">
                                        <AssignmentTypeBadge primary={assignment.is_primary} />
                                        <span>
                                                {assignment.department.name} —{' '}
                                                {assignment.plant.name}
                                        </span>
                                </div>
                                <p className="text-xs text-slate-600">
                                        {assignment.designation.name}
                                </p>
                        </Td>
                        <Td>
                                {sheet ? (
                                        <SheetStatusBadge status={sheet.status} />
                                ) : (
                                        <span className="text-slate-600">No sheet</span>
                                )}
                        </Td>
                        <Td align="right">{sheet ? sheet.item_count : '—'}</Td>
                        <Td align="right" className={offTotal ? 'font-semibold text-red-700' : ''}>
                                {sheet ? `${sheet.total.toFixed(2)}%` : '—'}
                                {offTotal && (
                                        <span className="sr-only"> (does not total 100%)</span>
                                )}
                        </Td>
                        <Td align="right">
                                {sheet ? (
                                        <Link
                                                to={`/kpi/sheets/${sheet.id}`}
                                                className={linkClasses}
                                                aria-label={`Open KPI sheet of ${assignment.employee.full_name}, ${assignment.department.name} — ${assignment.plant.name}`}
                                        >
                                                Open
                                        </Link>
                                ) : (
                                        canCreate && (
                                                <Button
                                                        size="sm"
                                                        disabled={busy}
                                                        onClick={onCreate}
                                                        aria-label={`Create KPI sheet for ${assignment.employee.full_name}, ${assignment.department.name} — ${assignment.plant.name}`}
                                                >
                                                        Create sheet
                                                </Button>
                                        )
                                )}
                        </Td>
                </tr>
        )
}

function StartScoring({
        quarter,
        drafts,
        onStarted,
}: {
        quarter: Quarter
        drafts: number
        onStarted: (result: StartScoringResult) => void
}) {
        const [confirming, setConfirming] = useState(false)
        const action = useAction()

        async function start() {
                const done = await action.run(() => startScoring(quarter.id))
                if (done) onStarted(done)
        }

        return (
                <section aria-label="Start scoring" className={`${cardClasses} mb-4 space-y-3 p-4`}>
                        <ActionError error={action.error} title="Scoring could not be started" />
                        {confirming ? (
                                <>
                                        <p className="text-sm text-slate-800">
                                                Start scoring for <strong>{quarter.name}</strong>{' '}
                                                across the company? Every published KPI sheet will
                                                be locked: KPIs, weightages and targets can then
                                                change only by a deviation approved by both the HR
                                                Head and the Plant Head. This cannot be undone.
                                                {drafts > 0 &&
                                                        ` In this view, ${plural(drafts, 'assignment')} still have no published sheet.`}
                                        </p>
                                        <div className="flex flex-wrap gap-2">
                                                <Button
                                                        variant="danger"
                                                        isLoading={action.busy}
                                                        onClick={start}
                                                >
                                                        <Lock
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        Start scoring and lock KPIs
                                                </Button>
                                                <Button
                                                        variant="ghost"
                                                        disabled={action.busy}
                                                        onClick={() => setConfirming(false)}
                                                >
                                                        Cancel
                                                </Button>
                                        </div>
                                </>
                        ) : (
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                        <p className="text-sm text-slate-700">
                                                When KPI setup is complete, HR starts quarterly
                                                scoring. This locks the quarter’s KPI sheets.
                                        </p>
                                        <Button onClick={() => setConfirming(true)}>
                                                Start scoring for {quarter.name}…
                                        </Button>
                                </div>
                        )}
                </section>
        )
}
