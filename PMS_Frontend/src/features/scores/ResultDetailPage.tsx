import { Calculator } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { TextAreaField, TextField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { ReasonForm } from '../../components/common/ReasonForm'
import { cardClasses, linkClasses } from '../../components/common/styles'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import {
        approveOverride,
        calculateResults,
        getResult,
        rejectOverride,
        requestOverride,
        reviewResult,
} from '../../services/scoresApi'
import type { ApproverSide, ResultDetail, ResultItem, ScoreOverride } from '../../types/api'
import { formatDate } from '../../utils/format'
import { unitLabel } from '../../utils/labels'
import { parseId } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { canApproveDeviationAsHR, canApproveDeviationAsPlant } from '../auth/permissions'
import { InvalidLink } from '../common/InvalidLink'
import { AGGREGATION_LABELS } from '../kpi/kpiLabels'
import { Approval, SheetStatusBadge } from '../kpi/StatusBadges'
import { ResultVersions } from '../corrections/ResultVersions'
import { CommentsPanel } from '../quarterly/CommentsPanel'
import { ItemStatusBadge, OverrideStatusBadge, ResultStatusBadge } from './ScoreBadges'
import { monthLabel, scoreText } from './scoreLabels'

/** /scores/results/:sheetId */
export function ResultDetailPage() {
        const sheetId = parseId(useParams().sheetId)
        const query = useApiQuery(sheetId === undefined ? null : `result|${sheetId}`, (signal) =>
                getResult(sheetId!, signal),
        )
        if (sheetId === undefined)
                return <InvalidLink backTo="/scores/results" backLabel="Back to KPI results" />
        if (query.isLoading) return <LoadingState label="Loading the result…" />
        if (query.error !== undefined || !query.data) {
                return (
                        <>
                                <PageHeader
                                        title="KPI result"
                                        breadcrumbs={[
                                                { label: 'KPI results', to: '/scores/results' },
                                                { label: 'Result' },
                                        ]}
                                />
                                <ErrorState error={query.error} onRetry={query.reload} />
                        </>
                )
        }
        return <ResultView key={query.data.sheet.id} initial={query.data} reload={query.reload} />
}

function ResultView({ initial, reload }: { initial: ResultDetail; reload: () => void }) {
        const [detail, setDetail] = useState(initial)
        const [requesting, setRequesting] = useState(false)
        const [message, setMessage] = useState<string | null>(null)
        const action = useAction()
        const { result, actions, assignment } = detail
        const sheetId = detail.sheet.id

        async function recalculate() {
                setMessage(null)
                const counts = await action.run(() =>
                        calculateResults(detail.quarter.id, [sheetId]),
                )
                if (!counts) return
                setMessage(
                        counts.calculated
                                ? 'Recalculated with the latest data.'
                                : 'Nothing changed since the last calculation.',
                )
                const fresh = await action.run(() => getResult(sheetId))
                if (fresh) setDetail(fresh)
        }

        async function run(change: () => Promise<ResultDetail>, done: string) {
                setMessage(null)
                const updated = await action.run(change)
                if (updated) {
                        setDetail(updated)
                        setMessage(done)
                }
        }

        return (
                <>
                        <PageHeader
                                title={`${assignment.employee.full_name} · ${detail.quarter.name}`}
                                description={`${assignment.employee.employee_code} · ${unitLabel(assignment.department, assignment.plant)} · ${assignment.designation.name}`}
                                breadcrumbs={[
                                        {
                                                label: 'KPI results',
                                                to: `/scores/results?quarter=${detail.quarter.id}`,
                                        },
                                        { label: assignment.employee.full_name },
                                ]}
                                meta={
                                        <>
                                                <ResultStatusBadge
                                                        status={result?.status ?? null}
                                                />
                                                <SheetStatusBadge status={detail.sheet.status} />
                                                {result && result.version_no > 1 && (
                                                        <Badge tone="info">
                                                                Version {result.version_no}
                                                        </Badge>
                                                )}
                                        </>
                                }
                                actions={
                                        <Link to={`/kpi/sheets/${sheetId}`} className={linkClasses}>
                                                Open the KPI sheet
                                        </Link>
                                }
                        />
                        <div className="space-y-4">
                                {message && <Alert title={message} />}
                                <ActionError
                                        error={action.error}
                                        title="The step was not completed"
                                />
                                {result?.stale && (
                                        <Alert
                                                tone="warning"
                                                title="The data changed after this calculation"
                                        >
                                                Monthly values or the KPI sheet changed. Recalculate
                                                before reviewing; a pending override was voided if
                                                the score changed.
                                        </Alert>
                                )}
                                {result && !result.is_complete && (
                                        <Alert title="Provisional">
                                                Some KPIs do not have every month’s data yet, so the
                                                score cannot be reviewed or published.
                                        </Alert>
                                )}

                                <section
                                        aria-labelledby="score-heading"
                                        className={`${cardClasses} space-y-3 p-4`}
                                >
                                        <h2
                                                id="score-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Score
                                        </h2>
                                        {result === null ? (
                                                <p className="text-sm text-slate-700">
                                                        Not calculated yet.
                                                </p>
                                        ) : (
                                                <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                                                        <div>
                                                                <dt className="font-medium text-slate-700">
                                                                        Calculated (unrounded)
                                                                </dt>
                                                                <dd className="text-lg font-semibold tabular-nums">
                                                                        {result.calculated_score ??
                                                                                '—'}
                                                                </dd>
                                                        </div>
                                                        <div>
                                                                <dt className="font-medium text-slate-700">
                                                                        Final score (2 decimals)
                                                                </dt>
                                                                <dd className="text-lg font-semibold tabular-nums">
                                                                        {scoreText(
                                                                                result.final_score,
                                                                        )}
                                                                </dd>
                                                        </div>
                                                        <div>
                                                                <dt className="font-medium text-slate-700">
                                                                        Approved override
                                                                </dt>
                                                                <dd className="text-lg font-semibold tabular-nums">
                                                                        {scoreText(
                                                                                result.override_score,
                                                                        )}
                                                                </dd>
                                                        </div>
                                                        <div>
                                                                <dt className="font-medium text-slate-700">
                                                                        Published
                                                                </dt>
                                                                <dd className="text-lg font-semibold tabular-nums">
                                                                        {scoreText(
                                                                                result.published_score,
                                                                        )}
                                                                </dd>
                                                        </div>
                                                </dl>
                                        )}
                                        <p className="text-xs text-slate-600">
                                                Calculated score = Σ (KPI score × weightage ÷ 100),
                                                exact decimals; the final score is rounded half-up
                                                to two decimals.
                                                {detail.calculated_by &&
                                                        ` Calculated by ${detail.calculated_by.username} on ${formatDate(result?.calculated_at)}.`}
                                                {detail.reviewed_by &&
                                                        ` Reviewed by ${detail.reviewed_by.username} on ${formatDate(result?.reviewed_at)}.`}
                                                {detail.published_by &&
                                                        ` Published by ${detail.published_by.username} on ${formatDate(result?.published_at)}.`}
                                        </p>
                                        <div className="flex flex-wrap gap-2">
                                                {actions.can_calculate && (
                                                        <Button
                                                                isLoading={action.busy}
                                                                onClick={recalculate}
                                                        >
                                                                <Calculator
                                                                        aria-hidden="true"
                                                                        className="size-4"
                                                                />
                                                                {result
                                                                        ? 'Recalculate'
                                                                        : 'Calculate'}
                                                        </Button>
                                                )}
                                                {actions.can_review && (
                                                        <Button
                                                                variant="primary"
                                                                isLoading={action.busy}
                                                                onClick={() =>
                                                                        run(
                                                                                () =>
                                                                                        reviewResult(
                                                                                                sheetId,
                                                                                        ),
                                                                                'Marked as reviewed.',
                                                                        )
                                                                }
                                                        >
                                                                Mark as reviewed
                                                        </Button>
                                                )}
                                                {actions.can_request_override && !requesting && (
                                                        <Button
                                                                disabled={action.busy}
                                                                onClick={() => setRequesting(true)}
                                                        >
                                                                Request an override…
                                                        </Button>
                                                )}
                                        </div>
                                        {requesting && (
                                                <OverrideForm
                                                        sheetId={sheetId}
                                                        onCancel={() => setRequesting(false)}
                                                        onDone={() => {
                                                                setRequesting(false)
                                                                setMessage(
                                                                        'Override requested. It needs HR Head and Plant Head approval.',
                                                                )
                                                                reload()
                                                        }}
                                                />
                                        )}
                                </section>

                                {detail.pending_override && (
                                        <OverridePanel
                                                override={detail.pending_override}
                                                onChanged={(text) => {
                                                        setMessage(text)
                                                        reload()
                                                }}
                                        />
                                )}
                                {detail.applied_override && (
                                        <Alert
                                                title={`Override applied: ${scoreText(detail.applied_override.proposed_score)}`}
                                        >
                                                Requested by{' '}
                                                {detail.applied_override.requested_by?.username ??
                                                        '—'}
                                                : {detail.applied_override.reason}
                                        </Alert>
                                )}

                                {result &&
                                        result.version_no > 1 &&
                                        result.status !== 'PUBLISHED' &&
                                        result.status !== 'SUPERSEDED' && (
                                                <Alert
                                                        tone="info"
                                                        title={`Corrected version ${result.version_no} under review`}
                                                >
                                                        This result was recalculated by an approved
                                                        correction of the published quarter. The
                                                        published version stays current until the
                                                        corrected version is reviewed, normalized
                                                        and published.
                                                </Alert>
                                        )}
                                <ResultVersions versions={detail.versions} />

                                {detail.sheet.status === 'LOCKED' && (
                                        <CommentsPanel sheetId={sheetId} />
                                )}

                                <section aria-labelledby="kpis-heading" className="space-y-3">
                                        <h2
                                                id="kpis-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                How each KPI was scored
                                        </h2>
                                        {detail.items.length === 0 ? (
                                                <EmptyState title="No calculation yet">
                                                        Calculate the score to see how each KPI was
                                                        scored.
                                                </EmptyState>
                                        ) : (
                                                detail.items.map((item) => (
                                                        <ItemExplanation
                                                                key={item.item_id}
                                                                item={item}
                                                        />
                                                ))
                                        )}
                                </section>
                        </div>
                </>
        )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
        return (
                <div>
                        <dt className="font-medium text-slate-700">{label}</dt>
                        <dd className="text-slate-900">{children}</dd>
                </div>
        )
}

function ItemExplanation({ item }: { item: ResultItem }) {
        const missing = new Set(item.months_missing)
        return (
                <article
                        aria-labelledby={`kpi-${item.item_id}`}
                        className={`${cardClasses} space-y-3 p-4`}
                >
                        <div className="flex flex-wrap items-center gap-2">
                                <h3
                                        id={`kpi-${item.item_id}`}
                                        className="font-semibold text-slate-900"
                                >
                                        {item.kpi_name}
                                </h3>
                                <Badge>{item.kpi_code}</Badge>
                                <ItemStatusBadge status={item.status} />
                                <span className="text-sm text-slate-700">
                                        Weightage {item.weightage}%
                                </span>
                        </div>
                        {item.message && (
                                <p
                                        className={`text-sm ${item.status === 'error' ? 'text-red-700' : 'text-amber-900'}`}
                                >
                                        {item.message}
                                </p>
                        )}
                        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                                <Fact label="Monthly values">
                                        <ul>
                                                {item.months_expected.map((month) => {
                                                        const value = item.monthly.find(
                                                                (m) => m.month === month,
                                                        )
                                                        return (
                                                                <li key={month}>
                                                                        {monthLabel(month)}:{' '}
                                                                        {value ? (
                                                                                `${value.actual ?? '—'} ${item.unit}`
                                                                        ) : (
                                                                                <span className="text-amber-900">
                                                                                        {missing.has(
                                                                                                month,
                                                                                        )
                                                                                                ? 'missing'
                                                                                                : '—'}
                                                                                </span>
                                                                        )}
                                                                </li>
                                                        )
                                                })}
                                        </ul>
                                </Fact>
                                <Fact label="Quarterly actual">
                                        {item.quarterly_actual ?? '—'}{' '}
                                        {item.quarterly_actual && item.unit}
                                        <div className="text-xs text-slate-600">
                                                {item.reporting_frequency === 'QUARTERLY'
                                                        ? 'One quarterly value'
                                                        : item.aggregation
                                                          ? AGGREGATION_LABELS[item.aggregation]
                                                          : 'Aggregation not defined'}
                                        </div>
                                </Fact>
                                <Fact label="Target">
                                        {item.target ?? '—'} {item.target && item.unit}
                                </Fact>
                                <Fact label="Inputs to the matrix">
                                        {Object.keys(item.inputs).length
                                                ? Object.entries(item.inputs)
                                                          .map(
                                                                  ([key, value]) =>
                                                                          `${key.replace(/_/g, ' ')}: ${value}`,
                                                          )
                                                          .join(', ')
                                                : '—'}
                                </Fact>
                                <Fact label="Scoring matrix">
                                        {item.matrix ? (
                                                <Link
                                                        to={`/matrices/${item.matrix.matrix_id}/versions/${item.matrix.version_id}`}
                                                        className={linkClasses}
                                                >
                                                        {item.matrix.code} version{' '}
                                                        {item.matrix.version_no}
                                                </Link>
                                        ) : item.legacy_rule ? (
                                                'Stage J bands frozen at publication'
                                        ) : (
                                                '—'
                                        )}
                                </Fact>
                                <Fact label="Rule applied">
                                        {item.rule
                                                ? `${item.rule.priority !== undefined ? `Rule ${item.rule.priority}: ` : ''}${item.rule.description || 'Any value'}`
                                                : '—'}
                                        {item.used_default && (
                                                <div className="text-xs text-slate-600">
                                                        Default result
                                                </div>
                                        )}
                                </Fact>
                                <Fact label="KPI score">{item.score ?? '—'}</Fact>
                                <Fact label="Contribution">
                                        {item.contribution ?? '—'}
                                        <div className="text-xs text-slate-600">
                                                score × weightage ÷ 100
                                        </div>
                                </Fact>
                        </dl>
                </article>
        )
}

function OverrideForm({
        sheetId,
        onCancel,
        onDone,
}: {
        sheetId: number
        onCancel: () => void
        onDone: () => void
}) {
        const [score, setScore] = useState('')
        const [reason, setReason] = useState('')
        const [touched, setTouched] = useState(false)
        const action = useAction()
        const scoreError = /^(?:[0-4](?:\.\d{1,2})?|5(?:\.0{1,2})?)$/.test(score.trim())
                ? undefined
                : 'Enter a score from 0 to 5 with at most two decimals.'
        const reasonError =
                reason.trim().length < 10
                        ? 'Explain the override (at least 10 characters).'
                        : undefined

        async function handleSubmit(event: FormEvent) {
                event.preventDefault()
                setTouched(true)
                if (scoreError || reasonError) return
                const created = await action.run(() =>
                        requestOverride(sheetId, {
                                proposed_score: score.trim(),
                                reason: reason.trim(),
                        }),
                )
                if (created) onDone()
        }

        return (
                <form onSubmit={handleSubmit} noValidate className={`${cardClasses} space-y-3 p-4`}>
                        <p className="text-sm text-slate-700">
                                A manual override is a separate deviation: it needs a reason and the
                                approval of an HR Head and a Plant Head (two different people,
                                neither of them you). The calculated score stays on record.
                        </p>
                        <div className="max-w-xs">
                                <TextField
                                        label="Proposed score"
                                        inputMode="decimal"
                                        value={score}
                                        error={touched ? scoreError : undefined}
                                        onChange={(e) => setScore(e.target.value)}
                                />
                        </div>
                        <TextAreaField
                                label="Reason"
                                maxLength={1000}
                                value={reason}
                                error={touched ? reasonError : undefined}
                                onChange={(e) => setReason(e.target.value)}
                        />
                        <ActionError error={action.error} title="The override was not requested" />
                        <div className="flex flex-wrap gap-2">
                                <Button type="submit" variant="primary" isLoading={action.busy}>
                                        Request override
                                </Button>
                                <Button variant="ghost" disabled={action.busy} onClick={onCancel}>
                                        Cancel
                                </Button>
                        </div>
                </form>
        )
}

function OverridePanel({
        override,
        onChanged,
}: {
        override: ScoreOverride
        onChanged: (message: string) => void
}) {
        const user = useCurrentUser()
        const [rejecting, setRejecting] = useState(false)
        const action = useAction()
        const isRequester = override.requested_by?.id === user.id
        const approvedOneSide = [
                override.hr_approved_by?.id,
                override.plant_approved_by?.id,
        ].includes(user.id)
        const canAct = override.status === 'PENDING' && !isRequester
        const canHR =
                canAct &&
                !approvedOneSide &&
                override.hr_approved_by === null &&
                canApproveDeviationAsHR(user)
        const canPlant =
                canAct &&
                !approvedOneSide &&
                override.plant_approved_by === null &&
                canApproveDeviationAsPlant(user)
        const canReject =
                canAct && (canApproveDeviationAsHR(user) || canApproveDeviationAsPlant(user))

        async function approve(side: ApproverSide) {
                const updated = await action.run(() => approveOverride(override.id, side))
                if (updated)
                        onChanged(
                                updated.status === 'APPLIED'
                                        ? 'Both approvals given; the override is applied.'
                                        : 'Approval recorded.',
                        )
        }

        async function reject(reason: string) {
                const updated = await action.run(() => rejectOverride(override.id, reason))
                if (updated) onChanged('Override rejected.')
        }

        return (
                <section
                        aria-labelledby="override-heading"
                        className={`${cardClasses} space-y-3 p-4`}
                >
                        <div className="flex flex-wrap items-center gap-2">
                                <h2
                                        id="override-heading"
                                        className="text-base font-semibold text-slate-900"
                                >
                                        Override request
                                </h2>
                                <OverrideStatusBadge status={override.status} />
                        </div>
                        <p className="text-sm text-slate-800">
                                {scoreText(override.original_score)} →{' '}
                                {scoreText(override.proposed_score)} requested by{' '}
                                {override.requested_by?.username ?? '—'} on{' '}
                                {formatDate(override.requested_at)}.
                        </p>
                        <p className="text-sm whitespace-pre-line text-slate-800">
                                {override.reason}
                        </p>
                        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                                <div>
                                        <dt className="font-medium text-slate-700">HR Head</dt>
                                        <dd>
                                                <Approval by={override.hr_approved_by} />
                                        </dd>
                                </div>
                                <div>
                                        <dt className="font-medium text-slate-700">Plant Head</dt>
                                        <dd>
                                                <Approval by={override.plant_approved_by} />
                                        </dd>
                                </div>
                        </dl>
                        <ActionError error={action.error} title="The decision was not recorded" />
                        {override.status === 'PENDING' && isRequester && (
                                <p className="text-sm text-slate-600">
                                        You requested this override, so you cannot approve or reject
                                        it.
                                </p>
                        )}
                        {(canHR || canPlant || canReject) && !rejecting && (
                                <div className="flex flex-wrap gap-2">
                                        {canHR && (
                                                <Button
                                                        variant="primary"
                                                        isLoading={action.busy}
                                                        onClick={() => approve('HR_HEAD')}
                                                >
                                                        Approve as HR Head
                                                </Button>
                                        )}
                                        {canPlant && (
                                                <Button
                                                        variant="primary"
                                                        isLoading={action.busy}
                                                        onClick={() => approve('PLANT_HEAD')}
                                                >
                                                        Approve as Plant Head
                                                </Button>
                                        )}
                                        {canReject && (
                                                <Button
                                                        variant="danger"
                                                        disabled={action.busy}
                                                        onClick={() => setRejecting(true)}
                                                >
                                                        Reject…
                                                </Button>
                                        )}
                                </div>
                        )}
                        {rejecting && (
                                <ReasonForm
                                        label="Reason for rejecting the override"
                                        submitLabel="Reject override"
                                        tone="danger"
                                        busy={action.busy}
                                        onSubmit={reject}
                                        onCancel={() => setRejecting(false)}
                                />
                        )}
                </section>
        )
}
