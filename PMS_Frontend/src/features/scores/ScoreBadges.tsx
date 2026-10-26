import { Badge } from '../../components/common/Badge'
import type { ResultItemStatus, ScoreOverrideStatus, ScoreResultStatus } from '../../types/api'
import { ITEM_STATUS, OVERRIDE_STATUS, RESULT_STATUS } from './scoreLabels'

export function ResultStatusBadge({ status }: { status: ScoreResultStatus | null }) {
        if (status === null) return <Badge>Not calculated</Badge>
        const { label, tone } = RESULT_STATUS[status]
        return <Badge tone={tone}>{label}</Badge>
}

export function ItemStatusBadge({ status }: { status: ResultItemStatus }) {
        const { label, tone } = ITEM_STATUS[status]
        return <Badge tone={tone}>{label}</Badge>
}

export function OverrideStatusBadge({ status }: { status: ScoreOverrideStatus }) {
        const { label, tone } = OVERRIDE_STATUS[status]
        return <Badge tone={tone}>{label}</Badge>
}
