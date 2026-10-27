import { Calculator, CheckCircle2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { TextAreaField, TextField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { ReasonForm } from '../../components/common/ReasonForm'
import { cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import {
        calculateAnnual,
        decideAnnualDeviation,
        finalizeAnnual,
        getAnnualDetail,
        requestAnnualDeviation,
} from '../../services/annualApi'
import type { AnnualDetail, AnnualVersion, AuditEntry } from '../../types/api'
import { formatDate } from '../../utils/format'
import { unitLabel } from '../../utils/labels'
import { parseId } from '../../utils/params'
import { InvalidLink } from '../common/InvalidLink'
import { QuarterStatusBadge } from '../kpi/StatusBadges'
import { scoreText } from '../scores/scoreLabels'
import { ANNUAL_STATUS, DEVIATION_STATUS, standing } from './annualLabels'

/** /annual/cycles/:cycleId/employees/:employeeId */
export function AnnualEmployeePage() {
        const params = useParams()
        const cycleId = parseId(params.cycleId)
        const employeeId = parseId(params.employeeId)
        const valid = cycleId !== undefined && employeeId !== undefined
        const query = useApiQuery(
                valid ? `annual-detail|${cycleId}|${employeeId}` : null,
                (signal) => getAnnualDetail(cycleId!, employeeId!, signal),
        )
        if (!valid) return <InvalidLink backTo="/annual" backLabel="Back to annual results" />
        if (query.isLoading) return <LoadingState label="Loading the annual result…" />
        if (query.error !== undefined || !query.data) {
                return (
                        <>
                                <PageHeader
                                        title="Annual result"
                                        breadcrumbs={[
                                                { label: 'Annual results', to: '/annual' },
                                                { label: 'Result' },
                                        ]}
                                />
                                <ErrorState error={query.error} onRetry={query.reload} />
                        </>
                )
        }
        return (
                <DetailView
                        key={`${cycleId}-${employeeId}`}
                        initial={query.data}
                        onReload={query.reload}
                />
        )
}

function DetailView({ initial, onReload }: { initial: AnnualDetail; onReload: () => void }) {
        const [detail, setDetail] = useState(initial)
        const [mode, setMode] = useState<'idle' | 'deviation' | 'approve' | 'reject' | 'finalize'>(
                'idle',
        )
        const [message, setMessage] = useState<string | null>(null)
        const action = useAction()
        const a = detail.actions
        const s = standing(detail)
        const draft = detail.draft
        const pending = detail.pending_deviation

        async function refresh(done: string) {
                setMode('idle')
                setMessage(done)
                const fresh = await action.run(() =>
                        getAnnualDetail(detail.cycle_id, detail.employee.id),
                )
                if (fresh) setDetail(fresh)
                onReload()
        }

        async function handleCalculate() {
                setMessage(null)
                const counts = await action.run(() =>
                        calculateAnnual(detail.cycle_id, [detail.employee.id]),
                )
                if (counts)
                        await refresh(
                                counts.calculated
                                        ? 'Annual result calculated.'
                                        : counts.unchanged
                                          ? 'Nothing changed: the result is already current.'
                                          : 'The annual result can’t be calculated yet.',
                        )
        }

        return (
                <>
                        <PageHeader
                                title={detail.employee.full_name}
                                description={`${detail.employee.employee_code}${
                                        detail.home_plant && detail.home_department
                                                ? ` · ${unitLabel(detail.home_department, detail.home_plant)}`
                                                : ''
                                }`}
                                breadcrumbs={[
                                        {
                                                label: 'Annual results',
                                                to: `/annual?cycle=${detail.cycle_id}`,
                                        },
                                        { label: detail.employee.full_name },
                                ]}
                                meta={<Badge tone={s.tone}>{s.label}</Badge>}
                        />
                        <div className="space-y-4">
                                {message && <Alert title={message} />}
                                <ActionError
                                        error={action.error}
                                        title="The action was not completed"
                                />
                                {detail.issues.length > 0 && (
                                        <Alert
                                                tone="warning"
                                                title="The annual result can’t be final yet"
                                        >
                                                <ul className="list-disc space-y-0.5 pl-5">
                                                        {detail.issues.map((i) => (
                                                                <li key={i}>{i}</li>
                                                        ))}
                                                </ul>
                                        </Alert>
                                )}
                                {[draft, detail.published].some(
                                        (v) => v?.recalculation_required,
                                ) && (
                                        <Alert tone="warning" title="Recalculation required">
                                                {(draft ?? detail.published)
                                                        ?.recalculation_reason ??
                                                        'A quarter this result was calculated from changed.'}{' '}
                                                The result shown is not current until it is
                                                recalculated and approved again.
                                        </Alert>
                                )}

                                <section
                                        aria-labelledby="quarters-heading"
                                        className={`${cardClasses} space-y-3 p-4`}
                                >
                                        <h2
                                                id="quarters-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Published quarterly results
                                        </h2>
                                        <Table caption="Quarterly results used">
                                                <thead>
                                                        <tr>
                                                                <Th>Quarter</Th>
                                                                <Th>Status</Th>
                                                                <Th align="right">Weight</Th>
                                                                <Th align="right">Score</Th>
                                                                <Th>Version</Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {detail.quarters.map((q) => (
                                                                <tr key={q.quarter_id}>
                                                                        <Td>
                                                                                {q.published ? (
                                                                                        <Link
                                                                                                to={`/scores/quarters/${q.quarter_id}/employees/${detail.employee.id}`}
                                                                                                className={
                                                                                                        linkClasses
                                                                                                }
                                                                                        >
                                                                                                {
                                                                                                        q.name
                                                                                                }
                                                                                        </Link>
                                                                                ) : (
                                                                                        q.name
                                                                                )}
                                                                                {q.correction_ids.map(
                                                                                        (id) => (
                                                                                                <div
                                                                                                        key={
                                                                                                                id
                                                                                                        }
                                                                                                        className="text-xs"
                                                                                                >
                                                                                                        <Link
                                                                                                                to={`/scores/corrections/${id}`}
                                                                                                                className={
                                                                                                                        linkClasses
                                                                                                                }
                                                                                                        >
                                                                                                                Being
                                                                                                                corrected
                                                                                                                (correction{' '}
                                                                                                                {
                                                                                                                        id
                                                                                                                }

                                                                                                                )
                                                                                                        </Link>
                                                                                                </div>
                                                                                        ),
                                                                                )}
                                                                        </Td>
                                                                        <Td>
                                                                                <QuarterStatusBadge
                                                                                        status={
                                                                                                q.status
                                                                                        }
                                                                                />
                                                                        </Td>
                                                                        <Td align="right">
                                                                                {q.weight} %
                                                                        </Td>
                                                                        <Td align="right">
                                                                                {q.score !== null
                                                                                        ? scoreText(
                                                                                                  q.score,
                                                                                          )
                                                                                        : 'Not published'}
                                                                        </Td>
                                                                        <Td>
                                                                                {q.version_no !==
                                                                                null
                                                                                        ? `Version ${q.version_no}`
                                                                                        : '—'}
                                                                        </Td>
                                                                </tr>
                                                        ))}
                                                </TBody>
                                        </Table>
                                        {a.can_calculate && (
                                                <Button
                                                        isLoading={action.busy && mode === 'idle'}
                                                        onClick={handleCalculate}
                                                >
                                                        <Calculator
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        Calculate the annual result
                                                </Button>
                                        )}
                                </section>

                                <div className="grid gap-4 lg:grid-cols-2">
                                        <VersionCard
                                                title="Calculated version awaiting approval"
                                                version={draft}
                                                empty="No calculated version is awaiting approval."
                                        />
                                        <VersionCard
                                                title="Approved annual result"
                                                version={detail.published}
                                                empty="No annual result has been approved yet."
                                        />
                                </div>

                                {pending && (
                                        <Alert tone="warning" title="Deviation awaiting the CHRO">
                                                Requested by {pending.requested_by?.username ?? '—'}{' '}
                                                on {formatDate(pending.requested_at)}:{' '}
                                                {scoreText(pending.original_score)} →{' '}
                                                {scoreText(pending.proposed_score)}. Until the CHRO
                                                approves it, the calculated score applies.
                                        </Alert>
                                )}

                                {(a.can_request_deviation ||
                                        a.can_decide_deviation ||
                                        a.can_finalize) && (
                                        <section
                                                aria-labelledby="actions-heading"
                                                className={`${cardClasses} space-y-3 p-4`}
                                        >
                                                <h2
                                                        id="actions-heading"
                                                        className="text-base font-semibold text-slate-900"
                                                >
                                                        Decisions
                                                </h2>
                                                {mode === 'idle' && (
                                                        <div className="flex flex-wrap gap-2">
                                                                {a.can_request_deviation && (
                                                                        <Button
                                                                                onClick={() =>
                                                                                        setMode(
                                                                                                'deviation',
                                                                                        )
                                                                                }
                                                                        >
                                                                                Request a deviation…
                                                                        </Button>
                                                                )}
                                                                {a.can_decide_deviation && (
                                                                        <>
                                                                                <Button
                                                                                        variant="primary"
                                                                                        onClick={() =>
                                                                                                setMode(
                                                                                                        'approve',
                                                                                                )
                                                                                        }
                                                                                >
                                                                                        Approve the
                                                                                        deviation…
                                                                                </Button>
                                                                                <Button
                                                                                        onClick={() =>
                                                                                                setMode(
                                                                                                        'reject',
                                                                                                )
                                                                                        }
                                                                                >
                                                                                        Reject the
                                                                                        deviation…
                                                                                </Button>
                                                                        </>
                                                                )}
                                                                {a.can_finalize && (
                                                                        <Button
                                                                                variant="primary"
                                                                                onClick={() =>
                                                                                        setMode(
                                                                                                'finalize',
                                                                                        )
                                                                                }
                                                                        >
                                                                                <CheckCircle2
                                                                                        aria-hidden="true"
                                                                                        className="size-4"
                                                                                />
                                                                                Approve the annual
                                                                                result…
                                                                        </Button>
                                                                )}
                                                        </div>
                                                )}
                                                {mode === 'deviation' && draft && (
                                                        <DeviationForm
                                                                original={draft.calculated_score}
                                                                busy={action.busy}
                                                                onCancel={() => setMode('idle')}
                                                                onSubmit={async (
                                                                        proposed,
                                                                        reason,
                                                                ) => {
                                                                        const made =
                                                                                await action.run(
                                                                                        () =>
                                                                                                requestAnnualDeviation(
                                                                                                        draft.id,
                                                                                                        {
                                                                                                                original_score:
                                                                                                                        draft.calculated_score,
                                                                                                                proposed_score:
                                                                                                                        proposed,
                                                                                                                reason,
                                                                                                        },
                                                                                                ),
                                                                                )
                                                                        if (made)
                                                                                await refresh(
                                                                                        'Deviation requested. The CHRO decides it.',
                                                                                )
                                                                }}
                                                        />
                                                )}
                                                {(mode === 'approve' || mode === 'reject') &&
                                                        pending && (
                                                                <ReasonForm
                                                                        label={
                                                                                mode === 'approve'
                                                                                        ? 'Why is the deviation approved?'
                                                                                        : 'Why is the deviation rejected?'
                                                                        }
                                                                        hint="At least 10 characters; recorded with the decision."
                                                                        minLength={10}
                                                                        tone={
                                                                                mode === 'reject'
                                                                                        ? 'danger'
                                                                                        : 'primary'
                                                                        }
                                                                        submitLabel={
                                                                                mode === 'approve'
                                                                                        ? 'Approve the deviation'
                                                                                        : 'Reject the deviation'
                                                                        }
                                                                        busy={action.busy}
                                                                        onCancel={() =>
                                                                                setMode('idle')
                                                                        }
                                                                        onSubmit={async (
                                                                                reason,
                                                                        ) => {
                                                                                const decided =
                                                                                        await action.run(
                                                                                                () =>
                                                                                                        decideAnnualDeviation(
                                                                                                                pending.id,
                                                                                                                mode,
                                                                                                                reason,
                                                                                                        ),
                                                                                        )
                                                                                if (decided)
                                                                                        await refresh(
                                                                                                mode ===
                                                                                                        'approve'
                                                                                                        ? 'Deviation approved: the adjusted score applies.'
                                                                                                        : 'Deviation rejected: the calculated score applies.',
                                                                                        )
                                                                        }}
                                                                />
                                                        )}
                                                {mode === 'finalize' && draft && (
                                                        <FinalizeForm
                                                                version={draft}
                                                                replaces={detail.published}
                                                                busy={action.busy}
                                                                onCancel={() => setMode('idle')}
                                                                onSubmit={async (note) => {
                                                                        const done =
                                                                                await action.run(
                                                                                        () =>
                                                                                                finalizeAnnual(
                                                                                                        draft.id,
                                                                                                        note,
                                                                                                ),
                                                                                )
                                                                        if (done) {
                                                                                setDetail(done)
                                                                                setMode('idle')
                                                                                setMessage(
                                                                                        `Version ${draft.version_no} approved: it is the annual result.`,
                                                                                )
                                                                                onReload()
                                                                        }
                                                                }}
                                                        />
                                                )}
                                        </section>
                                )}
                                {draft &&
                                        !a.can_finalize &&
                                        detail.finalize_blockers.length > 0 && (
                                                <Alert
                                                        tone="info"
                                                        title="Before the CHRO can approve"
                                                >
                                                        <ul className="list-disc space-y-0.5 pl-5">
                                                                {detail.finalize_blockers.map(
                                                                        (b) => (
                                                                                <li key={b}>{b}</li>
                                                                        ),
                                                                )}
                                                        </ul>
                                                </Alert>
                                        )}

                                <VersionsTable detail={detail} />
                                <DeviationsTable detail={detail} />
                                <History entries={detail.history} />
                        </div>
                </>
        )
}

function VersionCard({
        title,
        version,
        empty,
}: {
        title: string
        version: AnnualVersion | null
        empty: string
}) {
        return (
                <section className={`${cardClasses} space-y-2 p-4`} aria-label={title}>
                        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
                        {version ? (
                                <dl className="grid grid-cols-2 gap-3 text-sm">
                                        <div>
                                                <dt className="font-medium text-slate-700">
                                                        Version
                                                </dt>
                                                <dd>{version.version_no}</dd>
                                        </div>
                                        <div>
                                                <dt className="font-medium text-slate-700">
                                                        Calculated (exact)
                                                </dt>
                                                <dd className="tabular-nums">
                                                        {version.calculated_exact}
                                                </dd>
                                        </div>
                                        <div>
                                                <dt className="font-medium text-slate-700">
                                                        Original calculated score
                                                </dt>
                                                <dd className="text-lg font-semibold tabular-nums">
                                                        {scoreText(version.calculated_score)}
                                                </dd>
                                        </div>
                                        <div>
                                                <dt className="font-medium text-slate-700">
                                                        Approved adjustment
                                                </dt>
                                                <dd className="text-lg font-semibold tabular-nums">
                                                        {version.adjusted_score
                                                                ? scoreText(version.adjusted_score)
                                                                : 'None'}
                                                </dd>
                                        </div>
                                        <div>
                                                <dt className="font-medium text-slate-700">
                                                        Final annual score
                                                </dt>
                                                <dd className="text-lg font-semibold tabular-nums">
                                                        {scoreText(version.final_score)}
                                                </dd>
                                        </div>
                                        <div>
                                                <dt className="font-medium text-slate-700">
                                                        Status
                                                </dt>
                                                <dd>
                                                        <Badge
                                                                tone={
                                                                        ANNUAL_STATUS[
                                                                                version.status
                                                                        ].tone
                                                                }
                                                        >
                                                                {
                                                                        ANNUAL_STATUS[
                                                                                version.status
                                                                        ].label
                                                                }
                                                        </Badge>
                                                </dd>
                                        </div>
                                </dl>
                        ) : (
                                <p className="text-sm text-slate-600">{empty}</p>
                        )}
                </section>
        )
}

function DeviationForm({
        original,
        busy,
        onSubmit,
        onCancel,
}: {
        original: string
        busy: boolean
        onSubmit: (proposed: string, reason: string) => void
        onCancel: () => void
}) {
        const [proposed, setProposed] = useState('')
        const [reason, setReason] = useState('')
        const [touched, setTouched] = useState(false)
        const errors = {
                proposed:
                        /^[0-5](\.\d{1,2})?$/.test(proposed.trim()) && Number(proposed) <= 5
                                ? undefined
                                : 'Enter a score from 0 to 5 with at most two decimals.',
                reason:
                        reason.trim().length >= 10
                                ? undefined
                                : 'Explain the deviation (at least 10 characters).',
        }
        return (
                <form
                        noValidate
                        aria-label="Annual score deviation"
                        onSubmit={(e: FormEvent) => {
                                e.preventDefault()
                                setTouched(true)
                                if (!errors.proposed && !errors.reason)
                                        onSubmit(proposed.trim(), reason.trim())
                        }}
                        className="space-y-3"
                >
                        <p className="text-sm text-slate-700">
                                Original calculated annual score:{' '}
                                <strong>{scoreText(original)}</strong>. The CHRO decides the
                                request; the calculated score is always kept.
                        </p>
                        <div className="max-w-xs">
                                <TextField
                                        label="Revised annual score"
                                        inputMode="decimal"
                                        value={proposed}
                                        error={touched ? errors.proposed : undefined}
                                        onChange={(e) => setProposed(e.target.value)}
                                />
                        </div>
                        <TextAreaField
                                label="Reason for the deviation"
                                maxLength={1000}
                                value={reason}
                                error={touched ? errors.reason : undefined}
                                onChange={(e) => setReason(e.target.value)}
                        />
                        <div className="flex flex-wrap gap-2">
                                <Button type="submit" variant="primary" isLoading={busy}>
                                        Submit the deviation
                                </Button>
                                <Button variant="ghost" disabled={busy} onClick={onCancel}>
                                        Cancel
                                </Button>
                        </div>
                </form>
        )
}

function FinalizeForm({
        version,
        replaces,
        busy,
        onSubmit,
        onCancel,
}: {
        version: AnnualVersion
        replaces: AnnualVersion | null
        busy: boolean
        onSubmit: (note: string | null) => void
        onCancel: () => void
}) {
        const [note, setNote] = useState('')
        return (
                <form
                        aria-label="Approve the annual result"
                        onSubmit={(e: FormEvent) => {
                                e.preventDefault()
                                onSubmit(note.trim() || null)
                        }}
                        className="space-y-3"
                >
                        <p className="text-sm text-slate-700">
                                Version {version.version_no} becomes the employee’s annual result:
                                final score <strong>{scoreText(version.final_score)}</strong>
                                {replaces
                                        ? `, replacing version ${replaces.version_no} (${scoreText(replaces.final_score)}), which stays in the history.`
                                        : '.'}
                        </p>
                        <TextAreaField
                                label="Approval note (optional)"
                                maxLength={1000}
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                        />
                        <div className="flex flex-wrap gap-2">
                                <Button type="submit" variant="primary" isLoading={busy}>
                                        Approve version {version.version_no}
                                </Button>
                                <Button variant="ghost" disabled={busy} onClick={onCancel}>
                                        Cancel
                                </Button>
                        </div>
                </form>
        )
}

function VersionsTable({ detail }: { detail: AnnualDetail }) {
        if (detail.versions.length === 0) return null
        return (
                <section aria-labelledby="versions-heading" className="space-y-2">
                        <h2
                                id="versions-heading"
                                className="text-base font-semibold text-slate-900"
                        >
                                Versions
                        </h2>
                        <Table caption="Annual result versions">
                                <thead>
                                        <tr>
                                                <Th>Version</Th>
                                                <Th>Status</Th>
                                                <Th align="right">Calculated</Th>
                                                <Th align="right">Adjusted</Th>
                                                <Th align="right">Final</Th>
                                                <Th>Quarterly versions used</Th>
                                                <Th>Calculated</Th>
                                                <Th>Approved</Th>
                                        </tr>
                                </thead>
                                <TBody>
                                        {detail.versions.map((v) => (
                                                <tr key={v.id}>
                                                        <Td>{v.version_no}</Td>
                                                        <Td>
                                                                <Badge
                                                                        tone={
                                                                                ANNUAL_STATUS[
                                                                                        v.status
                                                                                ].tone
                                                                        }
                                                                >
                                                                        {
                                                                                ANNUAL_STATUS[
                                                                                        v.status
                                                                                ].label
                                                                        }
                                                                </Badge>
                                                                {v.recalculation_required && (
                                                                        <div className="text-xs text-amber-900">
                                                                                Recalculation
                                                                                required
                                                                        </div>
                                                                )}
                                                        </Td>
                                                        <Td align="right">
                                                                {scoreText(v.calculated_score)}
                                                        </Td>
                                                        <Td align="right">
                                                                {v.adjusted_score
                                                                        ? scoreText(
                                                                                  v.adjusted_score,
                                                                          )
                                                                        : '—'}
                                                        </Td>
                                                        <Td align="right">
                                                                {scoreText(v.final_score)}
                                                        </Td>
                                                        <Td>
                                                                {v.sources
                                                                        .map(
                                                                                (s) =>
                                                                                        `Q${s.quarter_number} v${s.version_no}: ${scoreText(s.final_score)}`,
                                                                        )
                                                                        .join(' · ')}
                                                                <div className="text-xs text-slate-600">
                                                                        Rule version{' '}
                                                                        {v.rule_version ?? '—'}
                                                                </div>
                                                        </Td>
                                                        <Td>
                                                                {formatDate(v.calculated_at)}
                                                                <div className="text-xs text-slate-600">
                                                                        {v.calculated_by
                                                                                ?.username ?? '—'}
                                                                </div>
                                                        </Td>
                                                        <Td>
                                                                {v.published_at
                                                                        ? formatDate(v.published_at)
                                                                        : '—'}
                                                                {v.published_by && (
                                                                        <div className="text-xs text-slate-600">
                                                                                {
                                                                                        v
                                                                                                .published_by
                                                                                                .username
                                                                                }
                                                                        </div>
                                                                )}
                                                        </Td>
                                                </tr>
                                        ))}
                                </TBody>
                        </Table>
                </section>
        )
}

function DeviationsTable({ detail }: { detail: AnnualDetail }) {
        if (detail.deviations.length === 0) return null
        return (
                <section aria-labelledby="deviations-heading" className="space-y-2">
                        <h2
                                id="deviations-heading"
                                className="text-base font-semibold text-slate-900"
                        >
                                Deviation requests
                        </h2>
                        <Table caption="Annual score deviations">
                                <thead>
                                        <tr>
                                                <Th>Version</Th>
                                                <Th>Status</Th>
                                                <Th align="right">Original → revised</Th>
                                                <Th>Reason</Th>
                                                <Th>Requested</Th>
                                                <Th>Decision</Th>
                                        </tr>
                                </thead>
                                <TBody>
                                        {detail.deviations.map((d) => (
                                                <tr key={d.id}>
                                                        <Td>{d.version_no}</Td>
                                                        <Td>
                                                                <Badge
                                                                        tone={
                                                                                DEVIATION_STATUS[
                                                                                        d.status
                                                                                ].tone
                                                                        }
                                                                >
                                                                        {
                                                                                DEVIATION_STATUS[
                                                                                        d.status
                                                                                ].label
                                                                        }
                                                                </Badge>
                                                        </Td>
                                                        <Td align="right">
                                                                {scoreText(d.original_score)} →{' '}
                                                                {scoreText(d.proposed_score)}
                                                        </Td>
                                                        <Td>{d.reason}</Td>
                                                        <Td>
                                                                {d.requested_by?.username ?? '—'}
                                                                <div className="text-xs text-slate-600">
                                                                        {formatDate(d.requested_at)}
                                                                </div>
                                                        </Td>
                                                        <Td>
                                                                {d.decided_by ? (
                                                                        <>
                                                                                {
                                                                                        d.decided_by
                                                                                                .username
                                                                                }{' '}
                                                                                ·{' '}
                                                                                {formatDate(
                                                                                        d.decided_at,
                                                                                )}
                                                                                {d.decision_reason && (
                                                                                        <div className="text-xs text-slate-600">
                                                                                                “
                                                                                                {
                                                                                                        d.decision_reason
                                                                                                }
                                                                                                ”
                                                                                        </div>
                                                                                )}
                                                                        </>
                                                                ) : (
                                                                        '—'
                                                                )}
                                                        </Td>
                                                </tr>
                                        ))}
                                </TBody>
                        </Table>
                </section>
        )
}

export function History({ entries }: { entries: AuditEntry[] }) {
        if (entries.length === 0) return null
        return (
                <section
                        aria-labelledby="history-heading"
                        className={`${cardClasses} space-y-2 p-4`}
                >
                        <h2 id="history-heading" className="text-base font-semibold text-slate-900">
                                Approval and audit history
                        </h2>
                        <ol aria-label="Audit history" className="space-y-2 text-sm">
                                {entries.map((e) => (
                                        <li key={e.id} className="border-l-2 border-slate-200 pl-3">
                                                <p className="text-slate-900">{e.summary}</p>
                                                {e.reason && (
                                                        <p className="text-slate-700">
                                                                Reason: {e.reason}
                                                        </p>
                                                )}
                                                <p className="text-xs text-slate-600">
                                                        {e.actor} · {formatDate(e.occurred_at)} ·{' '}
                                                        {e.action}
                                                </p>
                                        </li>
                                ))}
                        </ol>
                </section>
        )
}
