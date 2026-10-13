import { Link, useSearchParams } from 'react-router'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { TextField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { StatCard } from '../../components/common/StatCard'
import { cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listOrgUnits } from '../../services/organizationApi'
import { getHeadcount } from '../../services/reportApi'
import { formatDate, formatNumber } from '../../utils/format'
import { parseId, parseIsoDate, withParams } from '../../utils/params'
import { OrgFilters } from '../organization/OrgFilters'
import { describeView } from './headcountView'

export function HeadcountPage() {
        const [params, setParams] = useSearchParams()
        const plantId = parseId(params.get('plant_id'))
        const departmentId = parseId(params.get('department_id'))
        const asOf = parseIsoDate(params.get('as_of'))

        const units = useApiQuery('org-units', (signal) => listOrgUnits({}, signal))
        // The backend figure is authoritative. Totals are never re-added from
        // separate requests, which could count a cross-plant employee twice.
        const report = useApiQuery(
                `headcount|${plantId ?? ''}|${departmentId ?? ''}|${asOf ?? ''}`,
                (signal) => getHeadcount({ plantId, departmentId, asOf }, signal),
                { keepPreviousData: true },
        )

        const employeesLink = `/employees?${withParams(new URLSearchParams(), {
                plant_id: plantId,
                department_id: departmentId,
                as_of: asOf,
                primary: '1',
        }).toString()}`

        const data = report.data
        return (
                <>
                        <PageHeader
                                title="Headcount report"
                                description="Each employee is counted once, at their primary assignment. Employees who also work elsewhere are shown as supporting staff and are not added to the headcount."
                        />

                        <section aria-label="Report filters" className={`${cardClasses} mb-4 space-y-3 p-4`}>
                                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                                        <OrgFilters
                                                units={units.data ?? []}
                                                plantId={plantId}
                                                departmentId={departmentId}
                                                disabled={units.data === undefined}
                                                onChange={(next) =>
                                                        setParams(withParams(params, { plant_id: next.plantId, department_id: next.departmentId }))
                                                }
                                        />
                                        <TextField
                                                label="As of date"
                                                type="date"
                                                value={asOf ?? ''}
                                                onChange={(e) => setParams(withParams(params, { as_of: e.target.value }))}
                                                hint="Leave empty for today."
                                        />
                                </div>
                                <p className="text-sm text-slate-700">
                                        <span className="font-medium">View: </span>
                                        {describeView(plantId !== undefined, departmentId !== undefined)}
                                </p>
                                {units.error !== undefined && (
                                        <Alert
                                                tone="warning"
                                                action={
                                                        <Button size="sm" onClick={units.reload}>
                                                                Retry
                                                        </Button>
                                                }
                                        >
                                                Plant and department filters could not be loaded.
                                        </Alert>
                                )}
                        </section>

                        {report.isLoading ? (
                                <LoadingState label="Calculating headcount…" />
                        ) : report.error !== undefined || !data ? (
                                <ErrorState error={report.error} onRetry={report.reload} />
                        ) : (
                                <section
                                        aria-labelledby="report-heading"
                                        aria-busy={report.isStale || undefined}
                                        className={`space-y-4 ${report.isStale ? 'opacity-60' : ''}`}
                                >
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                                <div>
                                                        <h2 id="report-heading" className="text-lg font-semibold text-slate-900">
                                                                {data.scope.label}
                                                        </h2>
                                                        <p className="text-sm text-slate-600">As of {formatDate(data.as_of)}</p>
                                                </div>
                                                <div className="flex items-center gap-3" aria-live="polite">
                                                        {report.isStale && <Badge tone="info">Updating report…</Badge>}
                                                        {!report.isStale && data.headcount > 0 && (
                                                                <Link to={employeesLink} className={`text-sm ${linkClasses}`}>
                                                                        View these employees
                                                                </Link>
                                                        )}
                                                </div>
                                        </div>

                                        {data.scope.access_limited && (
                                                <Alert tone="info">
                                                        Your access covers only part of this selection. All figures include only the plants and
                                                        departments in your access.
                                                </Alert>
                                        )}

                                        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                                                <StatCard label="Headcount" value={formatNumber(data.headcount)} hint="Each person counted once" />
                                                <StatCard
                                                        label="Supporting staff"
                                                        value={formatNumber(data.supporting_employees)}
                                                        hint="Work in this selection, but counted outside it"
                                                />
                                                <StatCard
                                                        label="Without a primary assignment"
                                                        value={formatNumber(data.employees_without_primary)}
                                                        tone={data.employees_without_primary > 0 ? 'warning' : 'default'}
                                                        hint={data.employees_without_primary > 0 ? 'Not counted; please review their records' : 'No data issues'}
                                                />
                                        </dl>

                                        {data.by_unit.length > 1 && (
            <p className="text-xs text-slate-600">
              In the table, supporting staff for a row are people who also work in that unit but are
              counted in another unit, which may be inside this selection. Row figures are therefore
              not added up.
            </p>
          )}
          {data.by_unit.length === 0 ? (
                                                <EmptyState title="No departments match this selection">
                                                        The selected department is not set up at the selected plant, or there are no departments
                                                        in your access.
                                                </EmptyState>
                                        ) : (
                                                <Table caption={`Headcount by plant and department: ${data.scope.label}`} busy={report.isStale}>
                                                        <thead>
                                                                <tr>
                                                                        <Th>Plant</Th>
                                                                        <Th>Department</Th>
                                                                        <Th align="right">Headcount</Th>
                                                                        <Th align="right">Supporting staff</Th>
                                                                </tr>
                                                        </thead>
                                                        <TBody>
                                                                {data.by_unit.map((unit) => (
                                                                        <tr key={unit.plant_department_id}>
                                                                                <Td>{unit.plant.name}</Td>
                                                                                <Td>
                                                                                        <Link
                                                                                                to={`/departments/${unit.department.id}/plants/${unit.plant.id}`}
                                                                                                className={linkClasses}
                                                                                        >
                                                                                                {unit.department.name}
                                                                                        </Link>
                                                                                </Td>
                                                                                <Td align="right">{formatNumber(unit.headcount)}</Td>
                                                                                <Td align="right">{formatNumber(unit.supporting)}</Td>
                                                                        </tr>
                                                                ))}
                                                        </TBody>
                                                        <tfoot className="border-t border-slate-200 bg-slate-50 font-semibold">
                                                                <tr>
                                                                        <Td colSpan={2}>Total headcount (each person counted once)</Td>
                                                                        <Td align="right">{formatNumber(data.headcount)}</Td>
                                                                        <Td />
                                                                </tr>
                                                        </tfoot>
                                                </Table>
                                        )}
                                </section>
                        )}
                </>
        )
}
