import { Link, useParams, useSearchParams } from 'react-router'
import { Alert } from '../../components/common/Alert'
import { ActiveBadge, AssignmentTypeBadge, Badge } from '../../components/common/Badge'
import { TextField } from '../../components/common/Fields'
import { PageHeader, type Crumb } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { buttonClasses, cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { getEmployee } from '../../services/employeeApi'
import type { Assignment } from '../../types/api'
import { formatDate } from '../../utils/format'
import { assignmentTiming, unitLabel } from '../../utils/labels'
import { parseId, parseIsoDate, withParams } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { canReadOrganization } from '../auth/permissions'
import { InvalidLink } from '../common/InvalidLink'

const TIMING_BADGE = {
        current: <Badge tone="success">Current</Badge>,
        upcoming: <Badge tone="info">Upcoming</Badge>,
        ended: <Badge>Ended</Badge>,
}

export function EmployeeDetailPage() {
        const user = useCurrentUser()
        const orgReader = canReadOrganization(user)
        const employeeId = parseId(useParams().employeeId)
        const [params, setParams] = useSearchParams()
        const asOf = parseIsoDate(params.get('as_of'))

        const query = useApiQuery(
                employeeId === undefined ? null : `employee|${employeeId}|${asOf ?? ''}`,
                (signal) => getEmployee(employeeId!, asOf, signal),
        )

        const isSelf = user.employee !== null && user.employee.id === employeeId
        const listCrumb: Crumb = orgReader
                ? { label: 'Employees', to: '/employees' }
                : { label: 'My profile', to: '/profile' }

        if (employeeId === undefined) {
                return <InvalidLink backTo={orgReader ? '/employees' : '/'} backLabel="Go back" />
        }
        if (query.isLoading) return <LoadingState label="Loading employee…" />
        if (query.error !== undefined || !query.data) {
                return (
                        <>
                                <PageHeader title="Employee" breadcrumbs={[listCrumb, { label: 'Employee' }]} />
                                <ErrorState
                                        error={query.error}
                                        onRetry={query.reload}
                                        action={
                                                orgReader && (
                                                        <Link to="/employees" className={buttonClasses('secondary')}>
                                                                Back to employees
                                                        </Link>
                                                )
                                        }
                                />
                        </>
                )
        }

        const employee = query.data
        const visiblePrimary = employee.current_assignments.some((a) => a.is_primary)

        return (
                <>
                        <PageHeader
                                title={employee.full_name}
                                breadcrumbs={[listCrumb, { label: employee.full_name }]}
                                meta={
                                        <>
                                                <Badge>{employee.employee_code}</Badge>
                                                <ActiveBadge active={employee.is_active} />
                                                {isSelf && <Badge tone="brand">You</Badge>}
                                        </>
                                }
                        />
                        <div className="space-y-6">
                                <section className={`${cardClasses} p-5`} aria-labelledby="employee-details">
                                        <h2 id="employee-details" className="sr-only">
                                                Employee details
                                        </h2>
                                        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                                                <Detail label="Employee code" value={employee.employee_code} />
                                                <Detail label="Email" value={employee.email ?? 'Not recorded'} />
                                                <Detail label="Date of joining" value={formatDate(employee.date_of_joining, 'Not recorded')} />
                                                {employee.date_of_exit && <Detail label="Date of exit" value={formatDate(employee.date_of_exit)} />}
                                        </dl>
                                        <div className="mt-4 max-w-xs">
                                                <TextField
                                                        label="Show assignments as of"
                                                        type="date"
                                                        value={asOf ?? ''}
                                                        onChange={(e) => setParams(withParams(params, { as_of: e.target.value }), { replace: true })}
                                                        hint={`Showing ${formatDate(employee.as_of)}. Leave empty for today.`}
                                                />
                                        </div>
                                </section>

                                {!employee.has_primary_assignment ? (
                                        <Alert tone="warning" title="No primary assignment">
                                                No current primary assignment is recorded for this employee on {formatDate(employee.as_of)},
                                                so they are not included in headcount.
                                        </Alert>
                                ) : (
                                        !visiblePrimary && (
                                                <Alert tone="info">
                                                        This employee's primary assignment is outside your access. Only assignments in your access
                                                        are shown.
                                                </Alert>
                                        )
                                )}

                                <section aria-labelledby="current-assignments" className="space-y-3">
                                        <h2 id="current-assignments" className="text-lg font-semibold text-slate-900">
                                                Current assignments
                                        </h2>
                                        {employee.current_assignments.length === 0 ? (
                                                <EmptyState title={`No current assignments in your access on ${formatDate(employee.as_of)}`} />
                                        ) : (
                                                <Table caption="Current assignments">
                                                        <thead>
                                                                <tr>
                                                                        <Th>Department and plant</Th>
                                                                        <Th>Designation</Th>
                                                                        <Th>Type</Th>
                                                                        <Th>Reporting manager</Th>
                                                                        <Th>Since</Th>
                                                                </tr>
                                                        </thead>
                                                        <TBody>
                                                                {employee.current_assignments.map((a) => (
                                                                        <tr key={a.id}>
                                                                                <Td>
                                                                                        <UnitCell assignment={a} linkable={orgReader} />
                                                                                </Td>
                                                                                <Td>{a.designation.name}</Td>
                                                                                <Td>
                                                                                        <AssignmentTypeBadge primary={a.is_primary} />
                                                                                </Td>
                                                                                <Td>
                                                                                        {a.reporting_manager ? (
                                                                                                <>
                                                                                                        {a.reporting_manager.full_name}
                                                                                                        <p className="font-mono text-xs text-slate-600">
                                                                                                                {a.reporting_manager.employee_code}
                                                                                                        </p>
                                                                                                </>
                                                                                        ) : (
                                                                                                <span className="text-slate-500">Not recorded</span>
                                                                                        )}
                                                                                </Td>
                                                                                <Td>{formatDate(a.effective_from)}</Td>
                                                                        </tr>
                                                                ))}
                                                        </TBody>
                                                </Table>
                                        )}
                                </section>

                                <section aria-labelledby="assignment-history" className="space-y-3">
                                        <h2 id="assignment-history" className="text-lg font-semibold text-slate-900">
                                                Assignment history
                                        </h2>
                                        {employee.assignment_history.length === 0 ? (
                                                <EmptyState title="No assignments in your access" />
                                        ) : (
                                                <Table caption="Assignment history, oldest first">
                                                        <thead>
                                                                <tr>
                                                                        <Th>Department and plant</Th>
                                                                        <Th>Designation</Th>
                                                                        <Th>Type</Th>
                                                                        <Th>From</Th>
                                                                        <Th>To</Th>
                                                                        <Th>Status</Th>
                                                                </tr>
                                                        </thead>
                                                        <TBody>
                                                                {employee.assignment_history.map((a) => (
                                                                        <tr key={a.id}>
                                                                                <Td>
                                                                                        <UnitCell assignment={a} linkable={orgReader} />
                                                                                </Td>
                                                                                <Td>{a.designation.name}</Td>
                                                                                <Td>
                                                                                        <AssignmentTypeBadge primary={a.is_primary} />
                                                                                </Td>
                                                                                <Td>{formatDate(a.effective_from)}</Td>
                                                                                <Td>{formatDate(a.effective_to, 'Ongoing')}</Td>
                                                                                <Td>{TIMING_BADGE[assignmentTiming(a, employee.as_of)]}</Td>
                                                                        </tr>
                                                                ))}
                                                        </TBody>
                                                </Table>
                                        )}
                                </section>
                        </div>
                </>
        )
}

function Detail({ label, value }: { label: string; value: string }) {
        return (
                <div>
                        <dt className="text-xs font-medium tracking-wide text-slate-600 uppercase">{label}</dt>
                        <dd className="mt-1 text-sm text-slate-900">{value}</dd>
                </div>
        )
}

function UnitCell({ assignment, linkable }: { assignment: Assignment; linkable: boolean }) {
        const label = unitLabel(assignment.department, assignment.plant)
        if (!linkable) return <>{label}</>
        return (
                <Link
                        to={`/departments/${assignment.department.id}/plants/${assignment.plant.id}`}
                        className={linkClasses}
                >
                        {label}
                </Link>
        )
}
