import { Search } from 'lucide-react'
import type { FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { cardClasses, inputClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listQuarters } from '../../services/kpiApi'
import { listEmployeeResults } from '../../services/quarterlyApi'
import type { Quarter } from '../../types/api'
import { unitLabel } from '../../utils/labels'
import { parseId, withParams } from '../../utils/params'
import { scoreText, scoringQuarter } from '../scores/scoreLabels'
import { EMPLOYEE_STATUS } from './quarterLabels'
import { QuarterSelect } from './QuarterParts'

/** /scores/employees */
export function EmployeeResultsPage() {
        const [params, setParams] = useSearchParams()
        const quarters = useApiQuery('quarters', (signal) => listQuarters(signal))
        if (quarters.isLoading) return <LoadingState label="Loading quarters…" />
        if (quarters.error !== undefined || !quarters.data)
                return <ErrorState error={quarters.error} onRetry={quarters.reload} />
        const chosen = parseId(params.get('quarter'))
        const quarter = quarters.data.find((q) => q.id === chosen) ?? scoringQuarter(quarters.data)
        if (!quarter) {
                return (
                        <>
                                <PageHeader title="Employee results" />
                                <EmptyState title="No PMS cycle has been set up yet" />
                        </>
                )
        }
        return (
                <Results
                        quarters={quarters.data}
                        quarter={quarter}
                        params={params}
                        setParams={(next) => setParams(next, { replace: true })}
                />
        )
}

function Results({
        quarters,
        quarter,
        params,
        setParams,
}: {
        quarters: Quarter[]
        quarter: Quarter
        params: URLSearchParams
        setParams: (params: URLSearchParams) => void
}) {
        const search = (params.get('q') ?? '').trim()
        const results = useApiQuery(
                `employee-results|${quarter.id}|${search}`,
                (signal) =>
                        listEmployeeResults(
                                { quarterId: quarter.id, search: search || undefined },
                                signal,
                        ),
                { keepPreviousData: true },
        )

        function handleSearch(event: FormEvent<HTMLFormElement>) {
                event.preventDefault()
                const value = new FormData(event.currentTarget).get('q')
                setParams(withParams(params, { q: typeof value === 'string' ? value.trim() : '' }))
        }

        return (
                <>
                        <PageHeader
                                title="Employee results"
                                description="Each employee once, with their quarterly score built from every scored assignment. One assignment counts 100 %; an employee working in several units needs contribution weights totalling 100 %, never a plain average. Shown to readers of the employee’s home unit."
                        />
                        <div className="space-y-4">
                                <div
                                        className={`${cardClasses} grid grid-cols-1 items-end gap-4 p-4 md:grid-cols-2`}
                                >
                                        <QuarterSelect
                                                quarters={quarters}
                                                quarter={quarter}
                                                onChange={(id) =>
                                                        setParams(
                                                                withParams(params, { quarter: id }),
                                                        )
                                                }
                                        />
                                        <form
                                                role="search"
                                                onSubmit={handleSearch}
                                                className="flex gap-2"
                                        >
                                                <label
                                                        htmlFor="employee-results-search"
                                                        className="sr-only"
                                                >
                                                        Search by employee name or code
                                                </label>
                                                <input
                                                        id="employee-results-search"
                                                        name="q"
                                                        type="search"
                                                        defaultValue={search}
                                                        placeholder="Employee name or code"
                                                        className={inputClasses}
                                                />
                                                <Button type="submit">
                                                        <Search
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        Search
                                                </Button>
                                        </form>
                                </div>
                                {results.isLoading ? (
                                        <LoadingState label="Loading employee results…" />
                                ) : results.error !== undefined || !results.data ? (
                                        <ErrorState
                                                error={results.error}
                                                onRetry={results.reload}
                                        />
                                ) : results.data.length === 0 ? (
                                        <EmptyState title="No employee results">
                                                Employees appear once they have a locked KPI sheet
                                                in {quarter.name} within your access.
                                        </EmptyState>
                                ) : (
                                        <Table
                                                caption={`Employee results for ${quarter.name}`}
                                                busy={results.isStale}
                                        >
                                                <thead>
                                                        <tr>
                                                                <Th>Employee</Th>
                                                                <Th className="hidden md:table-cell">
                                                                        Home unit
                                                                </Th>
                                                                <Th>Status</Th>
                                                                <Th align="right">Score</Th>
                                                                <Th>Group and rating</Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {results.data.map((r) => {
                                                                const status =
                                                                        EMPLOYEE_STATUS[r.status]
                                                                return (
                                                                        <tr key={r.employee.id}>
                                                                                <Td>
                                                                                        <Link
                                                                                                to={`/scores/quarters/${quarter.id}/employees/${r.employee.id}`}
                                                                                                className={
                                                                                                        linkClasses
                                                                                                }
                                                                                        >
                                                                                                {
                                                                                                        r
                                                                                                                .employee
                                                                                                                .full_name
                                                                                                }
                                                                                        </Link>
                                                                                        <div className="text-xs text-slate-600">
                                                                                                {
                                                                                                        r
                                                                                                                .employee
                                                                                                                .employee_code
                                                                                                }
                                                                                                {r
                                                                                                        .components
                                                                                                        .length >
                                                                                                        1 &&
                                                                                                        ` · ${r.components.length} assignments`}
                                                                                        </div>
                                                                                </Td>
                                                                                <Td className="hidden md:table-cell">
                                                                                        {r.home_plant &&
                                                                                        r.home_department
                                                                                                ? unitLabel(
                                                                                                          r.home_department,
                                                                                                          r.home_plant,
                                                                                                  )
                                                                                                : '—'}
                                                                                </Td>
                                                                                <Td>
                                                                                        <div className="flex flex-wrap gap-1">
                                                                                                <Badge
                                                                                                        tone={
                                                                                                                status.tone
                                                                                                        }
                                                                                                >
                                                                                                        {
                                                                                                                status.label
                                                                                                        }
                                                                                                </Badge>
                                                                                                {r.status ===
                                                                                                        'LIVE' &&
                                                                                                        !r.ready && (
                                                                                                                <Badge tone="warning">
                                                                                                                        {
                                                                                                                                r
                                                                                                                                        .issues
                                                                                                                                        .length
                                                                                                                        }{' '}
                                                                                                                        open
                                                                                                                        item(s)
                                                                                                                </Badge>
                                                                                                        )}
                                                                                        </div>
                                                                                </Td>
                                                                                <Td align="right">
                                                                                        <span className="font-semibold">
                                                                                                {scoreText(
                                                                                                        r.final_score,
                                                                                                )}
                                                                                        </span>
                                                                                </Td>
                                                                                <Td>
                                                                                        {r.normalization
                                                                                                ? `${r.normalization.group_label ?? 'Not placed yet'}${r.normalization.normalized_rating ? ` · rating ${r.normalization.normalized_rating}` : ''}`
                                                                                                : '—'}
                                                                                </Td>
                                                                        </tr>
                                                                )
                                                        })}
                                                </TBody>
                                        </Table>
                                )}
                        </div>
                </>
        )
}
