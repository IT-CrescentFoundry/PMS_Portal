import { Search } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { ActiveBadge } from '../../components/common/Badge'
import { CheckboxField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { inputClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listOrgUnits, listPlants } from '../../services/organizationApi'
import { plural } from '../../utils/format'
import { withParams } from '../../utils/params'
import { groupUnits } from '../organization/orgUnits'

export function PlantsPage() {
        const [params, setParams] = useSearchParams()
        const includeInactive = params.get('inactive') === '1'
        const search = params.get('q') ?? ''

        // Plants + their accessible units in two requests (never one per plant).
        const query = useApiQuery(
                `plants|${includeInactive}`,
                (signal) =>
                        Promise.all([
                                listPlants(includeInactive, signal),
                                listOrgUnits({ includeInactive }, signal),
                        ]),
                { keepPreviousData: true },
        )

        // The full accessible list is loaded (no pagination), so filtering it
        // locally is complete and cannot reveal anything the API did not return.
        const term = search.trim().toLowerCase()
        const [plants, units] = query.data ?? [[], []]
        const unitsByPlant = groupUnits(units, 'plant')
        const visible = plants.filter((p) =>
                [p.code, p.name, p.location ?? ''].some((v) => v.toLowerCase().includes(term)),
        )

        return (
                <>
                        <PageHeader
                                title="Plants"
                                description="Plants you can access, with the departments set up at each one."
                        />
                        <div className="mb-4 flex flex-wrap items-end gap-4">
                                <div className="w-full max-w-xs space-y-1">
                                        <label htmlFor="plant-search" className="block text-sm font-medium text-slate-800">
                                                Search plants
                                        </label>
                                        <div className="relative">
                                                <Search aria-hidden="true" className="pointer-events-none absolute top-3 left-3 size-4 text-slate-400" />
                                                <input
                                                        id="plant-search"
                                                        type="search"
                                                        className={`${inputClasses} pl-9`}
                                                        placeholder="Code, name or location"
                                                        value={search}
                                                        onChange={(e) => setParams(withParams(params, { q: e.target.value }), { replace: true })}
                                                />
                                        </div>
                                </div>
                                <div className="pb-2">
                                        <CheckboxField
                                                label="Show inactive plants"
                                                checked={includeInactive}
                                                onChange={(e) => setParams(withParams(params, { inactive: e.target.checked ? '1' : '' }))}
                                        />
                                </div>
                        </div>

                        {query.isLoading ? (
                                <LoadingState label="Loading plants…" />
                        ) : query.error ? (
                                <ErrorState error={query.error} onRetry={query.reload} />
                        ) : plants.length === 0 ? (
                                <EmptyState title="No plants in your access">
                                        Your account does not include any plants. Contact your PMS administrator if this is unexpected.
                                </EmptyState>
                        ) : visible.length === 0 ? (
                                <EmptyState title="No plants match your search">Try a different code, name or location.</EmptyState>
                        ) : (
                                <>
                                        <p className="mb-2 text-sm text-slate-600" aria-live="polite">
                                                {query.isStale ? 'Updating…' : plural(visible.length, 'plant')}
                                        </p>
                                        <Table caption="Plants" busy={query.isStale}>
                                                <thead>
                                                        <tr>
                                                                <Th>Code</Th>
                                                                <Th>Plant</Th>
                                                                <Th>Location</Th>
                                                                <Th>Departments</Th>
                                                                <Th>Status</Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {visible.map((plant) => {
                                                                const plantUnits = unitsByPlant.get(plant.id) ?? []
                                                                return (
                                                                        <tr key={plant.id}>
                                                                                <Td className="font-mono text-xs text-slate-700">{plant.code}</Td>
                                                                                <Td>
                                                                                        <Link to={`/plants/${plant.id}`} className={linkClasses}>
                                                                                                {plant.name}
                                                                                        </Link>
                                                                                </Td>
                                                                                <Td>{plant.location ?? <span className="text-slate-500">Not recorded</span>}</Td>
                                                                                <Td>
                                                                                        {plantUnits.length === 0 ? (
                                                                                                <span className="text-slate-500">None in your access</span>
                                                                                        ) : (
                                                                                                plantUnits.map((u) => u.department.name).join(', ')
                                                                                        )}
                                                                                </Td>
                                                                                <Td>
                                                                                        <ActiveBadge active={plant.is_active} />
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
