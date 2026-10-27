import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { SelectField, TextAreaField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { ReasonForm } from '../../components/common/ReasonForm'
import { cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { approveCohort, getCohort, placeMember, reopenCohort } from '../../services/quarterlyApi'
import type { Cohort, CohortMember } from '../../types/api'
import { formatDate } from '../../utils/format'
import { unitLabel } from '../../utils/labels'
import { parseId } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { InvalidLink } from '../common/InvalidLink'
import { scoreText } from '../scores/scoreLabels'
import { PLACEMENT_LABELS } from './quarterLabels'
import { CohortStatusBadge } from './QuarterParts'

/** /scores/normalization/:runId */
export function CohortPage() {
        const runId = parseId(useParams().runId)
        const query = useApiQuery(runId === undefined ? null : `cohort|${runId}`, (signal) =>
                getCohort(runId!, signal),
        )
        if (runId === undefined)
                return (
                        <InvalidLink
                                backTo="/scores/normalization"
                                backLabel="Back to normalization"
                        />
                )
        if (query.isLoading) return <LoadingState label="Loading the cohort…" />
        if (query.error !== undefined || !query.data) {
                return (
                        <>
                                <PageHeader
                                        title="Normalization cohort"
                                        breadcrumbs={[
                                                {
                                                        label: 'Normalization',
                                                        to: '/scores/normalization',
                                                },
                                                { label: 'Cohort' },
                                        ]}
                                />
                                <ErrorState error={query.error} onRetry={query.reload} />
                        </>
                )
        }
        return <CohortView key={query.data.id} initial={query.data} />
}

const PLACED_BY_REVIEWER = ['NEEDS_RESOLUTION', 'TIE_RESOLVED', 'SMALL_COHORT_RESOLVED']

function CohortView({ initial }: { initial: Cohort }) {
        const user = useCurrentUser()
        const [cohort, setCohort] = useState(initial)
        const [placing, setPlacing] = useState<CohortMember | null>(null)
        const [mode, setMode] = useState<'idle' | 'approve' | 'reopen'>('idle')
        const [note, setNote] = useState('')
        const [message, setMessage] = useState<string | null>(null)
        const action = useAction()
        const a = cohort.actions
        const placedByMe = cohort.members.some((m) => m.placed_by?.id === user.id)

        async function run(change: () => Promise<Cohort>, done: string) {
                setMessage(null)
                const updated = await action.run(change)
                if (updated) {
                        setCohort(updated)
                        setPlacing(null)
                        setMode('idle')
                        setMessage(done)
                }
        }

        return (
                <>
                        <PageHeader
                                title={cohort.cohort_label}
                                description={`${cohort.quarter.name} · ${cohort.eligible} of ${cohort.population} employee(s) normalized`}
                                breadcrumbs={[
                                        {
                                                label: 'Normalization',
                                                to: `/scores/normalization?quarter=${cohort.quarter.id}`,
                                        },
                                        { label: cohort.cohort_label },
                                ]}
                                meta={
                                        <>
                                                <CohortStatusBadge status={cohort.status} />
                                                {cohort.version_no > 1 && (
                                                        <Badge tone="info">
                                                                Version {cohort.version_no}
                                                        </Badge>
                                                )}
                                                {cohort.small_cohort && <Badge>Small cohort</Badge>}
                                                <Link
                                                        to={`/matrices/${cohort.policy.matrix_id}/versions/${cohort.policy.version_id}`}
                                                        className={`${linkClasses} text-sm`}
                                                >
                                                        Policy {cohort.policy.code} version{' '}
                                                        {cohort.policy.version_no}
                                                </Link>
                                        </>
                                }
                        />
                        <div className="space-y-4">
                                {message && <Alert title={message} />}
                                <ActionError
                                        error={action.error}
                                        title="The decision was not recorded"
                                />
                                {cohort.policy_problem && (
                                        <Alert tone="danger" title="The policy cannot be used">
                                                {cohort.policy_problem}
                                        </Alert>
                                )}
                                {cohort.approved_by && (
                                        <Alert
                                                title={`Approved by ${cohort.approved_by.username} on ${formatDate(cohort.approved_at)}`}
                                        >
                                                {cohort.approval_note}
                                        </Alert>
                                )}

                                <section
                                        aria-labelledby="distribution-heading"
                                        className="space-y-2"
                                >
                                        <h2
                                                id="distribution-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Distribution
                                        </h2>
                                        <Table caption="Group sizes: target and actual">
                                                <thead>
                                                        <tr>
                                                                <Th>Group</Th>
                                                                <Th align="right">Target %</Th>
                                                                <Th align="right">Target</Th>
                                                                <Th align="right">Actual</Th>
                                                                <Th align="right">Actual %</Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {cohort.distribution.map((d) => (
                                                                <tr
                                                                        key={d.key}
                                                                        className={
                                                                                d.actual_count !==
                                                                                d.target_count
                                                                                        ? 'bg-amber-50'
                                                                                        : ''
                                                                        }
                                                                >
                                                                        <Td>{d.label}</Td>
                                                                        <Td align="right">
                                                                                {d.target_percent} %
                                                                        </Td>
                                                                        <Td align="right">
                                                                                {d.target_count}
                                                                        </Td>
                                                                        <Td align="right">
                                                                                {d.actual_count}
                                                                        </Td>
                                                                        <Td align="right">
                                                                                {d.actual_percent !==
                                                                                null
                                                                                        ? `${d.actual_percent} %`
                                                                                        : '—'}
                                                                        </Td>
                                                                </tr>
                                                        ))}
                                                </TBody>
                                        </Table>
                                        <p className="text-sm text-slate-700">
                                                {cohort.matches_targets
                                                        ? 'The group sizes match the policy’s targets for this cohort (after rounding to whole employees).'
                                                        : 'The group sizes differ from the policy’s targets; the reasons are listed below.'}
                                        </p>
                                </section>

                                {cohort.exception_list.length > 0 && (
                                        <Alert
                                                tone={cohort.unresolved ? 'warning' : 'info'}
                                                title="Exceptions"
                                        >
                                                <ul className="list-disc space-y-0.5 pl-5">
                                                        {cohort.exception_list.map((e, i) => (
                                                                <li key={i}>{e.message}</li>
                                                        ))}
                                                </ul>
                                        </Alert>
                                )}

                                <section aria-labelledby="members-heading" className="space-y-2">
                                        <h2
                                                id="members-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Employees, ranked
                                        </h2>
                                        <Table caption="Cohort members">
                                                <thead>
                                                        <tr>
                                                                <Th align="right">Rank</Th>
                                                                <Th>Employee</Th>
                                                                <Th align="right">Score</Th>
                                                                <Th>Group</Th>
                                                                <Th align="right">Rating</Th>
                                                                <Th>
                                                                        <span className="sr-only">
                                                                                Actions
                                                                        </span>
                                                                </Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {cohort.members.map((m) => (
                                                                <tr key={m.employee.id}>
                                                                        <Td align="right">
                                                                                {m.rank ?? '—'}
                                                                        </Td>
                                                                        <Td>
                                                                                <Link
                                                                                        to={`/scores/quarters/${cohort.quarter.id}/employees/${m.employee.id}`}
                                                                                        className={
                                                                                                linkClasses
                                                                                        }
                                                                                >
                                                                                        {
                                                                                                m
                                                                                                        .employee
                                                                                                        .full_name
                                                                                        }
                                                                                </Link>
                                                                                <div className="text-xs text-slate-600">
                                                                                        {
                                                                                                m
                                                                                                        .employee
                                                                                                        .employee_code
                                                                                        }{' '}
                                                                                        ·{' '}
                                                                                        {unitLabel(
                                                                                                m.home_department,
                                                                                                m.home_plant,
                                                                                        )}
                                                                                </div>
                                                                        </Td>
                                                                        <Td align="right">
                                                                                {scoreText(
                                                                                        m.final_score,
                                                                                )}
                                                                        </Td>
                                                                        <Td>
                                                                                {m.group_label ??
                                                                                        (m.placement ===
                                                                                        'NEEDS_RESOLUTION'
                                                                                                ? 'To be placed'
                                                                                                : '—')}
                                                                                {m.placement && (
                                                                                        <div className="text-xs text-slate-600">
                                                                                                {
                                                                                                        PLACEMENT_LABELS[
                                                                                                                m
                                                                                                                        .placement
                                                                                                        ]
                                                                                                }
                                                                                                {m.placed_by &&
                                                                                                        ` (${m.placed_by.username})`}
                                                                                        </div>
                                                                                )}
                                                                                {m.placement_reason && (
                                                                                        <div className="text-xs text-slate-600">
                                                                                                “
                                                                                                {
                                                                                                        m.placement_reason
                                                                                                }
                                                                                                ”
                                                                                        </div>
                                                                                )}
                                                                        </Td>
                                                                        <Td align="right">
                                                                                {m.normalized_rating ??
                                                                                        '—'}
                                                                        </Td>
                                                                        <Td>
                                                                                {a.can_place &&
                                                                                        m.placement &&
                                                                                        PLACED_BY_REVIEWER.includes(
                                                                                                m.placement,
                                                                                        ) && (
                                                                                                <Button
                                                                                                        size="sm"
                                                                                                        disabled={
                                                                                                                action.busy
                                                                                                        }
                                                                                                        onClick={() =>
                                                                                                                setPlacing(
                                                                                                                        m,
                                                                                                                )
                                                                                                        }
                                                                                                        aria-label={`Place ${m.employee.full_name}`}
                                                                                                >
                                                                                                        Place…
                                                                                                </Button>
                                                                                        )}
                                                                        </Td>
                                                                </tr>
                                                        ))}
                                                </TBody>
                                        </Table>
                                </section>

                                {placing && (
                                        <PlacementForm
                                                key={placing.employee.id}
                                                member={placing}
                                                cohort={cohort}
                                                busy={action.busy}
                                                onCancel={() => setPlacing(null)}
                                                onSubmit={(group, reason) =>
                                                        run(
                                                                () =>
                                                                        placeMember(cohort.id, {
                                                                                employee_id:
                                                                                        placing
                                                                                                .employee
                                                                                                .id,
                                                                                group,
                                                                                reason,
                                                                        }),
                                                                `${placing.employee.full_name} placed.`,
                                                        )
                                                }
                                        />
                                )}

                                {(a.can_approve || a.can_reopen || cohort.status === 'DRAFT') && (
                                        <section
                                                aria-labelledby="approval-heading"
                                                className={`${cardClasses} space-y-3 p-4`}
                                        >
                                                <h2
                                                        id="approval-heading"
                                                        className="text-base font-semibold text-slate-900"
                                                >
                                                        Approval
                                                </h2>
                                                {cohort.status === 'DRAFT' && !a.can_approve && (
                                                        <p className="text-sm text-slate-700">
                                                                {cohort.unresolved > 0
                                                                        ? `${cohort.unresolved} employee(s) must be placed before approval.`
                                                                        : placedByMe
                                                                          ? 'You placed employees in this cohort, so a different HR Head or the CHRO must approve it.'
                                                                          : 'An HR Head or the CHRO whose scope covers every employee of the cohort approves it.'}
                                                        </p>
                                                )}
                                                {mode === 'idle' && (
                                                        <div className="flex flex-wrap gap-2">
                                                                {a.can_approve && (
                                                                        <Button
                                                                                variant="primary"
                                                                                onClick={() =>
                                                                                        setMode(
                                                                                                'approve',
                                                                                        )
                                                                                }
                                                                        >
                                                                                Approve the cohort…
                                                                        </Button>
                                                                )}
                                                                {a.can_reopen && (
                                                                        <Button
                                                                                onClick={() =>
                                                                                        setMode(
                                                                                                'reopen',
                                                                                        )
                                                                                }
                                                                        >
                                                                                Reopen…
                                                                        </Button>
                                                                )}
                                                        </div>
                                                )}
                                                {mode === 'approve' && (
                                                        <form
                                                                onSubmit={(e: FormEvent) => {
                                                                        e.preventDefault()
                                                                        run(
                                                                                () =>
                                                                                        approveCohort(
                                                                                                cohort.id,
                                                                                                note.trim() ||
                                                                                                        null,
                                                                                        ),
                                                                                'Cohort approved.',
                                                                        )
                                                                }}
                                                                className="space-y-3"
                                                        >
                                                                <TextAreaField
                                                                        label="Approval note (optional)"
                                                                        maxLength={1000}
                                                                        value={note}
                                                                        onChange={(e) =>
                                                                                setNote(
                                                                                        e.target
                                                                                                .value,
                                                                                )
                                                                        }
                                                                />
                                                                <div className="flex flex-wrap gap-2">
                                                                        <Button
                                                                                type="submit"
                                                                                variant="primary"
                                                                                isLoading={
                                                                                        action.busy
                                                                                }
                                                                        >
                                                                                Approve
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
                                                        </form>
                                                )}
                                                {mode === 'reopen' && (
                                                        <ReasonForm
                                                                label="Why is the cohort reopened?"
                                                                minLength={10}
                                                                submitLabel="Reopen the cohort"
                                                                busy={action.busy}
                                                                onSubmit={(reason) =>
                                                                        run(
                                                                                () =>
                                                                                        reopenCohort(
                                                                                                cohort.id,
                                                                                                reason,
                                                                                        ),
                                                                                'Cohort reopened.',
                                                                        )
                                                                }
                                                                onCancel={() => setMode('idle')}
                                                        />
                                                )}
                                        </section>
                                )}
                        </div>
                </>
        )
}

function PlacementForm({
        member,
        cohort,
        busy,
        onSubmit,
        onCancel,
}: {
        member: CohortMember
        cohort: Cohort
        busy: boolean
        onSubmit: (group: string, reason: string) => void
        onCancel: () => void
}) {
        const options = member.options ?? []
        const label = (key: string) =>
                cohort.settings?.groups.find((g) => g.key === key)?.label ?? key
        const [group, setGroup] = useState(member.group_key ?? '')
        const [reason, setReason] = useState('')
        const [touched, setTouched] = useState(false)
        const errors = {
                group: group ? undefined : 'Choose a group.',
                reason:
                        reason.trim().length >= 10
                                ? undefined
                                : 'Explain the placement (at least 10 characters).',
        }
        return (
                <form
                        noValidate
                        aria-labelledby="place-heading"
                        onSubmit={(e) => {
                                e.preventDefault()
                                setTouched(true)
                                if (!errors.group && !errors.reason) onSubmit(group, reason.trim())
                        }}
                        className={`${cardClasses} space-y-3 p-4`}
                >
                        <h2 id="place-heading" className="text-base font-semibold text-slate-900">
                                Place {member.employee.full_name}
                        </h2>
                        <p className="text-sm text-slate-700">
                                Score {scoreText(member.final_score)}. The policy leaves this
                                placement to an authorized reviewer; it is recorded with your name
                                and reason.
                        </p>
                        <div className="max-w-xs">
                                <SelectField
                                        label="Group"
                                        value={group}
                                        error={touched ? errors.group : undefined}
                                        onChange={(e) => setGroup(e.target.value)}
                                        options={[
                                                { value: '', label: 'Choose…' },
                                                ...options.map((k) => ({
                                                        value: k,
                                                        label: label(k),
                                                })),
                                        ]}
                                />
                        </div>
                        <TextAreaField
                                label="Reason"
                                maxLength={500}
                                value={reason}
                                error={touched ? errors.reason : undefined}
                                onChange={(e) => setReason(e.target.value)}
                        />
                        <div className="flex flex-wrap gap-2">
                                <Button type="submit" variant="primary" isLoading={busy}>
                                        Save placement
                                </Button>
                                <Button variant="ghost" disabled={busy} onClick={onCancel}>
                                        Cancel
                                </Button>
                        </div>
                </form>
        )
}
