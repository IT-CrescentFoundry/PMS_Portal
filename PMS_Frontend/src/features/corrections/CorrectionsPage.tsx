import { Link, useSearchParams } from 'react-router'
import { Badge } from '../../components/common/Badge'
import { SelectField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listCorrections } from '../../services/correctionsApi'
import type { CorrectionStatus } from '../../types/api'
import { formatDate } from '../../utils/format'
import { withParams } from '../../utils/params'
import { CORRECTION_STATUS } from '../annual/annualLabels'

const STATUSES = Object.keys(CORRECTION_STATUS) as CorrectionStatus[]

/** /scores/corrections */
export function CorrectionsPage() {
        const [params, setParams] = useSearchParams()
        const raw = params.get('status')
        const status = STATUSES.find((s) => s === raw)
        const query = useApiQuery(`corrections|${status ?? 'ALL'}`, (signal) =>
                listCorrections({ status }, signal),
        )
        return (
                <>
                        <PageHeader
                                title="Quarter corrections"
                                description="Corrections of published quarters. A published quarter never changes: an approved correction becomes a new version, reviewed and published again, and every earlier version stays available."
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
                                                { value: 'ALL', label: 'All' },
                                                ...STATUSES.map((s) => ({
                                                        value: s,
                                                        label: CORRECTION_STATUS[s].label,
                                                })),
                                        ]}
                                />
                        </div>
                        {query.isLoading && !query.data ? (
                                <LoadingState label="Loading corrections…" />
                        ) : query.error !== undefined || !query.data ? (
                                <ErrorState error={query.error} onRetry={query.reload} />
                        ) : query.data.length === 0 ? (
                                <EmptyState title="No corrections">
                                        An HR Head requests a correction from the overview of a
                                        published quarter.
                                </EmptyState>
                        ) : (
                                <Table caption="Corrections of published quarters">
                                        <thead>
                                                <tr>
                                                        <Th>Correction</Th>
                                                        <Th>Quarter</Th>
                                                        <Th>Status</Th>
                                                        <Th>Version</Th>
                                                        <Th>Requested</Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {query.data.map((c) => (
                                                        <tr key={c.id}>
                                                                <Td>
                                                                        <Link
                                                                                to={`/scores/corrections/${c.id}`}
                                                                                className={
                                                                                        linkClasses
                                                                                }
                                                                        >
                                                                                Correction {c.id}
                                                                        </Link>
                                                                        <div className="max-w-md truncate text-xs text-slate-600">
                                                                                {c.reason}
                                                                        </div>
                                                                </Td>
                                                                <Td>{c.quarter.name}</Td>
                                                                <Td>
                                                                        <Badge
                                                                                tone={
                                                                                        CORRECTION_STATUS[
                                                                                                c
                                                                                                        .status
                                                                                        ].tone
                                                                                }
                                                                        >
                                                                                {
                                                                                        CORRECTION_STATUS[
                                                                                                c
                                                                                                        .status
                                                                                        ].label
                                                                                }
                                                                        </Badge>
                                                                </Td>
                                                                <Td>
                                                                        {c.version_no
                                                                                ? `Version ${c.version_no}`
                                                                                : `From version ${c.base_version}`}
                                                                </Td>
                                                                <Td>
                                                                        {c.requested_by?.username ??
                                                                                '—'}
                                                                        <div className="text-xs text-slate-600">
                                                                                {formatDate(
                                                                                        c.requested_at,
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
