import { Link } from 'react-router'
import { Badge } from '../../components/common/Badge'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listAllocationCycles } from '../../services/allocationApi'
import { formatDate } from '../../utils/format'

/** /allocations */
export function AllocationCyclesPage() {
        const cycles = useApiQuery('allocation-cycles', (signal) => listAllocationCycles(signal))
        return (
                <>
                        <PageHeader
                                title="Increment allocations"
                                description="After the CHRO approves a company budget, the budget owner distributes it to plants and departments, departments propose their employees' increments from the matrix recommendations, an Admin reviews them and the CHRO approves them."
                        />
                        {cycles.isLoading ? (
                                <LoadingState label="Loading compensation cycles…" />
                        ) : cycles.error !== undefined || !cycles.data ? (
                                <ErrorState error={cycles.error} onRetry={cycles.reload} />
                        ) : cycles.data.length === 0 ? (
                                <EmptyState title="No compensation cycle yet">
                                        Allocation starts once a company budget is approved.
                                </EmptyState>
                        ) : (
                                <Table caption="Compensation cycles">
                                        <thead>
                                                <tr>
                                                        <Th>Cycle</Th>
                                                        <Th>Effective</Th>
                                                        <Th>Company budget</Th>
                                                        <Th>Distribution</Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {cycles.data.map((c) => (
                                                        <tr key={c.id}>
                                                                <Td>
                                                                        <Link
                                                                                to={`/allocations/cycles/${c.id}`}
                                                                                className={
                                                                                        linkClasses
                                                                                }
                                                                        >
                                                                                {c.name}
                                                                        </Link>
                                                                        <div className="text-xs text-slate-600">
                                                                                {c.code} ·{' '}
                                                                                {c.currency}
                                                                        </div>
                                                                </Td>
                                                                <Td>
                                                                        {formatDate(
                                                                                c.effective_date,
                                                                        )}
                                                                </Td>
                                                                <Td>
                                                                        {c.budget_finalized ? (
                                                                                <Badge tone="success">
                                                                                        Approved
                                                                                </Badge>
                                                                        ) : c.revision_no > 0 ? (
                                                                                <Badge tone="warning">
                                                                                        Revision{' '}
                                                                                        {
                                                                                                c.revision_no
                                                                                        }{' '}
                                                                                        in progress
                                                                                </Badge>
                                                                        ) : (
                                                                                <Badge tone="neutral">
                                                                                        Not approved
                                                                                        yet
                                                                                </Badge>
                                                                        )}
                                                                </Td>
                                                                <Td>
                                                                        {c.distribution_version
                                                                                ? `Version ${c.distribution_version} published`
                                                                                : 'Not published'}
                                                                </Td>
                                                        </tr>
                                                ))}
                                        </TBody>
                                </Table>
                        )}
                </>
        )
}
