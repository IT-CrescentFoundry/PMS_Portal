import { Link, useParams } from 'react-router'
import { Alert } from '../../components/common/Alert'
import { ActiveBadge, Badge } from '../../components/common/Badge'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { StatCard } from '../../components/common/StatCard'
import { buttonClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { getDepartment } from '../../services/organizationApi'
import { getHeadcount } from '../../services/reportApi'
import { formatDate, formatNumber } from '../../utils/format'
import { parseId } from '../../utils/params'
import { InvalidLink } from '../common/InvalidLink'

/** Consolidated view: one department across every plant in the user's access. */
export function DepartmentDetailPage() {
        const departmentId = parseId(useParams().departmentId)
        const query = useApiQuery(
                departmentId === undefined ? null : `department|${departmentId}`,
                (signal) =>
                        Promise.all([getDepartment(departmentId!, signal), getHeadcount({ departmentId }, signal)]),
        )

        if (departmentId === undefined) {
                return <InvalidLink backTo="/departments" backLabel="Back to departments" />
        }
        if (query.isLoading) return <LoadingState label="Loading department…" />
        if (query.error || !query.data) {
                return (
                        <>
                                <PageHeader
                                        title="Department"
                                        breadcrumbs={[{ label: 'Departments', to: '/departments' }, { label: 'Department' }]}
                                />
                                <ErrorState
                                        error={query.error}
                                        onRetry={query.reload}
                                        action={
                                                <Link to="/departments" className={buttonClasses('secondary')}>
                                                        Back to departments
                                                </Link>
                                        }
                                />
                        </>
                )
        }

        const [department, report] = query.data
        const countByUnit = new Map(report.by_unit.map((u) => [u.plant_department_id, u]))

        return (
                <>
                        <PageHeader
                                title={`${department.name}: all accessible plants`}
                                breadcrumbs={[{ label: 'Departments', to: '/departments' }, { label: department.name }]}
                                description={
                                        <>
                                                Consolidated view across every plant in your access. An employee who works at more than
                                                one plant is counted once, at their primary assignment.
                                                {department.description && <span className="block pt-1">{department.description}</span>}
                                        </>
                                }
                                meta={
                                        <>
                                                <Badge>{department.code}</Badge>
                                                <ActiveBadge active={department.is_active} />
                                        </>
                                }
                                actions={
                                        <>
                                                <Link to={`/employees?department_id=${department.id}`} className={buttonClasses('secondary')}>
                                                        Employees in this department
                                                </Link>
                                                <Link
                                                        to={`/reports/headcount?department_id=${department.id}`}
                                                        className={buttonClasses('secondary')}
                                                >
                                                        Headcount report
                                                </Link>
                                        </>
                                }
                        />
                        <div className="space-y-6">
                                {report.scope.access_limited && (
                                        <Alert tone="info">Only the plants in your access are included.</Alert>
                                )}
                                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                                        <StatCard
                                                label="Employees"
                                                value={formatNumber(report.headcount)}
                                                hint={`Each counted once, as of ${formatDate(report.as_of)}`}
                                        />
                                        <StatCard
                                                label="Supporting staff"
                                                value={formatNumber(report.supporting_employees)}
                                                hint="Primary assignment in another department"
                                        />
                                        <StatCard label="Plants" value={formatNumber(department.units.length)} hint="Where this department exists" />
                                </dl>
                                {report.employees_without_primary > 0 && (
                                        <Alert tone="warning" title="Employees without a primary assignment">
                                                {formatNumber(report.employees_without_primary)} employee(s) in this department have no current
                                                primary assignment and are not included in the employee count.
                                        </Alert>
                                )}

                                <section aria-labelledby="by-plant" className="space-y-3">
                                        <h2 id="by-plant" className="text-lg font-semibold text-slate-900">
                                                {department.name} by plant
                                        </h2>
                                        {department.units.length === 0 ? (
                                                <EmptyState title="Not set up at any plant in your access" />
                                        ) : (
                                                <Table caption={`${department.name} by plant`}>
                                                        <thead>
                                                                <tr>
                                                                        <Th>Plant</Th>
                                                                        <Th>Status</Th>
                                                                        <Th align="right">Headcount</Th>
                                                                        <Th align="right">Supporting staff</Th>
                                                                        <Th>
                                                                                <span className="sr-only">Links</span>
                                                                        </Th>
                                                                </tr>
                                                        </thead>
                                                        <TBody>
                                                                {department.units.map((unit) => {
                                                                        const counts = countByUnit.get(unit.plant_department_id)
                                                                        return (
                                                                                <tr key={unit.plant_department_id}>
                                                                                        <Td>
                                                                                                <Link
                                                                                                        to={`/departments/${department.id}/plants/${unit.plant.id}`}
                                                                                                        className={linkClasses}
                                                                                                >
                                                                                                        {department.name}: {unit.plant.name}
                                                                                                </Link>
                                                                                        </Td>
                                                                                        <Td>
                                                                                                <ActiveBadge active={unit.is_active} />
                                                                                        </Td>
                                                                                        <Td align="right">{formatNumber(counts?.headcount ?? 0)}</Td>
                                                                                        <Td align="right">{formatNumber(counts?.supporting ?? 0)}</Td>
                                                                                        <Td align="right">
                                                                                                <Link
                                                                                                        to={`/employees?plant_id=${unit.plant.id}&department_id=${department.id}`}
                                                                                                        className={`text-sm ${linkClasses}`}
                                                                                                >
                                                                                                        Employees
                                                                                                </Link>
                                                                                        </Td>
                                                                                </tr>
                                                                        )
                                                                })}
                                                        </TBody>
                                                        <tfoot className="border-t border-slate-200 bg-slate-50 font-semibold">
                                                                <tr>
                                                                        <Td colSpan={2}>Total employees (each counted once)</Td>
                                                                        <Td align="right">{formatNumber(report.headcount)}</Td>
                                                                        <Td colSpan={2} />
                                                                </tr>
                                                        </tfoot>
                                                </Table>
                                        )}
                                </section>
                        </div>
                </>
        )
}
