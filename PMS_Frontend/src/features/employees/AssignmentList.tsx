import { AssignmentTypeBadge, Badge } from '../../components/common/Badge'
import type { EmployeeSummary } from '../../types/api'
import { unitLabel } from '../../utils/labels'

/** One employee's in-view assignments, stacked in a single table cell. */
export function AssignmentList({ employee }: { employee: EmployeeSummary }) {
        const primaryHidden = employee.has_primary_assignment && employee.primary_assignment === null
        return (
                <div className="space-y-2">
                        {employee.matching_assignments.length === 0 ? (
                                <p className="text-slate-500">No current assignment in this view</p>
                        ) : (
                                <ul className="space-y-2">
                                        {employee.matching_assignments.map((assignment) => (
                                                <li key={assignment.id} className="flex flex-wrap items-start gap-x-2 gap-y-0.5">
                                                        <AssignmentTypeBadge primary={assignment.is_primary} />
                                                        <span className="min-w-0">
                                                                <span className="block font-medium text-slate-900">
                                                                        {unitLabel(assignment.department, assignment.plant)}
                                                                </span>
                                                                <span className="block text-xs text-slate-600">{assignment.designation.name}</span>
                                                        </span>
                                                </li>
                                        ))}
                                </ul>
                        )}
                        {primaryHidden && (
                                <p className="text-xs text-slate-600">Primary assignment is outside your access.</p>
                        )}
                        {!employee.has_primary_assignment && <Badge tone="warning">No primary assignment recorded</Badge>}
                </div>
        )
}
