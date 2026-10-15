import { Link, useSearchParams } from 'react-router'
import { SelectField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listDeviations } from '../../services/kpiApi'
import type { DeviationStatus } from '../../types/api'
import { formatDate } from '../../utils/format'
import { withParams } from '../../utils/params'
import { DEVIATION_STATUS } from './kpiLabels'
import { Approval, DeviationStatusBadge } from './StatusBadges'

const STATUSES = Object.keys(DEVIATION_STATUS) as DeviationStatus[]

export function DeviationsPage() {
        const [params, setParams] = useSearchParams()
        const raw = params.get('status')
        // Pending by default; "all" shows every status.
        const status: DeviationStatus | undefined =
                raw === 'all'
                        ? undefined
                        : STATUSES.includes(raw as DeviationStatus)
                          ? (raw as DeviationStatus)
                          : 'PENDING'
        const deviations = useApiQuery(
                `deviations|${status ?? 'all'}`,
                (signal) => listDeviations(status, signal),
                { keepPreviousData: true },
        )

        return (
                <>
                        <PageHeader
                                title="KPI deviations"
                                description="Changes to a locked KPI sheet after scoring has started. Each needs approval from both the HR Head and the Plant Head (two different people, neither of them the requester); it applies only once both have approved."
                        />
                        <section aria-label="Filters" className={`${cardClasses} mb-4 p-4`}>
                                <div className="max-w-xs">
                                        <SelectField
                                                label="Status"
                                                value={status ?? 'all'}
                                                onChange={(e) =>
                                                        setParams(
                                                                withParams(params, {
                                                                        status: e.target.value,
                                                                }),
                                                        )
                                                }
                                                options={[
                                                        ...STATUSES.map((s) => ({
                                                                value: s,
                                                                label: DEVIATION_STATUS[s].label,
                                                        })),
                                                        {
                                                                value: 'all',
                                                                label: 'All',
                                                        },
                                                ]}
                                        />
                                </div>
                        </section>
                        {deviations.isLoading ? (
                                <LoadingState label="Loading deviations…" />
                        ) : deviations.error !== undefined || !deviations.data ? (
                                <ErrorState error={deviations.error} onRetry={deviations.reload} />
                        ) : deviations.data.length === 0 ? (
                                <EmptyState title="No deviations">
                                        {status === 'PENDING'
                                                ? 'Nothing is awaiting approval in your access.'
                                                : 'None found.'}
                                </EmptyState>
                        ) : (
                                <Table caption="KPI deviations" busy={deviations.isStale}>
                                        <thead>
                                                <tr>
                                                        <Th>Employee</Th>
                                                        <Th>Assignment · quarter</Th>
                                                        <Th className="hidden md:table-cell">
                                                                Requested
                                                        </Th>
                                                        <Th>HR Head</Th>
                                                        <Th>Plant Head</Th>
                                                        <Th>Status</Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {deviations.data.map((d) => (
                                                        <tr key={d.id}>
                                                                <Td className="min-w-44">
                                                                        <Link
                                                                                to={`/kpi/deviations/${d.id}`}
                                                                                className={
                                                                                        linkClasses
                                                                                }
                                                                        >
                                                                                {
                                                                                        d.employee
                                                                                                .full_name
                                                                                }
                                                                        </Link>
                                                                        <p className="font-mono text-xs text-slate-600">
                                                                                {
                                                                                        d.employee
                                                                                                .employee_code
                                                                                }
                                                                        </p>
                                                                </Td>
                                                                <Td>
                                                                        {d.department.name} —{' '}
                                                                        {d.plant.name}
                                                                        <p className="text-xs text-slate-600">
                                                                                {d.quarter_name}
                                                                        </p>
                                                                </Td>
                                                                <Td className="hidden md:table-cell">
                                                                        {d.requested_by?.username ??
                                                                                '—'}
                                                                        <p className="text-xs text-slate-600">
                                                                                {formatDate(
                                                                                        d.requested_at,
                                                                                )}
                                                                        </p>
                                                                </Td>
                                                                <Td>
                                                                        <Approval
                                                                                by={
                                                                                        d.hr_approved_by
                                                                                }
                                                                        />
                                                                </Td>
                                                                <Td>
                                                                        <Approval
                                                                                by={
                                                                                        d.plant_approved_by
                                                                                }
                                                                        />
                                                                </Td>
                                                                <Td>
                                                                        <DeviationStatusBadge
                                                                                status={d.status}
                                                                        />
                                                                </Td>
                                                        </tr>
                                                ))}
                                        </TBody>
                                </Table>
                        )}
                </>
        )
}
