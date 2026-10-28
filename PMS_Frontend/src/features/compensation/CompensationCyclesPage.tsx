import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { createCompensationCycle, listCompensationCycles } from '../../services/compensationApi'
import { formatDate } from '../../utils/format'
import { useCurrentUser } from '../auth/AuthContext'
import { canManageCompensation } from '../auth/permissions'
import { CycleForm } from './CycleForm'
import { CR_METHOD } from './compensationLabels'

/** /compensation */
export function CompensationCyclesPage() {
        const user = useCurrentUser()
        const navigate = useNavigate()
        const cycles = useApiQuery('compensation-cycles', (signal) =>
                listCompensationCycles(signal),
        )
        const [creating, setCreating] = useState(false)
        const manager = canManageCompensation(user)
        return (
                <>
                        <PageHeader
                                title="Compensation & budget"
                                description="Compensation cycles: the salary baseline, increment proposals calculated with approved matrices, the company-approved budget and the CHRO's final decision. Increment amounts are never changed to fit a budget."
                                actions={
                                        manager && !creating ? (
                                                <Button
                                                        variant="primary"
                                                        onClick={() => setCreating(true)}
                                                >
                                                        <Plus
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        New compensation cycle
                                                </Button>
                                        ) : undefined
                                }
                        />
                        <div className="space-y-4">
                                {creating && (
                                        <CycleForm
                                                submitLabel="Create the cycle"
                                                onCancel={() => setCreating(false)}
                                                onSubmit={(body) => createCompensationCycle(body)}
                                                onSaved={(cycle) =>
                                                        navigate(`/compensation/cycles/${cycle.id}`)
                                                }
                                        />
                                )}
                                {cycles.isLoading ? (
                                        <LoadingState label="Loading compensation cycles…" />
                                ) : cycles.error !== undefined || !cycles.data ? (
                                        <ErrorState error={cycles.error} onRetry={cycles.reload} />
                                ) : cycles.data.length === 0 ? (
                                        <EmptyState title="No compensation cycle yet">
                                                An HR Head sets one up for a PMS cycle whose annual
                                                results are approved.
                                        </EmptyState>
                                ) : (
                                        <Table caption="Compensation cycles">
                                                <thead>
                                                        <tr>
                                                                <Th>Cycle</Th>
                                                                <Th>Annual results from</Th>
                                                                <Th>Effective</Th>
                                                                <Th>Compa-ratio method</Th>
                                                                <Th>Status</Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {cycles.data.map((c) => (
                                                                <tr key={c.id}>
                                                                        <Td>
                                                                                <Link
                                                                                        to={`/compensation/cycles/${c.id}`}
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
                                                                        <Td>{c.pms_cycle.name}</Td>
                                                                        <Td>
                                                                                {formatDate(
                                                                                        c.effective_date,
                                                                                )}
                                                                        </Td>
                                                                        <Td>
                                                                                {
                                                                                        CR_METHOD[
                                                                                                c
                                                                                                        .cr_method
                                                                                        ].label
                                                                                }
                                                                        </Td>
                                                                        <Td>
                                                                                <Badge
                                                                                        tone={
                                                                                                c.status ===
                                                                                                'FINALIZED'
                                                                                                        ? 'success'
                                                                                                        : 'neutral'
                                                                                        }
                                                                                >
                                                                                        {c.status ===
                                                                                        'FINALIZED'
                                                                                                ? 'Finalized'
                                                                                                : 'Open'}
                                                                                </Badge>
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
