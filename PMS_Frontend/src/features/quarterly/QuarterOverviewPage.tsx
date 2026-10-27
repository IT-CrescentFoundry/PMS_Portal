import { ArrowRight, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { ReasonForm } from '../../components/common/ReasonForm'
import { StatCard } from '../../components/common/StatCard'
import { buttonClasses, cardClasses } from '../../components/common/styles'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listQuarters } from '../../services/kpiApi'
import { getQuarterOverview, publishQuarter, transitionQuarter } from '../../services/quarterlyApi'
import type { Quarter, QuarterOverview } from '../../types/api'
import { formatDate, plural } from '../../utils/format'
import { parseId, withParams } from '../../utils/params'
import { QuarterVersions } from '../corrections/QuarterVersions'
import { QuarterStatusBadge } from '../kpi/StatusBadges'
import { scoringQuarter } from '../scores/scoreLabels'
import { phaseLabel } from './quarterLabels'
import { PhaseStepper, QuarterSelect } from './QuarterParts'

/** /scores/quarter */
export function QuarterOverviewPage() {
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
                                <PageHeader title="Quarterly performance overview" />
                                <EmptyState title="No PMS cycle has been set up yet" />
                        </>
                )
        }
        return (
                <Overview
                        key={quarter.id}
                        quarters={quarters.data}
                        quarter={quarter}
                        onQuarter={(id) =>
                                setParams(withParams(params, { quarter: id }), { replace: true })
                        }
                        onChanged={quarters.reload}
                />
        )
}

function Overview({
        quarters,
        quarter,
        onQuarter,
        onChanged,
}: {
        quarters: Quarter[]
        quarter: Quarter
        onQuarter: (id: number) => void
        onChanged: () => void
}) {
        const query = useApiQuery(`quarter-overview|${quarter.id}`, (signal) =>
                getQuarterOverview(quarter.id, signal),
        )
        const action = useAction()
        const [mode, setMode] = useState<'idle' | 'return' | 'publish'>('idle')
        const [message, setMessage] = useState<string | null>(null)
        const [current, setCurrent] = useState<QuarterOverview | null>(null)
        const overview = current ?? query.data

        async function run(change: () => Promise<QuarterOverview>, done: string) {
                setMessage(null)
                const updated = await action.run(change)
                if (updated) {
                        setCurrent(updated)
                        setMode('idle')
                        setMessage(done)
                        onChanged()
                }
        }

        const header = (
                <PageHeader
                        title="Quarterly performance overview"
                        description="The quarter moves through data collection, department review, normalization and publication. Each step checks the whole company; HR takes the steps, and a published quarter never changes."
                        meta={
                                overview ? (
                                        <QuarterStatusBadge status={overview.quarter.status} />
                                ) : undefined
                        }
                />
        )
        if (query.isLoading && !overview) {
                return (
                        <>
                                {header}
                                <LoadingState label="Loading the quarter…" />
                        </>
                )
        }
        if (!overview) {
                return (
                        <>
                                {header}
                                <ErrorState error={query.error} onRetry={query.reload} />
                        </>
                )
        }
        const { sheets, employees, cohorts, actions } = overview
        const status = overview.quarter.status
        const q = overview.quarter.id
        return (
                <>
                        {header}
                        <div className="space-y-4">
                                <div className={`${cardClasses} max-w-xl p-4`}>
                                        <QuarterSelect
                                                quarters={quarters}
                                                quarter={quarter}
                                                onChange={onQuarter}
                                        />
                                </div>
                                <PhaseStepper status={status} />
                                {message && <Alert title={message} />}
                                <ActionError
                                        error={action.error}
                                        title="The quarter did not move"
                                />
                                {status === 'PUBLISHED' && (
                                        <Alert title="Published and locked">
                                                Published by{' '}
                                                {overview.published_by?.username ?? '—'} on{' '}
                                                {formatDate(overview.published_at)}. Scores, groups
                                                and ratings are final; a published version never
                                                changes, and a correction becomes a new version.
                                        </Alert>
                                )}
                                {status === 'PUBLISHED' && <QuarterVersions overview={overview} />}
                                {overview.unscorable_sheets > 0 && (
                                        <Alert
                                                tone="warning"
                                                title={`${plural(overview.unscorable_sheets, 'KPI sheet')} not scored`}
                                        >
                                                These sheets were not published before scoring
                                                started, so they are not scored this quarter.
                                        </Alert>
                                )}

                                <section aria-labelledby="sheets-heading" className="space-y-2">
                                        <h2
                                                id="sheets-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Assignment results (KPI sheets)
                                        </h2>
                                        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
                                                <StatCard
                                                        label="Locked sheets"
                                                        value={sheets.locked}
                                                />
                                                <StatCard
                                                        label="Calculated"
                                                        value={sheets.calculated}
                                                />
                                                <StatCard
                                                        label="Complete and current"
                                                        value={sheets.complete}
                                                />
                                                <StatCard
                                                        label="Reviewed"
                                                        value={sheets.reviewed}
                                                />
                                                <StatCard
                                                        label="Data changed"
                                                        value={sheets.stale}
                                                        tone={sheets.stale ? 'warning' : 'default'}
                                                />
                                                <StatCard
                                                        label="Overrides pending"
                                                        value={sheets.pending_overrides}
                                                        tone={
                                                                sheets.pending_overrides
                                                                        ? 'warning'
                                                                        : 'default'
                                                        }
                                                />
                                                <StatCard
                                                        label="Published"
                                                        value={sheets.published}
                                                />
                                        </dl>
                                </section>
                                <section aria-labelledby="people-heading" className="space-y-2">
                                        <h2
                                                id="people-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Employees and normalization
                                        </h2>
                                        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
                                                <StatCard
                                                        label="Employees"
                                                        value={employees.total}
                                                        hint="Each counted once"
                                                />
                                                <StatCard
                                                        label="Score ready"
                                                        value={employees.ready}
                                                />
                                                <StatCard
                                                        label="Cross-plant"
                                                        value={employees.multi_assignment}
                                                />
                                                <StatCard
                                                        label="Weights needed"
                                                        value={employees.weights_needed}
                                                        tone={
                                                                employees.weights_needed
                                                                        ? 'warning'
                                                                        : 'default'
                                                        }
                                                />
                                                <StatCard label="Cohorts" value={cohorts.total} />
                                                <StatCard
                                                        label="Cohorts approved"
                                                        value={cohorts.approved}
                                                />
                                                <StatCard
                                                        label="Placements needed"
                                                        value={cohorts.unresolved}
                                                        tone={
                                                                cohorts.unresolved
                                                                        ? 'warning'
                                                                        : 'default'
                                                        }
                                                />
                                        </dl>
                                </section>
                                <nav aria-label="Quarter pages" className="flex flex-wrap gap-2">
                                        <Link
                                                to={`/scores/results?quarter=${q}`}
                                                className={buttonClasses('secondary', 'sm')}
                                        >
                                                Department review
                                        </Link>
                                        <Link
                                                to={`/scores/employees?quarter=${q}`}
                                                className={buttonClasses('secondary', 'sm')}
                                        >
                                                Employee results
                                        </Link>
                                        <Link
                                                to={`/scores/normalization?quarter=${q}`}
                                                className={buttonClasses('secondary', 'sm')}
                                        >
                                                Normalization
                                        </Link>
                                        <Link
                                                to={`/scores/data?quarter=${q}`}
                                                className={buttonClasses('secondary', 'sm')}
                                        >
                                                Monthly KPI data
                                        </Link>
                                </nav>

                                {(actions.can_advance ||
                                        actions.can_return ||
                                        actions.can_publish) && (
                                        <section
                                                aria-labelledby="next-heading"
                                                className={`${cardClasses} space-y-3 p-4`}
                                        >
                                                <h2
                                                        id="next-heading"
                                                        className="text-base font-semibold text-slate-900"
                                                >
                                                        {actions.can_publish
                                                                ? 'Publication'
                                                                : `Next step: ${phaseLabel(overview.next_status)}`}
                                                </h2>
                                                {overview.blockers.length > 0 ? (
                                                        <Alert
                                                                tone="warning"
                                                                title={`${plural(overview.blockers.length, 'item')} to resolve first`}
                                                        >
                                                                <ul className="list-disc space-y-0.5 pl-5">
                                                                        {overview.blockers
                                                                                .slice(0, 50)
                                                                                .map((b) => (
                                                                                        <li key={b}>
                                                                                                {b}
                                                                                        </li>
                                                                                ))}
                                                                </ul>
                                                                {overview.blockers.length > 50 && (
                                                                        <p>
                                                                                …and{' '}
                                                                                {overview.blockers
                                                                                        .length -
                                                                                        50}{' '}
                                                                                more.
                                                                        </p>
                                                                )}
                                                        </Alert>
                                                ) : (
                                                        <p className="text-sm text-slate-700">
                                                                Every check for this step passes
                                                                company-wide.
                                                        </p>
                                                )}
                                                {mode === 'idle' && (
                                                        <div className="flex flex-wrap gap-2">
                                                                {actions.can_advance &&
                                                                        overview.next_status && (
                                                                                <Button
                                                                                        variant="primary"
                                                                                        isLoading={
                                                                                                action.busy
                                                                                        }
                                                                                        disabled={
                                                                                                overview
                                                                                                        .blockers
                                                                                                        .length >
                                                                                                0
                                                                                        }
                                                                                        onClick={() =>
                                                                                                run(
                                                                                                        () =>
                                                                                                                transitionQuarter(
                                                                                                                        q,
                                                                                                                        overview.next_status!,
                                                                                                                ),
                                                                                                        `Moved to ${phaseLabel(overview.next_status)}.`,
                                                                                                )
                                                                                        }
                                                                                >
                                                                                        <ArrowRight
                                                                                                aria-hidden="true"
                                                                                                className="size-4"
                                                                                        />
                                                                                        Move to{' '}
                                                                                        {phaseLabel(
                                                                                                overview.next_status,
                                                                                        )}
                                                                                </Button>
                                                                        )}
                                                                {actions.can_publish && (
                                                                        <Button
                                                                                variant="primary"
                                                                                disabled={
                                                                                        action.busy ||
                                                                                        overview
                                                                                                .blockers
                                                                                                .length >
                                                                                                0
                                                                                }
                                                                                onClick={() =>
                                                                                        setMode(
                                                                                                'publish',
                                                                                        )
                                                                                }
                                                                        >
                                                                                Publish the
                                                                                quarter’s scores…
                                                                        </Button>
                                                                )}
                                                                {actions.can_return &&
                                                                        overview.previous_status && (
                                                                                <Button
                                                                                        disabled={
                                                                                                action.busy
                                                                                        }
                                                                                        onClick={() =>
                                                                                                setMode(
                                                                                                        'return',
                                                                                                )
                                                                                        }
                                                                                >
                                                                                        <Undo2
                                                                                                aria-hidden="true"
                                                                                                className="size-4"
                                                                                        />
                                                                                        Return to{' '}
                                                                                        {phaseLabel(
                                                                                                overview.previous_status,
                                                                                        )}
                                                                                        …
                                                                                </Button>
                                                                        )}
                                                        </div>
                                                )}
                                                {mode === 'return' && overview.previous_status && (
                                                        <ReasonForm
                                                                label={`Why does the quarter return to ${phaseLabel(overview.previous_status).toLowerCase()}?`}
                                                                hint="At least 10 characters; recorded in the audit trail."
                                                                minLength={10}
                                                                submitLabel={`Return to ${phaseLabel(overview.previous_status)}`}
                                                                busy={action.busy}
                                                                onSubmit={(reason) =>
                                                                        run(
                                                                                () =>
                                                                                        transitionQuarter(
                                                                                                q,
                                                                                                overview.previous_status!,
                                                                                                reason,
                                                                                        ),
                                                                                `Returned to ${phaseLabel(overview.previous_status)}.`,
                                                                        )
                                                                }
                                                                onCancel={() => setMode('idle')}
                                                        />
                                                )}
                                                {mode === 'publish' && (
                                                        <Alert
                                                                tone="warning"
                                                                title="Publishing is final"
                                                                action={
                                                                        <div className="flex flex-wrap gap-2">
                                                                                <Button
                                                                                        variant="primary"
                                                                                        isLoading={
                                                                                                action.busy
                                                                                        }
                                                                                        onClick={() =>
                                                                                                run(
                                                                                                        () =>
                                                                                                                publishQuarter(
                                                                                                                        q,
                                                                                                                ),
                                                                                                        'Published. The quarter is locked.',
                                                                                                )
                                                                                        }
                                                                                >
                                                                                        Publish{' '}
                                                                                        {plural(
                                                                                                employees.total,
                                                                                                'employee score',
                                                                                        )}
                                                                                </Button>
                                                                                <Button
                                                                                        variant="ghost"
                                                                                        onClick={() =>
                                                                                                setMode(
                                                                                                        'idle',
                                                                                                )
                                                                                        }
                                                                                >
                                                                                        Cancel
                                                                                </Button>
                                                                        </div>
                                                                }
                                                        >
                                                                Every KPI sheet result, employee
                                                                score, group and rating of{' '}
                                                                {overview.quarter.name} is published
                                                                together and can never change
                                                                afterwards.
                                                        </Alert>
                                                )}
                                        </section>
                                )}
                        </div>
                </>
        )
}
