import { Link, useParams } from 'react-router'
import { Alert } from '../../components/common/Alert'
import { ActiveBadge, Badge } from '../../components/common/Badge'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { StatCard } from '../../components/common/StatCard'
import { buttonClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { getPlant } from '../../services/organizationApi'
import { getHeadcount } from '../../services/reportApi'
import { formatDate, formatNumber } from '../../utils/format'
import { parseId } from '../../utils/params'
import { InvalidLink } from '../common/InvalidLink'

export function PlantDetailPage() {
        const plantId = parseId(useParams().plantId)
        const query = useApiQuery(plantId === undefined ? null : `plant|${plantId}`, (signal) =>
                Promise.all([getPlant(plantId!, signal), getHeadcount({ plantId }, signal)]),
        )

        if (plantId === undefined) return <InvalidLink backTo="/plants" backLabel="Back to plants" />
        if (query.isLoading) return <LoadingState label="Loading plant…" />
        if (query.error || !query.data) {
                return (
                        <>
                                <PageHeader title="Plant" breadcrumbs={[{ label: 'Plants', to: '/plants' }, { label: 'Plant' }]} />
                                <ErrorState
                                        error={query.error}
                                        onRetry={query.reload}
                                        action={
                                                <Link to="/plants" className={buttonClasses('secondary')}>
                                                        Back to plants
                                                </Link>
                                        }
                                />
                        </>
                )
        }

        const [plant, report] = query.data
        const countByUnit = new Map(report.by_unit.map((u) => [u.plant_department_id, u]))

        return (
                <>
                        <PageHeader
                                title={plant.name}
                                breadcrumbs={[{ label: 'Plants', to: '/plants' }, { label: plant.name }]}
                                description={plant.location ?? undefined}
                                meta={
                                        <>
                                                <Badge>{plant.code}</Badge>
                                                <ActiveBadge active={plant.is_active} />
                                        </>
                                }
                                actions={
                                        <>
                                                <Link to={`/employees?plant_id=${plant.id}`} className={buttonClasses('secondary')}>
                                                        Employees at this plant
                                                </Link>
                                                <Link to={`/reports/headcount?plant_id=${plant.id}`} className={buttonClasses('secondary')}>
                                                        Headcount report
                                                </Link>
                                        </>
                                }
                        />
                        <div className="space-y-6">
                                {report.scope.access_limited && (
                                        <Alert tone="info">Only the departments at this plant that are in your access are shown.</Alert>
                                )}
                                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                                        <StatCard
                                                label="Employees"
                                                value={formatNumber(report.headcount)}
                                                hint={`Primary assignment at this plant, as of ${formatDate(report.as_of)}`}
                                        />
                                        <StatCard
                                                label="Supporting staff"
                                                value={formatNumber(report.supporting_employees)}
                                                hint="Also work here; counted at another primary assignment"
                                        />
                                        <StatCard label="Departments" value={formatNumber(plant.units.length)} hint="In your access" />
                                </dl>
                                {report.employees_without_primary > 0 && (
                                        <Alert tone="warning" title="Employees without a primary assignment">
                                                {formatNumber(report.employees_without_primary)} employee(s) work here without a current primary
                                                assignment and are not included in the employee count.
                                        </Alert>
                                )}

                                <section aria-labelledby="plant-departments" className="space-y-3">
                                        <h2 id="plant-departments" className="text-lg font-semibold text-slate-900">
                                                Departments at this plant
                                        </h2>
                                        {plant.units.length === 0 ? (
                                                <EmptyState title="No departments in your access">
                                                        No departments at this plant are included in your access.
                                                </EmptyState>
                                        ) : (
                                                <Table caption={`Departments at ${plant.name}`}>
                                                        <thead>
                                                                <tr>
                                                                        <Th>Department</Th>
                                                                        <Th>Status</Th>
                                                                        <Th align="right">Headcount</Th>
                                                                        <Th align="right">Supporting staff</Th>
                                                                        <Th>
                                                                                <span className="sr-only">Links</span>
                                                                        </Th>
                                                                </tr>
                                                        </thead>
                                                        <TBody>
                                                                {plant.units.map((unit) => {
                                                                        const counts = countByUnit.get(unit.plant_department_id)
                                                                        return (
                                                                                <tr key={unit.plant_department_id}>
                                                                                        <Td>
                                                                                                <Link
                                                                                                        to={`/departments/${unit.department.id}/plants/${plant.id}`}
                                                                                                        className={linkClasses}
                                                                                                >
                                                                                                        {unit.department.name}
                                                                                                </Link>
                                                                                        </Td>
                                                                                        <Td>
                                                                                                <ActiveBadge active={unit.is_active} />
                                                                                        </Td>
                                                                                        <Td align="right">{formatNumber(counts?.headcount ?? 0)}</Td>
                                                                                        <Td align="right">{formatNumber(counts?.supporting ?? 0)}</Td>
                                                                                        <Td align="right">
                                                                                                <Link
                                                                                                        to={`/employees?plant_id=${plant.id}&department_id=${unit.department.id}`}
                                                                                                        className={`text-sm ${linkClasses}`}
                                                                                                >
                                                                                                        Employees
                                                                                                </Link>
                                                                                        </Td>
                                                                                </tr>
                                                                        )
                                                                })}
                                                        </TBody>
                                                </Table>
                                        )}
                                </section>
                        </div>
                </>
        )
}
