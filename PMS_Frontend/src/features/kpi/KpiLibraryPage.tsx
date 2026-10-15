import { Plus, Search } from 'lucide-react'
import type { FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ActiveBadge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { CheckboxField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import {
        buttonClasses,
        cardClasses,
        inputClasses,
        linkClasses,
} from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listKpis, type KpiListParams } from '../../services/kpiApi'
import { listOrgUnits } from '../../services/organizationApi'
import { parseId, withParams } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { canWriteKpi } from '../auth/permissions'
import { OrgFilters } from '../organization/OrgFilters'
import { DIRECTION_LABELS } from './kpiLabels'

export function KpiLibraryPage() {
        const user = useCurrentUser()
        const [params, setParams] = useSearchParams()
        const request: KpiListParams = {
                plantId: parseId(params.get('plant_id')),
                departmentId: parseId(params.get('department_id')),
                search: (params.get('q') ?? '').trim() || undefined,
                includeInactive: params.get('inactive') === '1',
        }
        const kpis = useApiQuery(
                `kpis|${JSON.stringify(request)}`,
                (signal) => listKpis(request, signal),
                { keepPreviousData: true },
        )
        const units = useApiQuery('org-units', (signal) => listOrgUnits({}, signal))

        function handleSearch(event: FormEvent<HTMLFormElement>) {
                event.preventDefault()
                const value = new FormData(event.currentTarget).get('q')
                setParams(
                        withParams(params, {
                                q: typeof value === 'string' ? value.trim() : '',
                        }),
                )
        }

        return (
                <>
                        <PageHeader
                                title="KPI library"
                                description="Shared KPI (KRA) definitions. Each KPI states where it may be used: company-wide, a department at all plants, or one department at one plant. Targets and weightages are set per employee on the quarterly KPI sheet."
                                actions={
                                        <>
                                                <Link
                                                        to="/kpi/policies"
                                                        className={buttonClasses('secondary')}
                                                >
                                                        Scoring rules
                                                </Link>
                                                {canWriteKpi(user) && (
                                                        <Link
                                                                to="/kpi/library/new"
                                                                className={buttonClasses('primary')}
                                                        >
                                                                <Plus
                                                                        aria-hidden="true"
                                                                        className="size-4"
                                                                />
                                                                New KPI
                                                        </Link>
                                                )}
                                        </>
                                }
                        />
                        <section
                                aria-label="Filters"
                                className={`${cardClasses} mb-4 space-y-4 p-4`}
                        >
                                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                        <OrgFilters
                                                units={units.data ?? []}
                                                plantId={request.plantId}
                                                departmentId={request.departmentId}
                                                disabled={units.data === undefined}
                                                onChange={({ plantId, departmentId }) =>
                                                        setParams(
                                                                withParams(params, {
                                                                        plant_id: plantId,
                                                                        department_id: departmentId,
                                                                }),
                                                        )
                                                }
                                        />
                                        <form
                                                role="search"
                                                onSubmit={handleSearch}
                                                className="space-y-1"
                                        >
                                                <label
                                                        htmlFor="kpi-search"
                                                        className="block text-sm font-medium text-slate-800"
                                                >
                                                        Search by KPI name or code
                                                </label>
                                                <div className="flex gap-2">
                                                        <div className="relative flex-1">
                                                                <Search
                                                                        aria-hidden="true"
                                                                        className="pointer-events-none absolute top-3 left-3 size-4 text-slate-400"
                                                                />
                                                                <input
                                                                        key={request.search ?? ''}
                                                                        id="kpi-search"
                                                                        name="q"
                                                                        type="search"
                                                                        maxLength={100}
                                                                        defaultValue={
                                                                                request.search ?? ''
                                                                        }
                                                                        className={`${inputClasses} pl-9`}
                                                                />
                                                        </div>
                                                        <Button type="submit">Search</Button>
                                                </div>
                                        </form>
                                </div>
                                <p className="text-xs text-slate-600">
                                        With a plant and department chosen, the list shows the KPIs
                                        that may be used there.
                                </p>
                                <CheckboxField
                                        label="Include inactive KPIs"
                                        checked={request.includeInactive}
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
                        </section>

                        {kpis.isLoading ? (
                                <LoadingState label="Loading KPIs…" />
                        ) : kpis.error !== undefined || !kpis.data ? (
                                <ErrorState error={kpis.error} onRetry={kpis.reload} />
                        ) : kpis.data.length === 0 ? (
                                <EmptyState title="No KPIs found">
                                        No KPI in the library matches these filters within your
                                        access.
                                </EmptyState>
                        ) : (
                                <Table caption="KPI library" busy={kpis.isStale}>
                                        <thead>
                                                <tr>
                                                        <Th>KPI</Th>
                                                        <Th>Unit</Th>
                                                        <Th className="hidden md:table-cell">
                                                                Direction
                                                        </Th>
                                                        <Th className="hidden lg:table-cell">
                                                                Default scoring rule
                                                        </Th>
                                                        <Th>Applies to</Th>
                                                        <Th className="hidden sm:table-cell">
                                                                Status
                                                        </Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {kpis.data.map((kpi) => (
                                                        <tr key={kpi.id}>
                                                                <Td className="min-w-48">
                                                                        <Link
                                                                                to={`/kpi/library/${kpi.id}`}
                                                                                className={
                                                                                        linkClasses
                                                                                }
                                                                        >
                                                                                {kpi.name}
                                                                        </Link>
                                                                        <p className="font-mono text-xs text-slate-600">
                                                                                {kpi.code}
                                                                        </p>
                                                                </Td>
                                                                <Td>{kpi.unit}</Td>
                                                                <Td className="hidden md:table-cell">
                                                                        {
                                                                                DIRECTION_LABELS[
                                                                                        kpi
                                                                                                .direction
                                                                                ]
                                                                        }
                                                                </Td>
                                                                <Td className="hidden lg:table-cell">
                                                                        {
                                                                                kpi
                                                                                        .default_scoring_policy
                                                                                        .name
                                                                        }
                                                                </Td>
                                                                <Td>
                                                                        <ul className="space-y-0.5">
                                                                                {kpi.applicability.map(
                                                                                        (a) => (
                                                                                                <li
                                                                                                        key={
                                                                                                                a.label
                                                                                                        }
                                                                                                >
                                                                                                        {
                                                                                                                a.label
                                                                                                        }
                                                                                                </li>
                                                                                        ),
                                                                                )}
                                                                        </ul>
                                                                </Td>
                                                                <Td className="hidden sm:table-cell">
                                                                        <ActiveBadge
                                                                                active={
                                                                                        kpi.is_active
                                                                                }
                                                                        />
                                                                </Td>
                                                        </tr>
                                                ))}
                                        </TBody>
                                </Table>
                        )}
                </>
        )
}
