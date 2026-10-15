import { Badge } from '../../components/common/Badge'
import type { JDVersionSummary } from '../../types/api'
import { JD_STATUS } from './jdLabels'

export function JDStatusBadge({
        version,
}: {
        version: Pick<JDVersionSummary, 'status' | 'version_no'>
}) {
        const { label, tone } = JD_STATUS[version.status]
        return (
                <Badge tone={tone}>
                        v{version.version_no} · {label}
                </Badge>
        )
}
