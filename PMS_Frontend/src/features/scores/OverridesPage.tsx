import { Link, useSearchParams } from 'react-router'
import { SelectField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listOverrides } from '../../services/scoresApi'
import type { ScoreOverrideStatus } from '../../types/api'
import { formatDate } from '../../utils/format'
import { unitLabel } from '../../utils/labels'
import { withParams } from '../../utils/params'
import { OverrideStatusBadge } from './ScoreBadges'
import { OVERRIDE_STATUS, scoreText } from './scoreLabels'

const STATUSES = Object.keys(OVERRIDE_STATUS) as ScoreOverrideStatus[]

/** /scores/overrides */
export function OverridesPage() {
        const [params, setParams] = useSearchParams()
        const raw = params.get('status')
        const status =
                raw === 'ALL' ? undefined : ((raw as ScoreOverrideStatus | null) ?? 'PENDING')
        const overrides = useApiQuery(
                `overrides|${status ?? 'ALL'}`,
                (signal) => listOverrides(status, signal),
                { keepPreviousData: true },
        )
        return (
                <>
                        <PageHeader
                                title="Score overrides"
                                description="Manual changes to a calculated quarterly score. Each needs a reason and the approval of an HR Head and a Plant Head, two different people other than the requester. The calculated score always stays on record."
                        />
                        <div className="space-y-4">
                                <div className={`${cardClasses} max-w-sm p-4`}>
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
                                                                label: OVERRIDE_STATUS[s].label,
                                                        })),
                                                        { value: 'ALL', label: 'All' },
                                                ]}
                                        />
                                </div>
                                {overrides.isLoading ? (
                                        <LoadingState label="Loading overrides…" />
                                ) : overrides.error !== undefined || !overrides.data ? (
                                        <ErrorState
                                                error={overrides.error}
                                                onRetry={overrides.reload}
                                        />
                                ) : overrides.data.length === 0 ? (
                                        <EmptyState title="No overrides" />
                                ) : (
                                        <Table caption="Score overrides" busy={overrides.isStale}>
                                                <thead>
                                                        <tr>
                                                                <Th>Employee</Th>
                                                                <Th className="hidden md:table-cell">
                                                                        Assignment
                                                                </Th>
                                                                <Th>Score</Th>
                                                                <Th>Status</Th>
                                                                <Th className="hidden lg:table-cell">
                                                                        Requested
                                                                </Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {overrides.data.map((o) => (
                                                                <tr key={o.id}>
                                                                        <Td>
                                                                                <Link
                                                                                        to={`/scores/results/${o.sheet_id}`}
                                                                                        className={
                                                                                                linkClasses
                                                                                        }
                                                                                >
                                                                                        {
                                                                                                o
                                                                                                        .employee
                                                                                                        .full_name
                                                                                        }
                                                                                </Link>
                                                                                <div className="text-xs text-slate-600">
                                                                                        {
                                                                                                o
                                                                                                        .employee
                                                                                                        .employee_code
                                                                                        }{' '}
                                                                                        ·{' '}
                                                                                        {
                                                                                                o.quarter_name
                                                                                        }
                                                                                </div>
                                                                        </Td>
                                                                        <Td className="hidden md:table-cell">
                                                                                {unitLabel(
                                                                                        o.department,
                                                                                        o.plant,
                                                                                )}
                                                                        </Td>
                                                                        <Td>
                                                                                {scoreText(
                                                                                        o.original_score,
                                                                                )}{' '}
                                                                                →{' '}
                                                                                {scoreText(
                                                                                        o.proposed_score,
                                                                                )}
                                                                        </Td>
                                                                        <Td>
                                                                                <OverrideStatusBadge
                                                                                        status={
                                                                                                o.status
                                                                                        }
                                                                                />
                                                                        </Td>
                                                                        <Td className="hidden lg:table-cell">
                                                                                {o.requested_by
                                                                                        ?.username ??
                                                                                        '—'}
                                                                                ,{' '}
                                                                                {formatDate(
                                                                                        o.requested_at,
                                                                                )}
                                                                        </Td>
                                                                </tr>
                                                        ))}
                                                </TBody>
                                        </Table>
                                )}
                        </div>
                </>
        )
}
