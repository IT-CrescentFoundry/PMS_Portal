import { ArrowRight, Check, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { ReasonForm } from '../../components/common/ReasonForm'
import { cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import {
        decideCorrection,
        getCorrection,
        publishCorrection,
        transitionCorrection,
} from '../../services/correctionsApi'
import type { Correction, CorrectionStatus } from '../../types/api'
import { formatDate, plural } from '../../utils/format'
import { parseId } from '../../utils/params'
import { CORRECTION_STATUS } from '../annual/annualLabels'
import { History } from '../annual/AnnualEmployeePage'
import { InvalidLink } from '../common/InvalidLink'
import { RESULT_STATUS, scoreText } from '../scores/scoreLabels'
import { CorrectionImpact } from './CorrectionImpact'

const STEPS: { status: CorrectionStatus; label: string }[] = [
        { status: 'REQUESTED', label: 'Requested' },
        { status: 'DEPARTMENT_REVIEW', label: 'Department review' },
        { status: 'NORMALIZATION', label: 'Normalization' },
        { status: 'READY', label: 'Ready' },
        { status: 'PUBLISHED', label: 'Published' },
]

function stepLabel(status: CorrectionStatus | null): string {
        return STEPS.find((s) => s.status === status)?.label ?? '—'
}

/** /scores/corrections/:correctionId */
export function CorrectionPage() {
        const correctionId = parseId(useParams().correctionId)
        const query = useApiQuery(
                correctionId === undefined ? null : `correction|${correctionId}`,
                (signal) => getCorrection(correctionId!, signal),
        )
        if (correctionId === undefined)
                return <InvalidLink backTo="/scores/corrections" backLabel="Back to corrections" />
        if (query.isLoading) return <LoadingState label="Loading the correction…" />
        if (query.error !== undefined || !query.data) {
                return (
                        <>
                                <PageHeader
                                        title="Quarter correction"
                                        breadcrumbs={[
                                                { label: 'Corrections', to: '/scores/corrections' },
                                                { label: 'Correction' },
                                        ]}
                                />
                                <ErrorState error={query.error} onRetry={query.reload} />
                        </>
                )
        }
        return <CorrectionView key={query.data.id} initial={query.data} />
}

function CorrectionView({ initial }: { initial: Correction }) {
        const [c, setC] = useState(initial)
        const [mode, setMode] = useState<'idle' | 'approve' | 'reject' | 'return' | 'publish'>(
                'idle',
        )
        const [message, setMessage] = useState<string | null>(null)
        const action = useAction()
        const a = c.actions
        const status = CORRECTION_STATUS[c.status]

        async function run(change: () => Promise<Correction>, done: string) {
                setMessage(null)
                const updated = await action.run(change)
                if (updated) {
                        setC(updated)
                        setMode('idle')
                        setMessage(done)
                }
        }

        const current = STEPS.findIndex((s) => s.status === c.status)
        return (
                <>
                        <PageHeader
                                title={`Correction ${c.id} · ${c.quarter.name}`}
                                description={c.reason}
                                breadcrumbs={[
                                        { label: 'Corrections', to: '/scores/corrections' },
                                        { label: `Correction ${c.id}` },
                                ]}
                                meta={<Badge tone={status.tone}>{status.label}</Badge>}
                        />
                        <div className="space-y-4">
                                {c.status !== 'REJECTED' && (
                                        <ol
                                                aria-label="Correction steps"
                                                className="grid grid-cols-2 gap-2 sm:grid-cols-5"
                                        >
                                                {STEPS.map((step, index) => {
                                                        const done =
                                                                current > index ||
                                                                c.status === 'PUBLISHED'
                                                        const here = index === current
                                                        return (
                                                                <li
                                                                        key={step.status}
                                                                        aria-current={
                                                                                here
                                                                                        ? 'step'
                                                                                        : undefined
                                                                        }
                                                                        className={`rounded-md border p-2 text-sm font-semibold ${here ? 'border-brand-500 bg-brand-50' : done ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-white'}`}
                                                                >
                                                                        <span className="flex items-center gap-1 text-slate-900">
                                                                                {done && (
                                                                                        <Check
                                                                                                aria-hidden="true"
                                                                                                className="size-4 text-emerald-700"
                                                                                        />
                                                                                )}
                                                                                {index + 1}.{' '}
                                                                                {step.label}
                                                                                {done && (
                                                                                        <span className="sr-only">
                                                                                                {' '}
                                                                                                (done)
                                                                                        </span>
                                                                                )}
                                                                        </span>
                                                                </li>
                                                        )
                                                })}
                                        </ol>
                                )}
                                {message && <Alert title={message} />}
                                <ActionError
                                        error={action.error}
                                        title="The correction did not move"
                                />

                                <section
                                        aria-labelledby="request-heading"
                                        className={`${cardClasses} space-y-2 p-4`}
                                >
                                        <h2
                                                id="request-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Request and decision
                                        </h2>
                                        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                                                <div>
                                                        <dt className="font-medium text-slate-700">
                                                                Requested by
                                                        </dt>
                                                        <dd>
                                                                {c.requested_by?.username ?? '—'} ·{' '}
                                                                {formatDate(c.requested_at)}
                                                        </dd>
                                                </div>
                                                <div>
                                                        <dt className="font-medium text-slate-700">
                                                                Corrects
                                                        </dt>
                                                        <dd>Published version {c.base_version}</dd>
                                                </div>
                                                <div>
                                                        <dt className="font-medium text-slate-700">
                                                                Becomes
                                                        </dt>
                                                        <dd>
                                                                {c.version_no
                                                                        ? `Version ${c.version_no}`
                                                                        : 'A new version, once approved'}
                                                        </dd>
                                                </div>
                                                <div>
                                                        <dt className="font-medium text-slate-700">
                                                                CHRO decision
                                                        </dt>
                                                        <dd>
                                                                {c.decided_by
                                                                        ? `${c.status === 'REJECTED' ? 'Rejected' : 'Approved'} by ${c.decided_by.username} · ${formatDate(c.decided_at)}`
                                                                        : 'Awaiting the CHRO'}
                                                                {c.decision_reason && (
                                                                        <div className="text-xs text-slate-600">
                                                                                “{c.decision_reason}
                                                                                ”
                                                                        </div>
                                                                )}
                                                        </dd>
                                                </div>
                                        </dl>
                                        {a.can_decide && mode === 'idle' && (
                                                <div className="flex flex-wrap gap-2">
                                                        <Button
                                                                variant="primary"
                                                                onClick={() => setMode('approve')}
                                                        >
                                                                Approve the correction…
                                                        </Button>
                                                        <Button onClick={() => setMode('reject')}>
                                                                Reject the correction…
                                                        </Button>
                                                </div>
                                        )}
                                        {(mode === 'approve' || mode === 'reject') && (
                                                <ReasonForm
                                                        label={
                                                                mode === 'approve'
                                                                        ? 'Why is the correction approved?'
                                                                        : 'Why is the correction rejected?'
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
                                                                        ? 'Approve the correction'
                                                                        : 'Reject the correction'
                                                        }
                                                        busy={action.busy}
                                                        onCancel={() => setMode('idle')}
                                                        onSubmit={(reason) =>
                                                                run(
                                                                        () =>
                                                                                decideCorrection(
                                                                                        c.id,
                                                                                        mode,
                                                                                        reason,
                                                                                ),
                                                                        mode === 'approve'
                                                                                ? 'Approved: the corrected version is open for department review.'
                                                                                : 'Rejected: the published quarter is unchanged.',
                                                                )
                                                        }
                                                />
                                        )}
                                </section>

                                <CorrectionImpact
                                        changes={c.changes}
                                        preview={c.preview}
                                        affected={c.affected}
                                />

                                {c.version_no !== null && (
                                        <section
                                                aria-labelledby="version-heading"
                                                className="space-y-2"
                                        >
                                                <h2
                                                        id="version-heading"
                                                        className="text-base font-semibold text-slate-900"
                                                >
                                                        Version {c.version_no} under review
                                                </h2>
                                                {c.sheets.length > 0 && (
                                                        <Table caption="Corrected KPI sheet results">
                                                                <thead>
                                                                        <tr>
                                                                                <Th>Employee</Th>
                                                                                <Th>Status</Th>
                                                                                <Th align="right">
                                                                                        Corrected
                                                                                        score
                                                                                </Th>
                                                                                <Th align="right">
                                                                                        Currently
                                                                                        published
                                                                                </Th>
                                                                        </tr>
                                                                </thead>
                                                                <TBody>
                                                                        {c.sheets.map((s) => (
                                                                                <tr
                                                                                        key={
                                                                                                s.sheet_id
                                                                                        }
                                                                                >
                                                                                        <Td>
                                                                                                <Link
                                                                                                        to={`/scores/results/${s.sheet_id}`}
                                                                                                        className={
                                                                                                                linkClasses
                                                                                                        }
                                                                                                >
                                                                                                        {
                                                                                                                s
                                                                                                                        .employee
                                                                                                                        .full_name
                                                                                                        }
                                                                                                </Link>
                                                                                                <div className="text-xs text-slate-600">
                                                                                                        {
                                                                                                                s.unit
                                                                                                        }
                                                                                                </div>
                                                                                        </Td>
                                                                                        <Td>
                                                                                                {s.status ? (
                                                                                                        <Badge
                                                                                                                tone={
                                                                                                                        RESULT_STATUS[
                                                                                                                                s
                                                                                                                                        .status
                                                                                                                        ]
                                                                                                                                .tone
                                                                                                                }
                                                                                                        >
                                                                                                                {
                                                                                                                        RESULT_STATUS[
                                                                                                                                s
                                                                                                                                        .status
                                                                                                                        ]
                                                                                                                                .label
                                                                                                                }
                                                                                                        </Badge>
                                                                                                ) : (
                                                                                                        '—'
                                                                                                )}
                                                                                        </Td>
                                                                                        <Td align="right">
                                                                                                {scoreText(
                                                                                                        s.final_score,
                                                                                                )}
                                                                                        </Td>
                                                                                        <Td align="right">
                                                                                                {scoreText(
                                                                                                        s.published_score,
                                                                                                )}
                                                                                        </Td>
                                                                                </tr>
                                                                        ))}
                                                                </TBody>
                                                        </Table>
                                                )}
                                                {c.cohorts.length > 0 && (
                                                        <ul
                                                                aria-label="Renormalized cohorts"
                                                                className="space-y-1 text-sm"
                                                        >
                                                                {c.cohorts.map((r) => (
                                                                        <li key={r.run_id}>
                                                                                <Link
                                                                                        to={`/scores/normalization/${r.run_id}`}
                                                                                        className={
                                                                                                linkClasses
                                                                                        }
                                                                                >
                                                                                        {r.label}
                                                                                </Link>{' '}
                                                                                <span className="text-slate-600">
                                                                                        ·{' '}
                                                                                        {r.status.toLowerCase()}
                                                                                </span>
                                                                        </li>
                                                                ))}
                                                        </ul>
                                                )}
                                        </section>
                                )}

                                {(a.can_advance || a.can_return || a.can_publish) && (
                                        <section
                                                aria-labelledby="next-heading"
                                                className={`${cardClasses} space-y-3 p-4`}
                                        >
                                                <h2
                                                        id="next-heading"
                                                        className="text-base font-semibold text-slate-900"
                                                >
                                                        {a.can_publish
                                                                ? 'Publication'
                                                                : `Next step: ${stepLabel(c.next_status)}`}
                                                </h2>
                                                {c.blockers.length > 0 ? (
                                                        <Alert
                                                                tone="warning"
                                                                title={`${plural(c.blockers.length, 'item')} to resolve first`}
                                                        >
                                                                <ul className="list-disc space-y-0.5 pl-5">
                                                                        {c.blockers.map((b) => (
                                                                                <li key={b}>{b}</li>
                                                                        ))}
                                                                </ul>
                                                        </Alert>
                                                ) : (
                                                        <p className="text-sm text-slate-700">
                                                                Every check for this step passes.
                                                        </p>
                                                )}
                                                {mode === 'idle' && (
                                                        <div className="flex flex-wrap gap-2">
                                                                {a.can_advance && c.next_status && (
                                                                        <Button
                                                                                variant="primary"
                                                                                isLoading={
                                                                                        action.busy
                                                                                }
                                                                                disabled={
                                                                                        c.blockers
                                                                                                .length >
                                                                                        0
                                                                                }
                                                                                onClick={() =>
                                                                                        run(
                                                                                                () =>
                                                                                                        transitionCorrection(
                                                                                                                c.id,
                                                                                                                c.next_status!,
                                                                                                        ),
                                                                                                `Moved to ${stepLabel(c.next_status)}.`,
                                                                                        )
                                                                                }
                                                                        >
                                                                                <ArrowRight
                                                                                        aria-hidden="true"
                                                                                        className="size-4"
                                                                                />
                                                                                Move to{' '}
                                                                                {stepLabel(
                                                                                        c.next_status,
                                                                                )}
                                                                        </Button>
                                                                )}
                                                                {a.can_publish && (
                                                                        <Button
                                                                                variant="primary"
                                                                                disabled={
                                                                                        action.busy ||
                                                                                        c.blockers
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
                                                                                corrected version…
                                                                        </Button>
                                                                )}
                                                                {a.can_return &&
                                                                        c.previous_status && (
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
                                                                                        {stepLabel(
                                                                                                c.previous_status,
                                                                                        )}
                                                                                        …
                                                                                </Button>
                                                                        )}
                                                        </div>
                                                )}
                                                {mode === 'return' && c.previous_status && (
                                                        <ReasonForm
                                                                label={`Why does the correction return to ${stepLabel(c.previous_status).toLowerCase()}?`}
                                                                hint="At least 10 characters; recorded in the audit trail."
                                                                minLength={10}
                                                                submitLabel={`Return to ${stepLabel(c.previous_status)}`}
                                                                busy={action.busy}
                                                                onSubmit={(reason) =>
                                                                        run(
                                                                                () =>
                                                                                        transitionCorrection(
                                                                                                c.id,
                                                                                                c.previous_status!,
                                                                                                reason,
                                                                                        ),
                                                                                `Returned to ${stepLabel(c.previous_status)}.`,
                                                                        )
                                                                }
                                                                onCancel={() => setMode('idle')}
                                                        />
                                                )}
                                                {mode === 'publish' && (
                                                        <Alert
                                                                tone="warning"
                                                                title="Publishing makes the corrected version current"
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
                                                                                                                publishCorrection(
                                                                                                                        c.id,
                                                                                                                ),
                                                                                                        `Version ${c.version_no} published. The earlier version stays in the history.`,
                                                                                                )
                                                                                        }
                                                                                >
                                                                                        Publish
                                                                                        version{' '}
                                                                                        {
                                                                                                c.version_no
                                                                                        }
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
                                                                The corrected results replace the
                                                                published ones as the current
                                                                version of {c.quarter.name}. The
                                                                replaced version is kept as
                                                                superseded; annual results
                                                                calculated from it are marked for
                                                                recalculation and approval.
                                                        </Alert>
                                                )}
                                        </section>
                                )}

                                <History entries={c.history} />
                        </div>
                </>
        )
}
