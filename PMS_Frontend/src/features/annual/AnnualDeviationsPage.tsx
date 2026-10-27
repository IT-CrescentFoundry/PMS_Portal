import { Link, useSearchParams } from 'react-router'
import { Badge } from '../../components/common/Badge'
import { SelectField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listAnnualDeviations } from '../../services/annualApi'
import type { AnnualDeviationStatus } from '../../types/api'
import { formatDate } from '../../utils/format'
import { withParams } from '../../utils/params'
import { scoreText } from '../scores/scoreLabels'
import { DEVIATION_STATUS } from './annualLabels'

const STATUSES = Object.keys(DEVIATION_STATUS) as AnnualDeviationStatus[]

/** /annual/deviations */
export function AnnualDeviationsPage() {
        const [params, setParams] = useSearchParams()
        const raw = params.get('status')
        const status =
                raw === 'ALL'
                        ? undefined
                        : ((STATUSES.find((s) => s === raw) ?? 'PENDING') as AnnualDeviationStatus)
        const query = useApiQuery(`annual-deviations|${status ?? 'ALL'}`, (signal) =>
                listAnnualDeviations({ status }, signal),
        )
        return (
                <>
                        <PageHeader
                                title="Annual score deviations"
                                description="Adjustments of calculated annual scores requested by an Admin. Only the CHRO's approval applies one; the calculated score is always kept."
                                breadcrumbs={[
                                        { label: 'Annual results', to: '/annual' },
                                        { label: 'Deviations' },
                                ]}
                        />
                        <div className={`${cardClasses} mb-4 max-w-xs p-4`}>
                                <SelectField
                                        label="Status"
                                        value={status ?? 'ALL'}
                                        onChange={(e) =>
                                                setParams(
                                                        withParams(params, {
                                                                status: e.target.value,
                                                        }),
                                                        { replace: true },
                                                )
                                        }
                                        options={[
                                                ...STATUSES.map((s) => ({
                                                        value: s,
                                                        label: DEVIATION_STATUS[s].label,
                                                })),
                                                { value: 'ALL', label: 'All' },
                                        ]}
                                />
                        </div>
                        {query.isLoading && !query.data ? (
                                <LoadingState label="Loading deviations…" />
                        ) : query.error !== undefined || !query.data ? (
                                <ErrorState error={query.error} onRetry={query.reload} />
                        ) : query.data.length === 0 ? (
                                <EmptyState title="No deviations" />
                        ) : (
                                <Table caption="Annual score deviations">
                                        <thead>
                                                <tr>
                                                        <Th>Employee</Th>
                                                        <Th>Cycle</Th>
                                                        <Th align="right">Original → revised</Th>
                                                        <Th>Status</Th>
                                                        <Th>Requested</Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {query.data.map((d) => (
                                                        <tr key={d.id}>
                                                                <Td>
                                                                        <Link
                                                                                to={`/annual/cycles/${d.cycle_id}/employees/${d.employee.id}`}
                                                                                className={
                                                                                        linkClasses
                                                                                }
                                                                        >
                                                                                {
                                                                                        d.employee
                                                                                                .full_name
                                                                                }
                                                                        </Link>
                                                                        <div className="text-xs text-slate-600">
                                                                                {
                                                                                        d.employee
                                                                                                .employee_code
                                                                                }
                                                                        </div>
                                                                </Td>
                                                                <Td>
                                                                        {d.cycle_name}
                                                                        <div className="text-xs text-slate-600">
                                                                                Version{' '}
                                                                                {d.version_no}
                                                                        </div>
                                                                </Td>
                                                                <Td align="right">
                                                                        {scoreText(
                                                                                d.original_score,
                                                                        )}{' '}
                                                                        →{' '}
                                                                        {scoreText(
                                                                                d.proposed_score,
                                                                        )}
                                                                </Td>
                                                                <Td>
                                                                        <Badge
                                                                                tone={
                                                                                        DEVIATION_STATUS[
                                                                                                d
                                                                                                        .status
                                                                                        ].tone
                                                                                }
                                                                        >
                                                                                {
                                                                                        DEVIATION_STATUS[
                                                                                                d
                                                                                                        .status
                                                                                        ].label
                                                                                }
                                                                        </Badge>
                                                                </Td>
                                                                <Td>
                                                                        {d.requested_by?.username ??
                                                                                '—'}
                                                                        <div className="text-xs text-slate-600">
                                                                                {formatDate(
                                                                                        d.requested_at,
                                                                                )}
                                                                        </div>
                                                                </Td>
                                                        </tr>
                                                ))}
                                        </TBody>
                                </Table>
                        )}
                </>
        )
}
