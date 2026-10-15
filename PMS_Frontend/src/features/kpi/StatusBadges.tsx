import { CheckCircle2, Circle, Lock } from 'lucide-react'
import { Badge } from '../../components/common/Badge'
import type { DeviationStatus, KpiSheetStatus, QuarterStatus, UserRef } from '../../types/api'
import { DEVIATION_STATUS, QUARTER_STATUS, SHEET_STATUS } from './kpiLabels'

export function SheetStatusBadge({ status }: { status: KpiSheetStatus }) {
        const { label, tone } = SHEET_STATUS[status]
        return (
                <Badge tone={tone}>
                        {status === 'LOCKED' && <Lock aria-hidden="true" className="mr-1 size-3" />}
                        {label}
                </Badge>
        )
}

export function QuarterStatusBadge({ status }: { status: QuarterStatus }) {
        const { label, tone } = QUARTER_STATUS[status]
        return <Badge tone={tone}>{label}</Badge>
}

export function DeviationStatusBadge({ status }: { status: DeviationStatus }) {
        const { label, tone } = DEVIATION_STATUS[status]
        return <Badge tone={tone}>{label}</Badge>
}

/** One side of a deviation's dual approval: who approved, or pending. */
export function Approval({ by }: { by: UserRef | null }) {
        return by ? (
                <span className="inline-flex items-center gap-1 text-emerald-800">
                        <CheckCircle2 aria-hidden="true" className="size-4" />
                        {by.username}
                </span>
        ) : (
                <span className="inline-flex items-center gap-1 text-slate-600">
                        <Circle aria-hidden="true" className="size-4" />
                        Pending
                </span>
        )
}
