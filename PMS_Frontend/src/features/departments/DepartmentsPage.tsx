import { Search } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { ActiveBadge } from '../../components/common/Badge'
import { CheckboxField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { inputClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listDepartments, listOrgUnits } from '../../services/organizationApi'
import { plural } from '../../utils/format'
import { withParams } from '../../utils/params'
import { groupUnits } from '../organization/orgUnits'

export function DepartmentsPage() {
        const [params, setParams] = useSearchParams()
        const includeInactive = params.get('inactive') === '1'
        const search = params.get('q') ?? ''

        const query = useApiQuery(
                `departments|${includeInactive}`,
                (signal) =>
                        Promise.all([
                                listDepartments(includeInactive, signal),
                                listOrgUnits({ includeInactive }, signal),
                        ]),
                { keepPreviousData: true },
        )

        const term = search.trim().toLowerCase()
        const [departments, units] = query.data ?? [[], []]
        const unitsByDepartment = groupUnits(units, 'department')
        const visible = departments.filter((d) =>
                [d.code, d.name, d.description ?? ''].some((v) => v.toLowerCase().includes(term)),
        )

        return (
                <>
                        <PageHeader
                                title="Departments"
                                description="Each department is defined once and can exist at several plants. Open a department for a consolidated view across plants, or choose a plant for that location only."
                        />
                        <div className="mb-4 flex flex-wrap items-end gap-4">
                                <div className="w-full max-w-xs space-y-1">
                                        <label
                                                htmlFor="department-search"
                                                className="block text-sm font-medium text-slate-800"
                                        >
                                                Search departments
                                        </label>
                                        <div className="relative">
                                                <Search
                                                        aria-hidden="true"
                                                        className="pointer-events-none absolute top-3 left-3 size-4 text-slate-400"
                                                />
                                                <input
                                                        id="department-search"
                                                        type="search"
                                                        className={`${inputClasses} pl-9`}
                                                        placeholder="Code, name or description"
                                                        value={search}
                                                        onChange={(e) =>
                                                                setParams(
                                                                        withParams(params, {
                                                                                q: e.target.value,
                                                                        }),
                                                                        { replace: true },
                                                                )
                                                        }
                                                />
                                        </div>
                                </div>
                                <div className="pb-2">
                                        <CheckboxField
                                                label="Show inactive departments"
                                                checked={includeInactive}
                                                onChange={(e) =>
                                                        setParams(
                                                                withParams(params, {
                                                                        inactive: e.target.checked
                                                                                ? '1'
                                                                                : '',
                                                                }),
                                                        )
                                                }
                                        />
                                </div>
                        </div>

                        {query.isLoading ? (
                                <LoadingState label="Loading departments…" />
                        ) : query.error ? (
                                <ErrorState error={query.error} onRetry={query.reload} />
                        ) : departments.length === 0 ? (
                                <EmptyState title="No departments in your access" />
                        ) : visible.length === 0 ? (
                                <EmptyState title="No departments match your search" />
                        ) : (
                                <>
                                        <p
                                                className="mb-2 text-sm text-slate-600"
                                                aria-live="polite"
                                        >
                                                {query.isStale
                                                        ? 'Updating…'
                                                        : plural(visible.length, 'department')}
                                        </p>
                                        <Table caption="Departments" busy={query.isStale}>
                                                <thead>
                                                        <tr>
                                                                <Th>Code</Th>
                                                                <Th>Department</Th>
                                                                <Th>Plants (in your access)</Th>
                                                                <Th>Status</Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {visible.map((department) => {
                                                                const deptUnits =
                                                                        unitsByDepartment.get(
                                                                                department.id,
                                                                        ) ?? []
                                                                return (
                                                                        <tr key={department.id}>
                                                                                <Td className="font-mono text-xs text-slate-700">
                                                                                        {
                                                                                                department.code
                                                                                        }
                                                                                </Td>
                                                                                <Td>
                                                                                        <Link
                                                                                                to={`/departments/${department.id}`}
                                                                                                className={
                                                                                                        linkClasses
                                                                                                }
                                                                                        >
                                                                                                {
                                                                                                        department.name
                                                                                                }
                                                                                        </Link>
                                                                                        {department.description && (
                                                                                                <p className="mt-0.5 text-xs text-slate-600">
                                                                                                        {
                                                                                                                department.description
                                                                                                        }
                                                                                                </p>
                                                                                        )}
                                                                                </Td>
                                                                                <Td>
                                                                                        {deptUnits.length ===
                                                                                        0 ? (
                                                                                                <span className="text-slate-500">
                                                                                                        Not
                                                                                                        set
                                                                                                        up
                                                                                                        at
                                                                                                        any
                                                                                                        plant
                                                                                                        in
                                                                                                        your
                                                                                                        access
                                                                                                </span>
                                                                                        ) : (
                                                                                                <ul className="flex flex-wrap gap-x-3 gap-y-1">
                                                                                                        {deptUnits.map(
                                                                                                                (
                                                                                                                        u,
                                                                                                                ) => (
                                                                                                                        <li
                                                                                                                                key={
                                                                                                                                        u.plant_department_id
                                                                                                                                }
                                                                                                                        >
                                                                                                                                <Link
                                                                                                                                        to={`/departments/${department.id}/plants/${u.plant.id}`}
                                                                                                                                        className={`text-sm ${linkClasses}`}
                                                                                                                                        aria-label={`${department.name} at ${u.plant.name}`}
                                                                                                                                >
                                                                                                                                        {
                                                                                                                                                u
                                                                                                                                                        .plant
                                                                                                                                                        .name
                                                                                                                                        }
                                                                                                                                </Link>
                                                                                                                        </li>
                                                                                                                ),
                                                                                                        )}
                                                                                                </ul>
                                                                                        )}
                                                                                </Td>
                                                                                <Td>
                                                                                        <ActiveBadge
                                                                                                active={
                                                                                                        department.is_active
                                                                                                }
                                                                                        />
                                                                                </Td>
                                                                        </tr>
                                                                )
                                                        })}
                                                </TBody>
                                        </Table>
                                </>
                        )}
                </>
        )
}
