import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { cardClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listMySheets } from '../../services/quarterlyApi'
import type { OwnSheet } from '../../types/api'
import { formatDate } from '../../utils/format'
import { unitLabel } from '../../utils/labels'
import { SheetStatusBadge } from '../kpi/StatusBadges'
import { scoreText } from '../scores/scoreLabels'

/** /my/kpi-sheets: the signed-in employee's own sheets and published outcomes. */
export function MyKpiSheetsPage() {
        const sheets = useApiQuery('my-kpi-sheets', (signal) => listMySheets(signal))
        return (
                <>
                        <PageHeader
                                title="My KPI sheets"
                                description="Your KPIs, weightages and targets for each quarter and assignment. Scores, groups and ratings appear here once the quarter is published."
                        />
                        {sheets.isLoading ? (
                                <LoadingState label="Loading your KPI sheets…" />
                        ) : sheets.error !== undefined || !sheets.data ? (
                                <ErrorState error={sheets.error} onRetry={sheets.reload} />
                        ) : sheets.data.length === 0 ? (
                                <EmptyState title="No KPI sheets yet">
                                        Your KPI sheets appear here once they are published.
                                </EmptyState>
                        ) : (
                                <div className="space-y-4">
                                        {sheets.data.map((sheet) => (
                                                <OwnSheetCard key={sheet.id} sheet={sheet} />
                                        ))}
                                </div>
                        )}
                </>
        )
}

function OwnSheetCard({ sheet }: { sheet: OwnSheet }) {
        const unit = unitLabel(sheet.assignment.department, sheet.assignment.plant)
        const headingId = `own-sheet-${sheet.id}`
        return (
                <section aria-labelledby={headingId} className={`${cardClasses} space-y-3 p-4`}>
                        <div className="flex flex-wrap items-center gap-2">
                                <h2
                                        id={headingId}
                                        className="text-base font-semibold text-slate-900"
                                >
                                        {sheet.quarter.name} · {unit}
                                </h2>
                                <SheetStatusBadge status={sheet.status} />
                        </div>
                        <Table caption={`KPIs for ${sheet.quarter.name}, ${unit}`}>
                                <thead>
                                        <tr>
                                                <Th>KPI</Th>
                                                <Th align="right">Weightage</Th>
                                                <Th align="right">Quarterly target</Th>
                                        </tr>
                                </thead>
                                <TBody>
                                        {sheet.items.map((item) => (
                                                <tr key={item.id}>
                                                        <Td>{item.kpi.name}</Td>
                                                        <Td align="right">
                                                                {item.weightage.toFixed(2)}%
                                                        </Td>
                                                        <Td align="right">
                                                                {item.target_value ?? '—'}{' '}
                                                                {item.unit}
                                                        </Td>
                                                </tr>
                                        ))}
                                </TBody>
                        </Table>
                        {sheet.published_score !== null || sheet.outcome ? (
                                <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                                        <div>
                                                <dt className="font-medium text-slate-700">
                                                        Score for this assignment
                                                </dt>
                                                <dd className="text-lg font-semibold tabular-nums">
                                                        {scoreText(sheet.published_score)}
                                                </dd>
                                        </div>
                                        {sheet.outcome && (
                                                <>
                                                        <div>
                                                                <dt className="font-medium text-slate-700">
                                                                        Quarterly score
                                                                </dt>
                                                                <dd className="text-lg font-semibold tabular-nums">
                                                                        {scoreText(
                                                                                sheet.outcome
                                                                                        .final_score,
                                                                        )}
                                                                </dd>
                                                        </div>
                                                        <div>
                                                                <dt className="font-medium text-slate-700">
                                                                        Group
                                                                </dt>
                                                                <dd>
                                                                        {sheet.outcome
                                                                                .group_label ??
                                                                                'Not normalized'}
                                                                </dd>
                                                        </div>
                                                        <div>
                                                                <dt className="font-medium text-slate-700">
                                                                        Normalized rating
                                                                </dt>
                                                                <dd>
                                                                        {sheet.outcome
                                                                                .normalized_rating ??
                                                                                '—'}
                                                                </dd>
                                                        </div>
                                                </>
                                        )}
                                </dl>
                        ) : (
                                <p className="text-sm text-slate-600">Not published yet.</p>
                        )}
                        {sheet.feedback.length > 0 && (
                                <div className="space-y-1">
                                        <h3 className="text-sm font-semibold text-slate-900">
                                                Feedback
                                        </h3>
                                        <ul className="space-y-2">
                                                {sheet.feedback.map((f) => (
                                                        <li
                                                                key={f.id}
                                                                className="rounded-md bg-slate-50 p-2 text-sm"
                                                        >
                                                                <p className="whitespace-pre-line text-slate-800">
                                                                        {f.body}
                                                                </p>
                                                                <p className="text-xs text-slate-600">
                                                                        {f.author?.username ?? '—'}{' '}
                                                                        · {formatDate(f.created_at)}
                                                                </p>
                                                        </li>
                                                ))}
                                        </ul>
                                </div>
                        )}
                </section>
        )
}
