import { RefreshCw, Send } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { TextAreaField, TextField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { ReasonForm } from '../../components/common/ReasonForm'
import { StatCard } from '../../components/common/StatCard'
import { cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import {
        getProposal,
        proposalAction,
        saveProposal,
        startProposal,
        type ProposalAction,
} from '../../services/allocationApi'
import type { AllocationProposal, ProposalLine } from '../../types/api'
import { formatDate } from '../../utils/format'
import { parseId } from '../../utils/params'
import { History } from '../annual/AnnualEmployeePage'
import { InvalidLink } from '../common/InvalidLink'
import { EXCLUSIONS, money, percent } from '../compensation/compensationLabels'
import { ALLOCATION_STATUS, policyText } from './allocationLabels'

/** /allocations/proposals/:proposalId */
export function ProposalPage() {
        const proposalId = parseId(useParams().proposalId)
        const query = useApiQuery(
                proposalId === undefined ? null : `proposal|${proposalId}`,
                (signal) => getProposal(proposalId!, signal),
        )
        if (proposalId === undefined)
                return <InvalidLink backTo="/allocations" backLabel="Back to allocations" />
        if (query.isLoading) return <LoadingState label="Loading the proposal…" />
        if (query.error !== undefined || !query.data)
                return <ErrorState error={query.error} onRetry={query.reload} />
        return <ProposalView key={query.data.id} initial={query.data} />
}

type Mode = 'return' | 'approve' | 'reject' | null

function ProposalView({ initial }: { initial: AllocationProposal }) {
        const navigate = useNavigate()
        const [p, setP] = useState(initial)
        const [message, setMessage] = useState<string | null>(null)
        const [mode, setMode] = useState<Mode>(null)
        const [note, setNote] = useState('')
        const action = useAction()
        const a = p.actions
        const status = ALLOCATION_STATUS[p.status]
        const unit = `${p.department.name} — ${p.plant.name}`
        const remaining = p.remaining_budget
        const over = remaining !== null && remaining.startsWith('-')

        async function run(kind: ProposalAction, text?: string, done?: string) {
                const saved = await action.run(() => proposalAction(p.id, kind, text))
                if (saved) {
                        setP(saved)
                        setMode(null)
                        setNote('')
                        setMessage(done ?? null)
                }
        }

        async function next() {
                const created = await action.run(() =>
                        startProposal(p.cycle.id, p.plant.id, p.department.id),
                )
                if (created) navigate(`/allocations/proposals/${created.id}`)
        }

        return (
                <>
                        <PageHeader
                                title={`${unit}: allocation version ${p.version_no}`}
                                description={`${p.cycle.name} · distribution version ${p.distribution_version ?? '—'} · ${policyText(p.policy)}`}
                                breadcrumbs={[
                                        { label: 'Increment allocations', to: '/allocations' },
                                        {
                                                label: p.cycle.name,
                                                to: `/allocations/cycles/${p.cycle.id}`,
                                        },
                                        { label: `${unit} v${p.version_no}` },
                                ]}
                                meta={<Badge tone={status.tone}>{status.label}</Badge>}
                        />
                        <div className="space-y-4">
                                {message && <Alert title={message} />}
                                {p.stale_reasons.length > 0 && (
                                        <Alert
                                                tone="warning"
                                                title="This version is out of date"
                                                action={
                                                        a.can_refresh ? (
                                                                <Button
                                                                        size="sm"
                                                                        isLoading={action.busy}
                                                                        onClick={() =>
                                                                                run(
                                                                                        'refresh',
                                                                                        undefined,
                                                                                        'Brought up to date with the current budget.',
                                                                                )
                                                                        }
                                                                >
                                                                        <RefreshCw
                                                                                aria-hidden="true"
                                                                                className="size-4"
                                                                        />
                                                                        Refresh from the current
                                                                        budget
                                                                </Button>
                                                        ) : undefined
                                                }
                                        >
                                                <ul className="list-disc space-y-1 pl-5">
                                                        {p.stale_reasons.map((r) => (
                                                                <li key={r}>{r}</li>
                                                        ))}
                                                </ul>
                                        </Alert>
                                )}
                                {p.decision_reason && (
                                        <Alert
                                                tone={p.status === 'REJECTED' ? 'danger' : 'info'}
                                                title={`${status.label} by ${p.decided_by?.username ?? '—'} on ${formatDate(p.decided_at)}`}
                                        >
                                                {p.decision_reason}
                                        </Alert>
                                )}
                                {p.admin_reviewed_by && (
                                        <p className="text-sm text-slate-700">
                                                Reviewed by {p.admin_reviewed_by.username} on{' '}
                                                {formatDate(p.admin_reviewed_at)}
                                                {p.admin_note && `: ${p.admin_note}`}
                                        </p>
                                )}
                                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                                        <StatCard
                                                label={`Department budget (${p.cycle.currency})`}
                                                value={money(p.unit_budget)}
                                                hint={
                                                        p.current_unit_budget !== null &&
                                                        p.current_unit_budget !== p.unit_budget
                                                                ? `Now ${money(p.current_unit_budget)} in the published distribution`
                                                                : undefined
                                                }
                                        />
                                        <StatCard
                                                label="Matrix recommendation"
                                                value={money(p.recommended_total)}
                                        />
                                        <StatCard
                                                label="Proposed"
                                                value={money(p.proposed_total)}
                                                hint={`${p.changed_count} change(s)`}
                                        />
                                        <StatCard
                                                label={
                                                        over
                                                                ? 'Over the budget by'
                                                                : 'Remaining budget'
                                                }
                                                value={money(
                                                        over ? remaining!.slice(1) : remaining,
                                                )}
                                                tone={over ? 'warning' : 'default'}
                                        />
                                </dl>
                                {p.suppressed && (
                                        <p className="text-sm text-slate-700">
                                                Amounts are hidden: fewer than 3 employees are
                                                included.
                                        </p>
                                )}
                                {p.lines === null ? (
                                        <p className="text-sm text-slate-700">
                                                Employee-level amounts are visible only to
                                                compensation roles and the department's head.
                                        </p>
                                ) : a.can_edit ? (
                                        <LinesEditor
                                                proposal={p}
                                                onSaved={(saved) => {
                                                        setP(saved)
                                                        setMessage('Draft saved.')
                                                }}
                                        />
                                ) : (
                                        <LinesTable lines={p.lines} currency={p.cycle.currency} />
                                )}
                                {(a.can_submit ||
                                        a.can_forward ||
                                        a.can_return ||
                                        a.can_approve ||
                                        a.can_reject ||
                                        a.can_start_next) && (
                                        <section
                                                aria-labelledby="decision-heading"
                                                className={`${cardClasses} space-y-3 p-4`}
                                        >
                                                <h2
                                                        id="decision-heading"
                                                        className="text-base font-semibold text-slate-900"
                                                >
                                                        Next step
                                                </h2>
                                                <ActionError
                                                        error={action.error}
                                                        title="Nothing was changed"
                                                />
                                                {mode ? (
                                                        <ReasonForm
                                                                label={
                                                                        mode === 'approve'
                                                                                ? 'Reason for approving these allocations'
                                                                                : mode === 'reject'
                                                                                  ? 'Reason for rejecting the proposal'
                                                                                  : 'What should the department revise?'
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
                                                                                ? 'Approve the allocations'
                                                                                : mode === 'reject'
                                                                                  ? 'Reject the proposal'
                                                                                  : 'Return for revision'
                                                                }
                                                                busy={action.busy}
                                                                onSubmit={(reason) =>
                                                                        run(
                                                                                mode,
                                                                                reason,
                                                                                mode === 'approve'
                                                                                        ? 'Approved.'
                                                                                        : mode ===
                                                                                            'reject'
                                                                                          ? 'Rejected.'
                                                                                          : 'Returned to the department.',
                                                                        )
                                                                }
                                                                onCancel={() => setMode(null)}
                                                        />
                                                ) : (
                                                        <div className="space-y-3">
                                                                {a.can_forward && (
                                                                        <TextAreaField
                                                                                label="Review note for the CHRO (optional)"
                                                                                maxLength={1000}
                                                                                value={note}
                                                                                onChange={(e) =>
                                                                                        setNote(
                                                                                                e
                                                                                                        .target
                                                                                                        .value,
                                                                                        )
                                                                                }
                                                                        />
                                                                )}
                                                                <div className="flex flex-wrap gap-2">
                                                                        {a.can_submit && (
                                                                                <Button
                                                                                        variant="primary"
                                                                                        isLoading={
                                                                                                action.busy
                                                                                        }
                                                                                        onClick={() =>
                                                                                                run(
                                                                                                        'submit',
                                                                                                        undefined,
                                                                                                        'Submitted for Admin review.',
                                                                                                )
                                                                                        }
                                                                                >
                                                                                        <Send
                                                                                                aria-hidden="true"
                                                                                                className="size-4"
                                                                                        />
                                                                                        Submit for
                                                                                        review
                                                                                </Button>
                                                                        )}
                                                                        {a.can_forward && (
                                                                                <Button
                                                                                        variant="primary"
                                                                                        isLoading={
                                                                                                action.busy
                                                                                        }
                                                                                        onClick={() =>
                                                                                                run(
                                                                                                        'forward',
                                                                                                        note.trim(),
                                                                                                        'Forwarded to the CHRO.',
                                                                                                )
                                                                                        }
                                                                                >
                                                                                        Forward to
                                                                                        the CHRO
                                                                                </Button>
                                                                        )}
                                                                        {a.can_approve && (
                                                                                <Button
                                                                                        variant="primary"
                                                                                        onClick={() =>
                                                                                                setMode(
                                                                                                        'approve',
                                                                                                )
                                                                                        }
                                                                                >
                                                                                        Approve…
                                                                                </Button>
                                                                        )}
                                                                        {a.can_return && (
                                                                                <Button
                                                                                        onClick={() =>
                                                                                                setMode(
                                                                                                        'return',
                                                                                                )
                                                                                        }
                                                                                >
                                                                                        Return…
                                                                                </Button>
                                                                        )}
                                                                        {a.can_reject && (
                                                                                <Button
                                                                                        variant="danger"
                                                                                        onClick={() =>
                                                                                                setMode(
                                                                                                        'reject',
                                                                                                )
                                                                                        }
                                                                                >
                                                                                        Reject…
                                                                                </Button>
                                                                        )}
                                                                        {a.can_start_next && (
                                                                                <Button
                                                                                        isLoading={
                                                                                                action.busy
                                                                                        }
                                                                                        onClick={
                                                                                                next
                                                                                        }
                                                                                >
                                                                                        Start the
                                                                                        next version
                                                                                </Button>
                                                                        )}
                                                                </div>
                                                        </div>
                                                )}
                                        </section>
                                )}
                                {p.excluded && p.excluded.length > 0 && (
                                        <section
                                                aria-labelledby="excluded-heading"
                                                className="space-y-1"
                                        >
                                                <h2
                                                        id="excluded-heading"
                                                        className="text-base font-semibold text-slate-900"
                                                >
                                                        Excluded employees
                                                </h2>
                                                <ul className="space-y-1 text-sm">
                                                        {p.excluded.map((x) => (
                                                                <li key={x.employee.id}>
                                                                        {x.employee.full_name} (
                                                                        {x.employee.employee_code}):{' '}
                                                                        {EXCLUSIONS[x.code ?? ''] ??
                                                                                x.code}
                                                                        {x.reason &&
                                                                                ` — ${x.reason}`}
                                                                </li>
                                                        ))}
                                                </ul>
                                        </section>
                                )}
                                <section aria-labelledby="versions-heading" className="space-y-1">
                                        <h2
                                                id="versions-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Versions
                                        </h2>
                                        <ul
                                                aria-label="Proposal versions"
                                                className="space-y-1 text-sm"
                                        >
                                                {p.versions.map((v) => (
                                                        <li key={v.id}>
                                                                <Link
                                                                        to={`/allocations/proposals/${v.id}`}
                                                                        className={linkClasses}
                                                                >
                                                                        Version {v.version_no}
                                                                </Link>{' '}
                                                                <Badge
                                                                        tone={
                                                                                ALLOCATION_STATUS[
                                                                                        v.status
                                                                                ].tone
                                                                        }
                                                                >
                                                                        {
                                                                                ALLOCATION_STATUS[
                                                                                        v.status
                                                                                ].label
                                                                        }
                                                                </Badge>{' '}
                                                                {money(v.proposed_total)}
                                                        </li>
                                                ))}
                                        </ul>
                                </section>
                                <History entries={p.history} />
                        </div>
                </>
        )
}

function LinesTable({ lines, currency }: { lines: ProposalLine[]; currency: string }) {
        return (
                <Table caption="Employee allocations">
                        <thead>
                                <tr>
                                        <Th>Employee</Th>
                                        <Th align="right">Current salary</Th>
                                        <Th align="right">Recommended</Th>
                                        <Th align="right">Proposed</Th>
                                        <Th align="right">Difference</Th>
                                        <Th>Reason</Th>
                                </tr>
                        </thead>
                        <TBody>
                                {lines.map((x) => (
                                        <tr key={x.employee.id}>
                                                <Td>
                                                        {x.employee.full_name}
                                                        <div className="text-xs text-slate-600">
                                                                {x.employee.employee_code}
                                                        </div>
                                                </Td>
                                                <Td align="right">
                                                        {money(x.current_salary, currency)}
                                                </Td>
                                                <Td align="right">
                                                        {percent(x.recommended_percent)}
                                                        <div className="text-xs text-slate-600">
                                                                {money(x.recommended_amount)}
                                                        </div>
                                                </Td>
                                                <Td align="right">
                                                        {percent(x.proposed_percent)}
                                                        <div className="text-xs text-slate-600">
                                                                {money(x.proposed_amount)}
                                                        </div>
                                                </Td>
                                                <Td align="right">{money(x.difference)}</Td>
                                                <Td>{x.reason ?? '—'}</Td>
                                        </tr>
                                ))}
                        </TBody>
                </Table>
        )
}

function LinesEditor({
        proposal,
        onSaved,
}: {
        proposal: AllocationProposal
        onSaved: (p: AllocationProposal) => void
}) {
        const lines = proposal.lines ?? []
        const fixed = !proposal.policy.configured || proposal.policy.mode === 'RECOMMENDATION_ONLY'
        const [values, setValues] = useState(() =>
                Object.fromEntries(
                        lines.map((x) => [
                                x.employee.id,
                                { percent: x.proposed_percent, reason: x.reason ?? '' },
                        ]),
                ),
        )
        const [note, setNote] = useState(proposal.note ?? '')
        const action = useAction()

        async function handleSave(event: FormEvent) {
                event.preventDefault()
                const saved = await action.run(() =>
                        saveProposal(proposal.id, {
                                note: note.trim() || null,
                                lines: lines.map((x) => ({
                                        employee_id: x.employee.id,
                                        proposed_percent: values[x.employee.id].percent.trim(),
                                        reason: values[x.employee.id].reason.trim() || null,
                                })),
                        }),
                )
                if (saved) onSaved(saved)
        }

        return (
                <form
                        onSubmit={handleSave}
                        noValidate
                        aria-label="Proposed increments"
                        className="space-y-3"
                >
                        {fixed && (
                                <Alert title="Recommendation only">
                                        The cycle's policy doesn't allow changes; confirm the matrix
                                        recommendation and submit.
                                </Alert>
                        )}
                        <Table caption="Employee allocations">
                                <thead>
                                        <tr>
                                                <Th>Employee</Th>
                                                <Th align="right">Current salary</Th>
                                                <Th align="right">Recommended</Th>
                                                <Th>Proposed %</Th>
                                                <Th>Reason for a change</Th>
                                        </tr>
                                </thead>
                                <TBody>
                                        {lines.map((x) => {
                                                const v = values[x.employee.id]
                                                const set = (change: Partial<typeof v>) =>
                                                        setValues({
                                                                ...values,
                                                                [x.employee.id]: {
                                                                        ...v,
                                                                        ...change,
                                                                },
                                                        })
                                                const locked = fixed || x.own
                                                return (
                                                        <tr key={x.employee.id}>
                                                                <Td>
                                                                        {x.employee.full_name}
                                                                        <div className="text-xs text-slate-600">
                                                                                {
                                                                                        x.employee
                                                                                                .employee_code
                                                                                }
                                                                                {x.own &&
                                                                                        ' · your own increment stays at the recommendation'}
                                                                        </div>
                                                                </Td>
                                                                <Td align="right">
                                                                        {money(x.current_salary)}
                                                                </Td>
                                                                <Td align="right">
                                                                        {percent(
                                                                                x.recommended_percent,
                                                                        )}
                                                                        <div className="text-xs text-slate-600">
                                                                                {money(
                                                                                        x.recommended_amount,
                                                                                )}
                                                                        </div>
                                                                </Td>
                                                                <Td>
                                                                        <div className="w-28">
                                                                                <TextField
                                                                                        label={`Proposed % for ${x.employee.full_name}`}
                                                                                        inputMode="decimal"
                                                                                        disabled={
                                                                                                locked
                                                                                        }
                                                                                        value={
                                                                                                v.percent
                                                                                        }
                                                                                        onChange={(
                                                                                                e,
                                                                                        ) =>
                                                                                                set(
                                                                                                        {
                                                                                                                percent: e
                                                                                                                        .target
                                                                                                                        .value,
                                                                                                        },
                                                                                                )
                                                                                        }
                                                                                />
                                                                        </div>
                                                                        <div className="text-xs text-slate-600">
                                                                                {money(
                                                                                        x.proposed_amount,
                                                                                )}{' '}
                                                                                saved
                                                                        </div>
                                                                </Td>
                                                                <Td>
                                                                        <TextField
                                                                                label={`Reason for ${x.employee.full_name}`}
                                                                                maxLength={500}
                                                                                disabled={locked}
                                                                                value={v.reason}
                                                                                onChange={(e) =>
                                                                                        set({
                                                                                                reason: e
                                                                                                        .target
                                                                                                        .value,
                                                                                        })
                                                                                }
                                                                        />
                                                                </Td>
                                                        </tr>
                                                )
                                        })}
                                </TBody>
                        </Table>
                        <TextAreaField
                                label="Note (optional)"
                                maxLength={1000}
                                value={note}
                                onChange={(e) => setNote(e.target.value)}
                        />
                        <ActionError error={action.error} title="The draft was not saved" />
                        <Button type="submit" isLoading={action.busy}>
                                Save the draft
                        </Button>
                </form>
        )
}
