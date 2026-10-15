import { Plus, Search } from 'lucide-react'
import type { FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Button } from '../../components/common/Button'
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
import { listJDs, type JDListParams } from '../../services/jdApi'
import { listOrgUnits } from '../../services/organizationApi'
import { formatDate } from '../../utils/format'
import { parseId, withParams } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { canWriteJD } from '../auth/permissions'
import { OrgFilters } from '../organization/OrgFilters'
import { JDStatusBadge } from './JDStatusBadge'

export function JDListPage() {
        const user = useCurrentUser()
        const [params, setParams] = useSearchParams()
        const request: JDListParams = {
                search: (params.get('q') ?? '').trim() || undefined,
                plantId: parseId(params.get('plant_id')),
                departmentId: parseId(params.get('department_id')),
        }
        const jds = useApiQuery(
                `jds|${JSON.stringify(request)}`,
                (signal) => listJDs(request, signal),
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
                                title="Job descriptions"
                                description="One standardized JD per unique role. Several roles can share a designation (e.g. two different Quality Engineer roles), each with its own JD and sign-off."
                                actions={
                                        canWriteJD(user) && (
                                                <Link
                                                        to="/jds/new"
                                                        className={buttonClasses('primary')}
                                                >
                                                        <Plus
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        New JD
                                                </Link>
                                        )
                                }
                        />
                        <section
                                aria-label="Filters"
                                className={`${cardClasses} mb-4 grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3`}
                        >
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
                                <form role="search" onSubmit={handleSearch} className="space-y-1">
                                        <label
                                                htmlFor="jd-search"
                                                className="block text-sm font-medium text-slate-800"
                                        >
                                                Search by role title or JD code
                                        </label>
                                        <div className="flex gap-2">
                                                <div className="relative flex-1">
                                                        <Search
                                                                aria-hidden="true"
                                                                className="pointer-events-none absolute top-3 left-3 size-4 text-slate-400"
                                                        />
                                                        <input
                                                                key={request.search ?? ''}
                                                                id="jd-search"
                                                                name="q"
                                                                type="search"
                                                                maxLength={100}
                                                                defaultValue={request.search ?? ''}
                                                                className={`${inputClasses} pl-9`}
                                                        />
                                                </div>
                                                <Button type="submit">Search</Button>
                                        </div>
                                </form>
                        </section>

                        {jds.isLoading ? (
                                <LoadingState label="Loading job descriptions…" />
                        ) : jds.error !== undefined || !jds.data ? (
                                <ErrorState error={jds.error} onRetry={jds.reload} />
                        ) : jds.data.length === 0 ? (
                                <EmptyState title="No job descriptions found">
                                        {canWriteJD(user)
                                                ? 'Create the first JD for a role in your department.'
                                                : 'No JDs exist in your access yet.'}
                                </EmptyState>
                        ) : (
                                <Table caption="Job descriptions" busy={jds.isStale}>
                                        <thead>
                                                <tr>
                                                        <Th>Role</Th>
                                                        <Th>Department · plant</Th>
                                                        <Th className="hidden md:table-cell">
                                                                Designation
                                                        </Th>
                                                        <Th>Approved</Th>
                                                        <Th>In progress</Th>
                                                        <Th className="hidden lg:table-cell">
                                                                Updated
                                                        </Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {jds.data.map((jd) => (
                                                        <tr key={jd.id}>
                                                                <Td className="min-w-48">
                                                                        <Link
                                                                                to={`/jds/${jd.id}`}
                                                                                className={
                                                                                        linkClasses
                                                                                }
                                                                        >
                                                                                {jd.title}
                                                                        </Link>
                                                                        <p className="font-mono text-xs text-slate-600">
                                                                                {jd.code}
                                                                        </p>
                                                                </Td>
                                                                <Td>
                                                                        {jd.department.name} ·{' '}
                                                                        {jd.plant?.name ??
                                                                                'All plants'}
                                                                </Td>
                                                                <Td className="hidden md:table-cell">
                                                                        {jd.designation?.name ??
                                                                                '—'}
                                                                </Td>
                                                                <Td>
                                                                        {jd.approved_version
                                                                                ? `Version ${jd.approved_version.version_no}`
                                                                                : 'Not yet'}
                                                                </Td>
                                                                <Td>
                                                                        {jd.open_version ? (
                                                                                <JDStatusBadge
                                                                                        version={
                                                                                                jd.open_version
                                                                                        }
                                                                                />
                                                                        ) : (
                                                                                '—'
                                                                        )}
                                                                </Td>
                                                                <Td className="hidden lg:table-cell">
                                                                        {formatDate(jd.updated_at)}
                                                                </Td>
                                                        </tr>
                                                ))}
                                        </TBody>
                                </Table>
                        )}
                </>
        )
}
