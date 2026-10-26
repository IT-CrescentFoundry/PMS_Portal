import { Calculator, Search } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { SelectField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { cardClasses, inputClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listQuarters } from '../../services/kpiApi'
import { calculateResults, listResults } from '../../services/scoresApi'
import type { CalculateResult, Quarter } from '../../types/api'
import { formatNumber, plural } from '../../utils/format'
import { unitLabel } from '../../utils/labels'
import { parseId, withParams } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { canWriteKpi } from '../auth/permissions'
import { quarterLabel } from '../kpi/kpiLabels'
import { SheetStatusBadge } from '../kpi/StatusBadges'
import { ResultStatusBadge } from './ScoreBadges'
import { currentScore, scoringQuarter } from './scoreLabels'

/** /scores/results */
export function ResultsPage() {
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
                                <PageHeader title="KPI results" />
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
        const user = useCurrentUser()
        const search = (params.get('q') ?? '').trim()
        const results = useApiQuery(
                `results|${quarter.id}|${search}`,
                (signal) =>
                        listResults({ quarterId: quarter.id, search: search || undefined }, signal),
                { keepPreviousData: true },
        )
        const calculate = useAction()
        const [counts, setCounts] = useState<CalculateResult | null>(null)

        async function handleCalculate() {
                setCounts(null)
                const result = await calculate.run(() => calculateResults(quarter.id))
                if (result) {
                        setCounts(result)
                        results.reload()
                }
        }

        function handleSearch(event: FormEvent<HTMLFormElement>) {
                event.preventDefault()
                const value = new FormData(event.currentTarget).get('q')
                setParams(withParams(params, { q: typeof value === 'string' ? value.trim() : '' }))
        }

        const rows = results.data?.rows ?? []
        return (
                <>
                        <PageHeader
                                title="KPI results"
                                description="Quarterly scores calculated from the monthly data, each KPI’s frozen scoring matrix and its weightage. A result is reviewed by the department, then published by the HR Head or CHRO; a published score is final."
                                actions={
                                        canWriteKpi(user) ? (
                                                <Button
                                                        variant="primary"
                                                        isLoading={calculate.busy}
                                                        onClick={handleCalculate}
                                                >
                                                        <Calculator
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        Calculate scores
                                                </Button>
                                        ) : undefined
                                }
                        />
                        <div className="space-y-4">
                                <ActionError
                                        error={calculate.error}
                                        title="Scores were not calculated"
                                />
                                {counts && (
                                        <Alert title="Calculation finished">
                                                {plural(counts.calculated, 'sheet')} calculated,{' '}
                                                {formatNumber(counts.unchanged)} unchanged and{' '}
                                                {formatNumber(counts.published)} already published;{' '}
                                                {plural(counts.complete, 'sheet')} have every
                                                month’s data.
                                        </Alert>
                                )}
                                <div
                                        className={`${cardClasses} grid grid-cols-1 items-end gap-4 p-4 md:grid-cols-2`}
                                >
                                        <SelectField
                                                label="Quarter"
                                                value={String(quarter.id)}
                                                onChange={(e) =>
                                                        setParams(
                                                                withParams(params, {
                                                                        quarter: e.target.value,
                                                                }),
                                                        )
                                                }
                                                options={quarters.map((q) => ({
                                                        value: String(q.id),
                                                        label: quarterLabel(q),
                                                }))}
                                        />
                                        <form
                                                role="search"
                                                onSubmit={handleSearch}
                                                className="flex gap-2"
                                        >
                                                <label htmlFor="results-search" className="sr-only">
                                                        Search by employee name or code
                                                </label>
                                                <input
                                                        id="results-search"
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
                                        <LoadingState label="Loading results…" />
                                ) : results.error !== undefined || !results.data ? (
                                        <ErrorState
                                                error={results.error}
                                                onRetry={results.reload}
                                        />
                                ) : rows.length === 0 ? (
                                        <EmptyState title="No published or locked KPI sheets">
                                                Scores are calculated for KPI sheets that are
                                                published or locked in {quarter.name}.
                                        </EmptyState>
                                ) : (
                                        <Table
                                                caption={`KPI results for ${quarter.name}`}
                                                busy={results.isStale}
                                        >
                                                <thead>
                                                        <tr>
                                                                <Th>Employee</Th>
                                                                <Th className="hidden md:table-cell">
                                                                        Assignment
                                                                </Th>
                                                                <Th className="hidden lg:table-cell">
                                                                        Sheet
                                                                </Th>
                                                                <Th>Result</Th>
                                                                <Th align="right">Score</Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {rows.map((row) => {
                                                                const score = row.result
                                                                        ? currentScore(row.result)
                                                                        : null
                                                                return (
                                                                        <tr key={row.sheet.id}>
                                                                                <Td>
                                                                                        <Link
                                                                                                to={`/scores/results/${row.sheet.id}`}
                                                                                                className={
                                                                                                        linkClasses
                                                                                                }
                                                                                        >
                                                                                                {
                                                                                                        row
                                                                                                                .assignment
                                                                                                                .employee
                                                                                                                .full_name
                                                                                                }
                                                                                        </Link>
                                                                                        <div className="text-xs text-slate-600">
                                                                                                {
                                                                                                        row
                                                                                                                .assignment
                                                                                                                .employee
                                                                                                                .employee_code
                                                                                                }
                                                                                        </div>
                                                                                </Td>
                                                                                <Td className="hidden md:table-cell">
                                                                                        {unitLabel(
                                                                                                row
                                                                                                        .assignment
                                                                                                        .department,
                                                                                                row
                                                                                                        .assignment
                                                                                                        .plant,
                                                                                        )}
                                                                                </Td>
                                                                                <Td className="hidden lg:table-cell">
                                                                                        <SheetStatusBadge
                                                                                                status={
                                                                                                        row
                                                                                                                .sheet
                                                                                                                .status
                                                                                                }
                                                                                        />
                                                                                </Td>
                                                                                <Td>
                                                                                        <div className="flex flex-wrap gap-1">
                                                                                                <ResultStatusBadge
                                                                                                        status={
                                                                                                                row
                                                                                                                        .result
                                                                                                                        ?.status ??
                                                                                                                null
                                                                                                        }
                                                                                                />
                                                                                                {row
                                                                                                        .result
                                                                                                        ?.stale && (
                                                                                                        <Badge tone="warning">
                                                                                                                Data
                                                                                                                changed
                                                                                                        </Badge>
                                                                                                )}
                                                                                                {row.result &&
                                                                                                        !row
                                                                                                                .result
                                                                                                                .is_complete && (
                                                                                                                <Badge>
                                                                                                                        Data
                                                                                                                        missing
                                                                                                                </Badge>
                                                                                                        )}
                                                                                                {row
                                                                                                        .result
                                                                                                        ?.pending_override_id && (
                                                                                                        <Badge tone="info">
                                                                                                                Override
                                                                                                                pending
                                                                                                        </Badge>
                                                                                                )}
                                                                                        </div>
                                                                                </Td>
                                                                                <Td align="right">
                                                                                        {score ? (
                                                                                                <>
                                                                                                        <span className="font-semibold">
                                                                                                                {
                                                                                                                        score.text
                                                                                                                }
                                                                                                        </span>
                                                                                                        <div className="text-xs text-slate-600">
                                                                                                                {
                                                                                                                        score.note
                                                                                                                }
                                                                                                        </div>
                                                                                                </>
                                                                                        ) : (
                                                                                                '—'
                                                                                        )}
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
