import { Building2, ChartColumn, Factory, Users } from 'lucide-react'
import { Link } from 'react-router'
import { Alert } from '../../components/common/Alert'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { StatCard } from '../../components/common/StatCard'
import { cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listDepartments, listPlants } from '../../services/organizationApi'
import { getHeadcount } from '../../services/reportApi'
import type { CurrentUser } from '../../types/api'
import { formatDate, formatNumber } from '../../utils/format'
import { grantCoverage } from '../../utils/labels'
import { useCurrentUser } from '../auth/AuthContext'
import { canReadOrganization, canReadOwnRecord, displayName } from '../auth/permissions'

export function DashboardPage() {
        const user = useCurrentUser()
        return (
                <>
                        <PageHeader
                                title={`Welcome, ${displayName(user)}`}
                                description="An overview of the organization you can access in the PMS portal."
                        />
                        <div className="space-y-6">
                                {canReadOrganization(user) ? (
                                        <OrganizationSummary />
                                ) : (
                                        <SelfService user={user} />
                                )}
                                <AccessSummary user={user} />
                        </div>
                </>
        )
}

function OrganizationSummary() {
        // One batch, one Retry: plants, departments and the authoritative headcount.
        const query = useApiQuery('dashboard', (signal) =>
                Promise.all([
                        listPlants(false, signal),
                        listDepartments(false, signal),
                        getHeadcount({}, signal),
                ]),
        )

        if (query.isLoading) return <LoadingState label="Loading organization summary…" />
        if (query.error || !query.data)
                return <ErrorState error={query.error} onRetry={query.reload} />

        const [plants, departments, report] = query.data
        return (
                <>
                        {report.scope.access_limited && (
                                <Alert tone="info">
                                        Figures cover only the plants and departments included in
                                        your access.
                                </Alert>
                        )}
                        <section aria-labelledby="summary-heading" className="space-y-3">
                                <h2
                                        id="summary-heading"
                                        className="text-lg font-semibold text-slate-900"
                                >
                                        Summary
                                </h2>
                                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                                        <StatCard
                                                label="Plants"
                                                value={formatNumber(plants.length)}
                                                hint="Active plants you can access"
                                        />
                                        <StatCard
                                                label="Departments"
                                                value={formatNumber(departments.length)}
                                                hint="Shared departments you can access"
                                        />
                                        <StatCard
                                                label="Department units"
                                                value={formatNumber(report.by_unit.length)}
                                                hint="Department-at-plant combinations"
                                        />
                                        <StatCard
                                                label="Employees"
                                                value={formatNumber(report.headcount)}
                                                hint={`Counted once at their primary assignment, as of ${formatDate(report.as_of)}`}
                                        />
                                        {report.employees_without_primary > 0 && (
                                                <StatCard
                                                        tone="warning"
                                                        label="Without a primary assignment"
                                                        value={formatNumber(
                                                                report.employees_without_primary,
                                                        )}
                                                        hint="Not included in the employee count; please review"
                                                />
                                        )}
                                </dl>
                        </section>

                        <section aria-labelledby="overview-heading" className="space-y-3">
                                <div className="flex flex-wrap items-end justify-between gap-2">
                                        <h2
                                                id="overview-heading"
                                                className="text-lg font-semibold text-slate-900"
                                        >
                                                Organization overview
                                        </h2>
                                        <Link
                                                to="/reports/headcount"
                                                className={`text-sm ${linkClasses}`}
                                        >
                                                Open headcount report
                                        </Link>
                                </div>
                                {report.by_unit.length === 0 ? (
                                        <p className="text-sm text-slate-600">
                                                No departments are set up in your access yet.
                                        </p>
                                ) : (
                                        <Table caption="Headcount by plant and department">
                                                <thead>
                                                        <tr>
                                                                <Th>Plant</Th>
                                                                <Th>Department</Th>
                                                                <Th align="right">Headcount</Th>
                                                                <Th align="right">
                                                                        Supporting staff
                                                                </Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {report.by_unit.map((unit) => (
                                                                <tr key={unit.plant_department_id}>
                                                                        <Td>
                                                                                <Link
                                                                                        to={`/plants/${unit.plant.id}`}
                                                                                        className={
                                                                                                linkClasses
                                                                                        }
                                                                                >
                                                                                        {
                                                                                                unit
                                                                                                        .plant
                                                                                                        .name
                                                                                        }
                                                                                </Link>
                                                                        </Td>
                                                                        <Td>
                                                                                <Link
                                                                                        to={`/departments/${unit.department.id}/plants/${unit.plant.id}`}
                                                                                        className={
                                                                                                linkClasses
                                                                                        }
                                                                                >
                                                                                        {
                                                                                                unit
                                                                                                        .department
                                                                                                        .name
                                                                                        }
                                                                                </Link>
                                                                        </Td>
                                                                        <Td align="right">
                                                                                {formatNumber(
                                                                                        unit.headcount,
                                                                                )}
                                                                        </Td>
                                                                        <Td align="right">
                                                                                {formatNumber(
                                                                                        unit.supporting,
                                                                                )}
                                                                        </Td>
                                                                </tr>
                                                        ))}
                                                </TBody>
                                                <tfoot className="border-t border-slate-200 bg-slate-50 font-semibold">
                                                        <tr>
                                                                <Td colSpan={2}>
                                                                        Total employees (each
                                                                        counted once)
                                                                </Td>
                                                                <Td align="right">
                                                                        {formatNumber(
                                                                                report.headcount,
                                                                        )}
                                                                </Td>
                                                                <Td />
                                                        </tr>
                                                </tfoot>
                                        </Table>
                                )}
                        </section>

                        <section aria-labelledby="shortcuts-heading" className="space-y-3">
                                <h2
                                        id="shortcuts-heading"
                                        className="text-lg font-semibold text-slate-900"
                                >
                                        Go to
                                </h2>
                                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                                        {[
                                                {
                                                        to: '/plants',
                                                        label: 'Plants',
                                                        text: 'Plants and their departments',
                                                        icon: Factory,
                                                },
                                                {
                                                        to: '/departments',
                                                        label: 'Departments',
                                                        text: 'Departments across plants',
                                                        icon: Building2,
                                                },
                                                {
                                                        to: '/employees',
                                                        label: 'Employees',
                                                        text: 'Employee directory and assignments',
                                                        icon: Users,
                                                },
                                                {
                                                        to: '/reports/headcount',
                                                        label: 'Headcount',
                                                        text: 'Headcount by department and plant',
                                                        icon: ChartColumn,
                                                },
                                        ].map(({ to, label, text, icon: Icon }) => (
                                                <li key={to}>
                                                        <Link
                                                                to={to}
                                                                className={`${cardClasses} flex items-start gap-3 p-4 hover:border-brand-200 hover:bg-brand-50`}
                                                        >
                                                                <Icon
                                                                        aria-hidden="true"
                                                                        className="mt-0.5 size-5 text-brand-700"
                                                                />
                                                                <span>
                                                                        <span className="block font-medium text-slate-900">
                                                                                {label}
                                                                        </span>
                                                                        <span className="block text-sm text-slate-600">
                                                                                {text}
                                                                        </span>
                                                                </span>
                                                        </Link>
                                                </li>
                                        ))}
                                </ul>
                        </section>
                </>
        )
}

function SelfService({ user }: { user: CurrentUser }) {
        if (canReadOwnRecord(user) && user.employee) {
                return (
                        <section
                                className={`${cardClasses} space-y-2 p-5`}
                                aria-labelledby="self-heading"
                        >
                                <h2
                                        id="self-heading"
                                        className="text-lg font-semibold text-slate-900"
                                >
                                        Your employee record
                                </h2>
                                <p className="text-sm text-slate-600">
                                        View your current assignments and assignment history.
                                </p>
                                <Link to={`/employees/${user.employee.id}`} className={linkClasses}>
                                        Open my employee record ({user.employee.employee_code})
                                </Link>
                        </section>
                )
        }
        return (
                <Alert tone="info" title="No organizational access">
                        Your account is not assigned to any plant or department yet. Contact your
                        PMS administrator if you need access.
                </Alert>
        )
}

function AccessSummary({ user }: { user: CurrentUser }) {
        return (
                <section className={`${cardClasses} p-5`} aria-labelledby="access-heading">
                        <h2 id="access-heading" className="text-lg font-semibold text-slate-900">
                                Your access
                        </h2>
                        {user.roles.length === 0 ? (
                                <p className="mt-2 text-sm text-slate-600">
                                        No roles are assigned to your account.
                                </p>
                        ) : (
                                <dl className="mt-3 divide-y divide-slate-100">
                                        {user.roles.map((role) => (
                                                <div
                                                        key={role.code}
                                                        className="grid gap-1 py-2 sm:grid-cols-3"
                                                >
                                                        <dt className="text-sm font-medium text-slate-900">
                                                                {role.name}
                                                        </dt>
                                                        <dd className="text-sm text-slate-700 sm:col-span-2">
                                                                {grantCoverage(role).join('; ')}
                                                        </dd>
                                                </div>
                                        ))}
                                </dl>
                        )}
                </section>
        )
}
