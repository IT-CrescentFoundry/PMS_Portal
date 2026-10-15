import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { ReasonForm } from '../../components/common/ReasonForm'
import { buttonClasses, cardClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { approveDeviation, getDeviation, rejectDeviation } from '../../services/kpiApi'
import type { ApproverSide, Deviation, DeviationItem } from '../../types/api'
import { formatDate } from '../../utils/format'
import { parseId } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { canApproveDeviationAsHR, canApproveDeviationAsPlant } from '../auth/permissions'
import { InvalidLink } from '../common/InvalidLink'
import { Approval, DeviationStatusBadge } from './StatusBadges'

export function DeviationDetailPage() {
        const deviationId = parseId(useParams().deviationId)
        const query = useApiQuery(
                deviationId === undefined ? null : `deviation|${deviationId}`,
                (signal) => getDeviation(deviationId!, signal),
        )
        if (deviationId === undefined)
                return <InvalidLink backTo="/kpi/deviations" backLabel="Back to deviations" />
        if (query.isLoading) return <LoadingState label="Loading deviation…" />
        if (query.error !== undefined || !query.data) {
                return (
                        <>
                                <PageHeader
                                        title="KPI deviation"
                                        breadcrumbs={[
                                                {
                                                        label: 'Deviations',
                                                        to: '/kpi/deviations',
                                                },
                                                { label: 'Deviation' },
                                        ]}
                                />
                                <ErrorState error={query.error} onRetry={query.reload} />
                        </>
                )
        }
        return <DeviationView key={query.data.id} initial={query.data} />
}

function DeviationView({ initial }: { initial: Deviation }) {
        const user = useCurrentUser()
        const [deviation, setDeviation] = useState(initial)
        const [rejecting, setRejecting] = useState(false)
        const action = useAction()
        const pending = deviation.status === 'PENDING'
        const isRequester = deviation.requested_by?.id === user.id
        const alreadyApproved = [
                deviation.hr_approved_by?.id,
                deviation.plant_approved_by?.id,
        ].includes(user.id)
        const canAct = pending && !isRequester
        const canHR =
                canAct &&
                !alreadyApproved &&
                deviation.hr_approved_by === null &&
                canApproveDeviationAsHR(user)
        const canPlant =
                canAct &&
                !alreadyApproved &&
                deviation.plant_approved_by === null &&
                canApproveDeviationAsPlant(user)
        const canReject =
                canAct && (canApproveDeviationAsHR(user) || canApproveDeviationAsPlant(user))

        async function approve(side: ApproverSide) {
                const updated = await action.run(() => approveDeviation(deviation.id, side))
                if (updated) setDeviation(updated)
        }

        async function reject(reason: string) {
                const updated = await action.run(() => rejectDeviation(deviation.id, reason))
                if (updated) {
                        setRejecting(false)
                        setDeviation(updated)
                }
        }

        return (
                <>
                        <PageHeader
                                title={`Deviation for ${deviation.employee.full_name}`}
                                breadcrumbs={[
                                        {
                                                label: 'Deviations',
                                                to: '/kpi/deviations',
                                        },
                                        {
                                                label: `${deviation.employee.employee_code} · ${deviation.quarter_name}`,
                                        },
                                ]}
                                meta={
                                        <>
                                                <DeviationStatusBadge status={deviation.status} />
                                                <span className="text-sm text-slate-700">
                                                        {deviation.department.name} —{' '}
                                                        {deviation.plant.name} ·{' '}
                                                        {deviation.quarter_name}
                                                </span>
                                        </>
                                }
                                actions={
                                        <Link
                                                to={`/kpi/sheets/${deviation.sheet_id}`}
                                                className={buttonClasses('secondary')}
                                        >
                                                Open the KPI sheet
                                        </Link>
                                }
                        />
                        <div className="space-y-4">
                                {deviation.status === 'APPLIED' && (
                                        <Alert
                                                title={`Applied on ${formatDate(deviation.applied_at)}`}
                                        >
                                                Both approvals were given; the KPI sheet now carries
                                                the revised KPIs and stays locked.
                                        </Alert>
                                )}
                                {deviation.status === 'REJECTED' && (
                                        <Alert
                                                tone="warning"
                                                title={`Rejected by ${deviation.rejected_by?.username ?? '—'} on ${formatDate(deviation.rejected_at)}`}
                                        >
                                                {deviation.rejection_reason}
                                        </Alert>
                                )}

                                <section
                                        aria-labelledby="reason-heading"
                                        className={`${cardClasses} space-y-2 p-4`}
                                >
                                        <h2
                                                id="reason-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Reason
                                        </h2>
                                        <p className="text-sm whitespace-pre-line text-slate-800">
                                                {deviation.reason}
                                        </p>
                                        <p className="text-xs text-slate-600">
                                                Requested by{' '}
                                                {deviation.requested_by?.username ?? '—'} on{' '}
                                                {formatDate(deviation.requested_at)}
                                        </p>
                                </section>

                                <Comparison
                                        original={deviation.original_items}
                                        proposed={deviation.proposed_items}
                                />

                                <section
                                        aria-labelledby="approvals-heading"
                                        className={`${cardClasses} space-y-3 p-4`}
                                >
                                        <h2
                                                id="approvals-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Approvals
                                        </h2>
                                        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                                <div>
                                                        <dt className="text-sm font-medium text-slate-700">
                                                                HR Head
                                                        </dt>
                                                        <dd className="text-sm">
                                                                <Approval
                                                                        by={
                                                                                deviation.hr_approved_by
                                                                        }
                                                                />
                                                                {deviation.hr_approved_at && (
                                                                        <span className="ml-2 text-slate-600">
                                                                                {formatDate(
                                                                                        deviation.hr_approved_at,
                                                                                )}
                                                                        </span>
                                                                )}
                                                        </dd>
                                                </div>
                                                <div>
                                                        <dt className="text-sm font-medium text-slate-700">
                                                                Plant Head
                                                        </dt>
                                                        <dd className="text-sm">
                                                                <Approval
                                                                        by={
                                                                                deviation.plant_approved_by
                                                                        }
                                                                />
                                                                {deviation.plant_approved_at && (
                                                                        <span className="ml-2 text-slate-600">
                                                                                {formatDate(
                                                                                        deviation.plant_approved_at,
                                                                                )}
                                                                        </span>
                                                                )}
                                                        </dd>
                                                </div>
                                        </dl>
                                        <ActionError
                                                error={action.error}
                                                title="The decision was not recorded"
                                        />
                                        {pending && isRequester && (
                                                <p className="text-sm text-slate-600">
                                                        You requested this deviation, so you cannot
                                                        approve or reject it.
                                                </p>
                                        )}
                                        {pending && alreadyApproved && !isRequester && (
                                                <p className="text-sm text-slate-600">
                                                        You have approved one side; the other
                                                        approval must come from a different person.
                                                </p>
                                        )}
                                        {(canHR || canPlant || canReject) && !rejecting && (
                                                <div className="flex flex-wrap gap-2">
                                                        {canHR && (
                                                                <Button
                                                                        variant="primary"
                                                                        isLoading={action.busy}
                                                                        onClick={() =>
                                                                                approve('HR_HEAD')
                                                                        }
                                                                >
                                                                        Approve as HR Head
                                                                </Button>
                                                        )}
                                                        {canPlant && (
                                                                <Button
                                                                        variant="primary"
                                                                        isLoading={action.busy}
                                                                        onClick={() =>
                                                                                approve(
                                                                                        'PLANT_HEAD',
                                                                                )
                                                                        }
                                                                >
                                                                        Approve as Plant Head
                                                                </Button>
                                                        )}
                                                        {canReject && (
                                                                <Button
                                                                        variant="danger"
                                                                        disabled={action.busy}
                                                                        onClick={() =>
                                                                                setRejecting(true)
                                                                        }
                                                                >
                                                                        Reject…
                                                                </Button>
                                                        )}
                                                </div>
                                        )}
                                        {rejecting && (
                                                <ReasonForm
                                                        label="Reason for rejecting"
                                                        submitLabel="Reject deviation"
                                                        tone="danger"
                                                        busy={action.busy}
                                                        onSubmit={reject}
                                                        onCancel={() => setRejecting(false)}
                                                />
                                        )}
                                </section>
                        </div>
                </>
        )
}

const sameItem = (a: DeviationItem | undefined, b: DeviationItem | undefined) =>
        a !== undefined &&
        b !== undefined &&
        Number(a.weightage) === Number(b.weightage) &&
        Number(a.target_value ?? 0) === Number(b.target_value ?? 0) &&
        (a.target_note ?? '') === (b.target_note ?? '')

/** Side-by-side original and proposed KPIs; changed rows are marked. */
function Comparison({
        original,
        proposed,
}: {
        original: DeviationItem[]
        proposed: DeviationItem[]
}) {
        const ids = [...new Set([...original, ...proposed].map((i) => i.kpi_definition_id))]
        const find = (items: DeviationItem[], id: number) =>
                items.find((i) => i.kpi_definition_id === id)
        const total = (items: DeviationItem[]) =>
                items.reduce((sum, i) => sum + Math.round(Number(i.weightage) * 100), 0) / 100
        const show = (item: DeviationItem | undefined) =>
                item
                        ? `${Number(item.weightage).toFixed(2)}% · target ${item.target_value === null ? '—' : Number(item.target_value)}`
                        : 'Not on the sheet'

        return (
                <section aria-labelledby="compare-heading" className="space-y-2">
                        <h2 id="compare-heading" className="text-base font-semibold text-slate-900">
                                Current and proposed KPIs
                        </h2>
                        <Table caption="Current and proposed KPIs">
                                <thead>
                                        <tr>
                                                <Th>KPI</Th>
                                                <Th>Current</Th>
                                                <Th>Proposed</Th>
                                                <Th>
                                                        <span className="sr-only">Change</span>
                                                </Th>
                                        </tr>
                                </thead>
                                <TBody>
                                        {ids.map((id) => {
                                                const before = find(original, id)
                                                const after = find(proposed, id)
                                                const changed = !sameItem(before, after)
                                                return (
                                                        <tr
                                                                key={id}
                                                                className={
                                                                        changed ? 'bg-amber-50' : ''
                                                                }
                                                        >
                                                                <Td>
                                                                        {after?.kpi ??
                                                                                before?.kpi ??
                                                                                `KPI ${id}`}
                                                                </Td>
                                                                <Td>{show(before)}</Td>
                                                                <Td>{show(after)}</Td>
                                                                <Td>
                                                                        {changed && (
                                                                                <span className="text-xs font-semibold text-amber-900">
                                                                                        {before ===
                                                                                        undefined
                                                                                                ? 'Added'
                                                                                                : after ===
                                                                                                    undefined
                                                                                                  ? 'Removed'
                                                                                                  : 'Changed'}
                                                                                </span>
                                                                        )}
                                                                </Td>
                                                        </tr>
                                                )
                                        })}
                                </TBody>
                                <tfoot className="border-t border-slate-200 bg-slate-50">
                                        <tr>
                                                <th
                                                        scope="row"
                                                        className="px-4 py-3 text-left text-sm font-semibold"
                                                >
                                                        Total weightage
                                                </th>
                                                <td className="px-4 py-3 text-sm font-semibold tabular-nums">
                                                        {total(original).toFixed(2)}%
                                                </td>
                                                <td className="px-4 py-3 text-sm font-semibold tabular-nums">
                                                        {total(proposed).toFixed(2)}%
                                                </td>
                                                <td />
                                        </tr>
                                </tfoot>
                        </Table>
                </section>
        )
}
