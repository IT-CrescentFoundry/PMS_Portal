import { Link, useSearchParams } from 'react-router'
import { Badge } from '../../components/common/Badge'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listQuarters } from '../../services/kpiApi'
import { listCohorts } from '../../services/quarterlyApi'
import type { Quarter } from '../../types/api'
import { parseId, withParams } from '../../utils/params'
import { scoringQuarter } from '../scores/scoreLabels'
import { distributionText } from './quarterLabels'
import { CohortStatusBadge, QuarterSelect } from './QuarterParts'

/** /scores/normalization */
export function NormalizationPage() {
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
                                <PageHeader title="Normalization" />
                                <EmptyState title="No PMS cycle has been set up yet" />
                        </>
                )
        }
        return (
                <Cohorts
                        quarters={quarters.data}
                        quarter={quarter}
                        onQuarter={(id) =>
                                setParams(withParams(params, { quarter: id }), { replace: true })
                        }
                />
        )
}

function Cohorts({
        quarters,
        quarter,
        onQuarter,
}: {
        quarters: Quarter[]
        quarter: Quarter
        onQuarter: (id: number) => void
}) {
        const cohorts = useApiQuery(`cohorts|${quarter.id}`, (signal) =>
                listCohorts(quarter.id, signal),
        )
        return (
                <>
                        <PageHeader
                                title="Normalization"
                                description="Cohorts are formed when the quarter enters normalization, under the approved normalization policy in force on the quarter’s start date. Each employee is counted once, in the cohort of their home unit. Actual group sizes are shown next to the targets; ties and small cohorts follow the policy, or are placed by an authorized reviewer."
                        />
                        <div className="space-y-4">
                                <div className={`${cardClasses} max-w-xl p-4`}>
                                        <QuarterSelect
                                                quarters={quarters}
                                                quarter={quarter}
                                                onChange={onQuarter}
                                        />
                                </div>
                                {cohorts.isLoading ? (
                                        <LoadingState label="Loading cohorts…" />
                                ) : cohorts.error !== undefined || !cohorts.data ? (
                                        <ErrorState
                                                error={cohorts.error}
                                                onRetry={cohorts.reload}
                                        />
                                ) : cohorts.data.length === 0 ? (
                                        <EmptyState title="No cohorts for this quarter">
                                                Cohorts appear when HR moves {quarter.name} into
                                                normalization, for the employees within your access.
                                        </EmptyState>
                                ) : (
                                        <Table caption={`Normalization cohorts of ${quarter.name}`}>
                                                <thead>
                                                        <tr>
                                                                <Th>Cohort</Th>
                                                                <Th align="right">Employees</Th>
                                                                <Th>Groups: actual · target</Th>
                                                                <Th>Status</Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {cohorts.data.map((c) => (
                                                                <tr key={c.id}>
                                                                        <Td>
                                                                                <Link
                                                                                        to={`/scores/normalization/${c.id}`}
                                                                                        className={
                                                                                                linkClasses
                                                                                        }
                                                                                >
                                                                                        {
                                                                                                c.cohort_label
                                                                                        }
                                                                                </Link>
                                                                                <div className="text-xs text-slate-600">
                                                                                        {
                                                                                                c
                                                                                                        .policy
                                                                                                        .code
                                                                                        }{' '}
                                                                                        version{' '}
                                                                                        {
                                                                                                c
                                                                                                        .policy
                                                                                                        .version_no
                                                                                        }
                                                                                </div>
                                                                        </Td>
                                                                        <Td align="right">
                                                                                {c.eligible}
                                                                                {c.eligible !==
                                                                                        c.population && (
                                                                                        <div className="text-xs text-slate-600">
                                                                                                of{' '}
                                                                                                {
                                                                                                        c.population
                                                                                                }
                                                                                        </div>
                                                                                )}
                                                                        </Td>
                                                                        <Td>
                                                                                <ul className="space-y-0.5">
                                                                                        {c.distribution.map(
                                                                                                (
                                                                                                        d,
                                                                                                ) => (
                                                                                                        <li
                                                                                                                key={
                                                                                                                        d.key
                                                                                                                }
                                                                                                        >
                                                                                                                <span className="font-medium">
                                                                                                                        {
                                                                                                                                d.label
                                                                                                                        }

                                                                                                                        :
                                                                                                                </span>{' '}
                                                                                                                {distributionText(
                                                                                                                        d,
                                                                                                                )}
                                                                                                        </li>
                                                                                                ),
                                                                                        )}
                                                                                </ul>
                                                                        </Td>
                                                                        <Td>
                                                                                <div className="flex flex-wrap gap-1">
                                                                                        <CohortStatusBadge
                                                                                                status={
                                                                                                        c.status
                                                                                                }
                                                                                        />
                                                                                        {c.small_cohort && (
                                                                                                <Badge>
                                                                                                        Small
                                                                                                        cohort
                                                                                                </Badge>
                                                                                        )}
                                                                                        {!c.matches_targets && (
                                                                                                <Badge tone="warning">
                                                                                                        Differs
                                                                                                        from
                                                                                                        targets
                                                                                                </Badge>
                                                                                        )}
                                                                                        {c.unresolved >
                                                                                                0 && (
                                                                                                <Badge tone="warning">
                                                                                                        {
                                                                                                                c.unresolved
                                                                                                        }{' '}
                                                                                                        to
                                                                                                        place
                                                                                                </Badge>
                                                                                        )}
                                                                                </div>
                                                                        </Td>
                                                                </tr>
                                                        ))}
                                                </TBody>
                                        </Table>
                                )}
                        </div>
                </>
        )
}
