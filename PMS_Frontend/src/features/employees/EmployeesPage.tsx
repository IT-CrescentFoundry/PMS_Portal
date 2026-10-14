import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import type { FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Alert } from '../../components/common/Alert'
import { ActiveBadge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { CheckboxField, TextField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { cardClasses, inputClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listEmployees, type EmployeeListParams } from '../../services/employeeApi'
import { listOrgUnits } from '../../services/organizationApi'
import { formatDate, formatNumber, plural } from '../../utils/format'
import { parseId, parseIsoDate, parsePage, withParams } from '../../utils/params'
import { OrgFilters } from '../organization/OrgFilters'
import { departmentsOf, plantsOf, unitExists } from '../organization/orgUnits'
import { AssignmentList } from './AssignmentList'

export const EMPLOYEE_PAGE_SIZE = 25

/** Read the directory's filters from the URL (the single source of truth). */
function readFilters(params: URLSearchParams) {
        return {
                search: (params.get('q') ?? '').trim(),
                plantId: parseId(params.get('plant_id')),
                departmentId: parseId(params.get('department_id')),
                primaryOnly: params.get('primary') === '1',
                includeInactive: params.get('inactive') === '1',
                asOf: parseIsoDate(params.get('as_of')),
                page: parsePage(params.get('page')),
        }
}

export function EmployeesPage() {
        const [params, setParams] = useSearchParams()
        const filters = readFilters(params)

        const request: EmployeeListParams = {
                search: filters.search || undefined,
                plantId: filters.plantId,
                departmentId: filters.departmentId,
                primaryOnly: filters.primaryOnly,
                includeInactive: filters.includeInactive,
                asOf: filters.asOf,
                limit: EMPLOYEE_PAGE_SIZE,
                offset: (filters.page - 1) * EMPLOYEE_PAGE_SIZE,
        }
        const employees = useApiQuery(
                `employees|${JSON.stringify(request)}`,
                (signal) => listEmployees(request, signal),
                { keepPreviousData: true },
        )
        const units = useApiQuery('org-units', (signal) => listOrgUnits({}, signal))

        /** Apply filter changes; any change returns to the first page. */
        function update(changes: Record<string, string | number | boolean | undefined>) {
                setParams(withParams(params, { ...changes, page: undefined }))
        }

        function handleSearch(event: FormEvent<HTMLFormElement>) {
                event.preventDefault()
                const value = new FormData(event.currentTarget).get('q')
                update({ q: typeof value === 'string' ? value.trim() : '' })
        }

        const unitList = units.data ?? []
        const plantName = plantsOf(unitList).find((p) => p.id === filters.plantId)?.name
        const departmentName = departmentsOf(unitList).find(
                (d) => d.id === filters.departmentId,
        )?.name
        const comboMissing =
                units.data !== undefined &&
                filters.plantId !== undefined &&
                filters.departmentId !== undefined &&
                unitExists(unitList, filters.plantId, filters.departmentId) === false

        const data = employees.data
        const firstRow = data && data.total > 0 ? data.offset + 1 : 0
        const lastRow = data ? data.offset + data.items.length : 0
        const hasActiveFilters =
                filters.search !== '' ||
                filters.plantId !== undefined ||
                filters.departmentId !== undefined ||
                filters.primaryOnly ||
                filters.includeInactive ||
                filters.asOf !== undefined

        return (
                <>
                        <PageHeader
                                title="Employees"
                                description="Each person appears once. Employees who work in several places show each assignment, marked Primary (where they are counted) or Supporting."
                        />

                        <section
                                aria-label="Filters"
                                className={`${cardClasses} mb-4 space-y-4 p-4`}
                        >
                                <form
                                        role="search"
                                        onSubmit={handleSearch}
                                        className="flex flex-wrap items-end gap-2"
                                >
                                        <div className="w-full max-w-md space-y-1">
                                                <label
                                                        htmlFor="employee-search"
                                                        className="block text-sm font-medium text-slate-800"
                                                >
                                                        Search by employee code or name
                                                </label>
                                                <div className="relative">
                                                        <Search
                                                                aria-hidden="true"
                                                                className="pointer-events-none absolute top-3 left-3 size-4 text-slate-400"
                                                        />
                                                        <input
                                                                key={filters.search}
                                                                id="employee-search"
                                                                name="q"
                                                                type="search"
                                                                maxLength={100}
                                                                defaultValue={filters.search}
                                                                placeholder="e.g. DEMO0001 or Asha"
                                                                className={`${inputClasses} pl-9`}
                                                        />
                                                </div>
                                        </div>
                                        <Button type="submit" variant="primary">
                                                Search
                                        </Button>
                                        {hasActiveFilters && (
                                                <Button
                                                        variant="ghost"
                                                        onClick={() =>
                                                                setParams(new URLSearchParams())
                                                        }
                                                >
                                                        <X aria-hidden="true" className="size-4" />
                                                        Clear all filters
                                                </Button>
                                        )}
                                </form>

                                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                        <OrgFilters
                                                units={unitList}
                                                plantId={filters.plantId}
                                                departmentId={filters.departmentId}
                                                disabled={units.data === undefined}
                                                onChange={({ plantId, departmentId }) =>
                                                        update({
                                                                plant_id: plantId,
                                                                department_id: departmentId,
                                                        })
                                                }
                                        />
                                        <TextField
                                                label="Assignments as of"
                                                type="date"
                                                value={filters.asOf ?? ''}
                                                onChange={(e) => update({ as_of: e.target.value })}
                                                hint="Leave empty for today."
                                        />
                                </div>
                                <div className="flex flex-wrap gap-x-6 gap-y-2">
                                        <CheckboxField
                                                label="Only employees counted here (primary assignment)"
                                                checked={filters.primaryOnly}
                                                onChange={(e) =>
                                                        update({
                                                                primary: e.target.checked
                                                                        ? '1'
                                                                        : '',
                                                        })
                                                }
                                        />
                                        <CheckboxField
                                                label="Include inactive employees"
                                                checked={filters.includeInactive}
                                                onChange={(e) =>
                                                        update({
                                                                inactive: e.target.checked
                                                                        ? '1'
                                                                        : '',
                                                        })
                                                }
                                        />
                                </div>
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
                                {comboMissing && (
                                        <Alert tone="warning">
                                                {departmentName ?? 'This department'} is not set up
                                                at {plantName ?? 'this plant'}.
                                        </Alert>
                                )}
                        </section>

                        {employees.isLoading ? (
                                <LoadingState label="Loading employees…" />
                        ) : employees.error !== undefined || !data ? (
                                <ErrorState error={employees.error} onRetry={employees.reload} />
                        ) : data.items.length === 0 ? (
                                data.total > 0 ? (
                                        <EmptyState
                                                title="This page is past the end of the results"
                                                action={
                                                        <Button onClick={() => update({})}>
                                                                Go to the first page
                                                        </Button>
                                                }
                                        />
                                ) : (
                                        <EmptyState title="No employees found">
                                                {hasActiveFilters
                                                        ? 'No one matches these filters.'
                                                        : 'There are no employees in your access.'}
                                        </EmptyState>
                                )
                        ) : (
                                <>
                                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                                <p
                                                        className="text-sm text-slate-600"
                                                        aria-live="polite"
                                                >
                                                        {employees.isStale
                                                                ? 'Updating results…'
                                                                : `Showing ${formatNumber(firstRow)}–${formatNumber(lastRow)} of ${plural(data.total, 'employee')}, as of ${formatDate(data.as_of)}`}
                                                </p>
                                        </div>
                                        <Table caption="Employees" busy={employees.isStale}>
                                                <thead>
                                                        <tr>
                                                                <Th>Employee</Th>
                                                                <Th>Assignments in this view</Th>
                                                                <Th className="hidden sm:table-cell">
                                                                        Status
                                                                </Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {data.items.map((employee) => (
                                                                <tr key={employee.id}>
                                                                        <Td className="sm:min-w-48">
                                                                                <Link
                                                                                        to={`/employees/${employee.id}${filters.asOf ? `?as_of=${filters.asOf}` : ''}`}
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
                                                                                <div className="mt-1 sm:hidden">
                                                                                        <ActiveBadge
                                                                                                active={
                                                                                                        employee.is_active
                                                                                                }
                                                                                        />
                                                                                </div>
                                                                        </Td>
                                                                        <Td className="sm:min-w-64">
                                                                                <AssignmentList
                                                                                        employee={
                                                                                                employee
                                                                                        }
                                                                                />
                                                                        </Td>
                                                                        <Td className="hidden sm:table-cell">
                                                                                <ActiveBadge
                                                                                        active={
                                                                                                employee.is_active
                                                                                        }
                                                                                />
                                                                        </Td>
                                                                </tr>
                                                        ))}
                                                </TBody>
                                        </Table>
                                        <Pagination
                                                page={filters.page}
                                                total={data.total}
                                                disabled={employees.isStale}
                                                onPage={(page) =>
                                                        setParams(
                                                                withParams(params, {
                                                                        page:
                                                                                page > 1
                                                                                        ? page
                                                                                        : undefined,
                                                                }),
                                                        )
                                                }
                                        />
                                </>
                        )}
                </>
        )
}

function Pagination({
        page,
        total,
        disabled,
        onPage,
}: {
        page: number
        total: number
        disabled: boolean
        onPage: (page: number) => void
}) {
        const pages = Math.max(1, Math.ceil(total / EMPLOYEE_PAGE_SIZE))
        if (pages <= 1) return null
        return (
                <nav
                        aria-label="Pagination"
                        className="mt-4 flex items-center justify-between gap-2"
                >
                        <Button onClick={() => onPage(page - 1)} disabled={disabled || page <= 1}>
                                <ChevronLeft aria-hidden="true" className="size-4" />
                                Previous
                        </Button>
                        <span className="text-sm text-slate-600">
                                Page {page} of {pages}
                        </span>
                        <Button
                                onClick={() => onPage(page + 1)}
                                disabled={disabled || page >= pages}
                        >
                                Next
                                <ChevronRight aria-hidden="true" className="size-4" />
                        </Button>
                </nav>
        )
}
