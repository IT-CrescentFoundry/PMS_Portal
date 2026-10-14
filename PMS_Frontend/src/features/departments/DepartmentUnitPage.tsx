import { Link, useParams } from 'react-router'
import { Alert } from '../../components/common/Alert'
import { AssignmentTypeBadge } from '../../components/common/Badge'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { StatCard } from '../../components/common/StatCard'
import { buttonClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listEmployees } from '../../services/employeeApi'
import { getHeadcount } from '../../services/reportApi'
import { formatDate, formatNumber } from '../../utils/format'
import { parseId } from '../../utils/params'
import { InvalidLink } from '../common/InvalidLink'

const PREVIEW_LIMIT = 50

/** Plant-specific view: one department at one plant (e.g. Quality at Plant A). */
export function DepartmentUnitPage() {
        const params = useParams()
        const departmentId = parseId(params.departmentId)
        const plantId = parseId(params.plantId)
        const valid = departmentId !== undefined && plantId !== undefined

        const query = useApiQuery(valid ? `unit|${departmentId}|${plantId}` : null, (signal) =>
                Promise.all([
                        getHeadcount({ departmentId, plantId }, signal),
                        listEmployees(
                                { departmentId, plantId, limit: PREVIEW_LIMIT, offset: 0 },
                                signal,
                        ),
                ]),
        )

        if (!valid) return <InvalidLink backTo="/departments" backLabel="Back to departments" />
        if (query.isLoading) return <LoadingState label="Loading department…" />
        if (query.error || !query.data) {
                return (
                        <>
                                <PageHeader
                                        title="Department at plant"
                                        breadcrumbs={[
                                                { label: 'Departments', to: '/departments' },
                                                { label: 'Department at plant' },
                                        ]}
                                />
                                <ErrorState
                                        error={query.error}
                                        onRetry={query.reload}
                                        action={
                                                <Link
                                                        to="/departments"
                                                        className={buttonClasses('secondary')}
                                                >
                                                        Back to departments
                                                </Link>
                                        }
                                />
                        </>
                )
        }

        const [report, employees] = query.data
        const unit = report.by_unit[0]
        const employeeListLink = `/employees?plant_id=${plantId}&department_id=${departmentId}`

        return (
                <>
                        <PageHeader
                                title={report.scope.label}
                                breadcrumbs={[
                                        { label: 'Departments', to: '/departments' },
                                        {
                                                label: unit?.department.name ?? 'Department',
                                                to: `/departments/${departmentId}`,
                                        },
                                        { label: unit?.plant.name ?? 'Plant' },
                                ]}
                                description="This department at this plant only."
                                actions={
                                        unit && (
                                                <>
                                                        <Link
                                                                to={`/departments/${departmentId}`}
                                                                className={buttonClasses(
                                                                        'secondary',
                                                                )}
                                                        >
                                                                {unit.department.name} across all
                                                                plants
                                                        </Link>
                                                        <Link
                                                                to={`/plants/${plantId}`}
                                                                className={buttonClasses(
                                                                        'secondary',
                                                                )}
                                                        >
                                                                {unit.plant.name}
                                                        </Link>
                                                </>
                                        )
                                }
                        />
                        {!unit ? (
                                <EmptyState title="This department is not set up at this plant">
                                        There are no employees or headcount for this combination.
                                </EmptyState>
                        ) : (
                                <div className="space-y-6">
                                        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                                                <StatCard
                                                        label="Employees"
                                                        value={formatNumber(report.headcount)}
                                                        hint={`Primary assignment here, as of ${formatDate(report.as_of)}`}
                                                />
                                                <StatCard
                                                        label="Supporting staff"
                                                        value={formatNumber(
                                                                report.supporting_employees,
                                                        )}
                                                        hint="Also work here; primary assignment elsewhere"
                                                />
                                                <StatCard
                                                        label="Without a primary assignment"
                                                        value={formatNumber(
                                                                report.employees_without_primary,
                                                        )}
                                                        tone={
                                                                report.employees_without_primary > 0
                                                                        ? 'warning'
                                                                        : 'default'
                                                        }
                                                />
                                        </dl>

                                        <section
                                                aria-labelledby="unit-people"
                                                className="space-y-3"
                                        >
                                                <div className="flex flex-wrap items-end justify-between gap-2">
                                                        <h2
                                                                id="unit-people"
                                                                className="text-lg font-semibold text-slate-900"
                                                        >
                                                                People working here
                                                        </h2>
                                                        <Link
                                                                to={employeeListLink}
                                                                className={`text-sm ${linkClasses}`}
                                                        >
                                                                Open in employee directory
                                                        </Link>
                                                </div>
                                                {employees.items.length === 0 ? (
                                                        <EmptyState title="No one currently works here" />
                                                ) : (
                                                        <>
                                                                {employees.total >
                                                                        employees.items.length && (
                                                                        <Alert tone="info">
                                                                                Showing{' '}
                                                                                {
                                                                                        employees
                                                                                                .items
                                                                                                .length
                                                                                }{' '}
                                                                                of{' '}
                                                                                {formatNumber(
                                                                                        employees.total,
                                                                                )}{' '}
                                                                                people.{' '}
                                                                                <Link
                                                                                        to={
                                                                                                employeeListLink
                                                                                        }
                                                                                        className={
                                                                                                linkClasses
                                                                                        }
                                                                                >
                                                                                        View all in
                                                                                        the employee
                                                                                        directory
                                                                                </Link>
                                                                        </Alert>
                                                                )}
                                                                <Table
                                                                        caption={`People working at ${report.scope.label}`}
                                                                >
                                                                        <thead>
                                                                                <tr>
                                                                                        <Th>
                                                                                                Employee
                                                                                        </Th>
                                                                                        <Th>
                                                                                                Designation
                                                                                        </Th>
                                                                                        <Th>
                                                                                                Assignment
                                                                                        </Th>
                                                                                        <Th>
                                                                                                Since
                                                                                        </Th>
                                                                                </tr>
                                                                        </thead>
                                                                        <TBody>
                                                                                {employees.items.map(
                                                                                        (
                                                                                                employee,
                                                                                        ) => {
                                                                                                const assignment =
                                                                                                        employee
                                                                                                                .matching_assignments[0]
                                                                                                return (
                                                                                                        <tr
                                                                                                                key={
                                                                                                                        employee.id
                                                                                                                }
                                                                                                        >
                                                                                                                <Td>
                                                                                                                        <Link
                                                                                                                                to={`/employees/${employee.id}`}
                                                                                                                                className={
                                                                                                                                        linkClasses
                                                                                                                                }
                                                                                                                        >
                                                                                                                                {
                                                                                                                                        employee.full_name
                                                                                                                                }
                                                                                                                        </Link>
                                                                                                                        <p className="font-mono text-xs text-slate-600">
                                                                                                                                {
                                                                                                                                        employee.employee_code
                                                                                                                                }
                                                                                                                        </p>
                                                                                                                </Td>
                                                                                                                <Td>
                                                                                                                        {assignment
                                                                                                                                ?.designation
                                                                                                                                .name ??
                                                                                                                                '—'}
                                                                                                                </Td>
                                                                                                                <Td>
                                                                                                                        {assignment && (
                                                                                                                                <AssignmentTypeBadge
                                                                                                                                        primary={
                                                                                                                                                assignment.is_primary
                                                                                                                                        }
                                                                                                                                />
                                                                                                                        )}
                                                                                                                </Td>
                                                                                                                <Td>
                                                                                                                        {formatDate(
                                                                                                                                assignment?.effective_from,
                                                                                                                        )}
                                                                                                                </Td>
                                                                                                        </tr>
                                                                                                )
                                                                                        },
                                                                                )}
                                                                        </TBody>
                                                                </Table>
                                                        </>
                                                )}
                                        </section>
                                </div>
                        )}
                </>
        )
}
