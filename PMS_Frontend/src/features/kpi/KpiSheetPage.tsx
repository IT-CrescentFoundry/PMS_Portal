import { Lock, Snowflake } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { AssignmentTypeBadge, Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { SelectField, TextAreaField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { ReasonForm } from '../../components/common/ReasonForm'
import { buttonClasses, cardClasses, linkClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { listJDs } from '../../services/jdApi'
import {
        copySheet,
        getSheet,
        listKpis,
        listPolicies,
        listQuarters,
        publishSheet,
        reopenSheet,
        requestDeviation,
        saveSheet,
} from '../../services/kpiApi'
import type { JDSummary, Kpi, KpiSheet, Quarter, ScoringPolicy } from '../../types/api'
import { formatDate } from '../../utils/format'
import { parseId } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { canWriteKpi } from '../auth/permissions'
import { InvalidLink } from '../common/InvalidLink'
import { ItemsEditor } from './ItemsEditor'
import {
        hasRowErrors,
        rowsFromItems,
        rowsToInput,
        validateRows,
        type ItemRow,
        type RowErrors,
} from './itemRows'
import { DIRECTION_LABELS, quarterLabel } from './kpiLabels'
import { QuarterStatusBadge, SheetStatusBadge } from './StatusBadges'
import { summarizeWeights } from './weightage'

export function KpiSheetPage() {
        const sheetId = parseId(useParams().sheetId)
        const sheet = useApiQuery(sheetId === undefined ? null : `sheet|${sheetId}`, (signal) =>
                getSheet(sheetId!, signal),
        )
        const unit = sheet.data?.assignment
        const kpis = useApiQuery(
                unit ? `kpis-at|${unit.plant.id}|${unit.department.id}` : null,
                (signal) =>
                        listKpis(
                                {
                                        plantId: unit!.plant.id,
                                        departmentId: unit!.department.id,
                                },
                                signal,
                        ),
        )
        const jds = useApiQuery(unit ? `jds-in|${unit.department.id}` : null, (signal) =>
                listJDs({ departmentId: unit!.department.id }, signal),
        )
        const policies = useApiQuery('policies', (signal) => listPolicies(signal))
        const quarters = useApiQuery('quarters', (signal) => listQuarters(signal))

        if (sheetId === undefined)
                return <InvalidLink backTo="/kpi/sheets" backLabel="Back to KPI sheets" />
        const failed = [sheet, kpis, jds, policies, quarters].find((q) => q.error !== undefined)
        if (failed) {
                return (
                        <>
                                <PageHeader
                                        title="KPI sheet"
                                        breadcrumbs={[
                                                {
                                                        label: 'KPI sheets',
                                                        to: '/kpi/sheets',
                                                },
                                                { label: 'KPI sheet' },
                                        ]}
                                />
                                <ErrorState error={failed.error} onRetry={failed.reload} />
                        </>
                )
        }
        if (!sheet.data || !kpis.data || !jds.data || !policies.data || !quarters.data)
                return <LoadingState label="Loading KPI sheet…" />
        return (
                <SheetEditor
                        key={sheet.data.id}
                        initial={sheet.data}
                        usableKpis={kpis.data}
                        jds={jds.data.filter(
                                (jd) =>
                                        jd.plant === null ||
                                        jd.plant.id === sheet.data!.assignment.plant.id,
                        )}
                        policies={policies.data}
                        quarters={quarters.data}
                />
        )
}

/** The usable KPIs plus any KPI already on the sheet (e.g. since made inactive). */
function kpiOptions(usable: Kpi[], sheet: KpiSheet): Kpi[] {
        const known = new Set(usable.map((k) => k.id))
        const extra: Kpi[] = sheet.items
                .filter((item) => !known.has(item.kpi.id))
                .map((item) => ({
                        ...item.kpi,
                        description: null,
                        unit: item.unit,
                        default_scoring_policy: item.scoring_policy,
                        data_source: null,
                        is_active: false,
                        applicability: [],
                        reporting_frequency: item.measurement?.reporting_frequency ?? null,
                        aggregation: item.measurement?.aggregation ?? null,
                        measurement_method: item.measurement?.measurement_method ?? null,
                }))
        return [...usable, ...extra]
}

interface EditorProps {
        initial: KpiSheet
        usableKpis: Kpi[]
        jds: JDSummary[]
        policies: ScoringPolicy[]
        quarters: Quarter[]
}

function SheetEditor({ initial, usableKpis, jds, policies, quarters }: EditorProps) {
        const user = useCurrentUser()
        const [sheet, setSheet] = useState(initial)
        const [rows, setRows] = useState<ItemRow[]>(() => rowsFromItems(initial.items))
        const [notes, setNotes] = useState(initial.notes ?? '')
        const [jdId, setJdId] = useState(
                initial.job_description ? String(initial.job_description.id) : '',
        )
        const [errors, setErrors] = useState<RowErrors[] | null>(null)
        const [warnings, setWarnings] = useState<string[]>(initial.warnings)
        const [notice, setNotice] = useState<string | null>(null)
        const [dirty, setDirty] = useState(false)
        const [reopening, setReopening] = useState(false)
        const [requesting, setRequesting] = useState(false)
        const action = useAction()

        const kpis = kpiOptions(usableKpis, sheet)
        const directions = new Map(kpis.map((k) => [k.id, k]))
        const { assignment, quarter } = sheet
        const writer = canWriteKpi(user)

        function load(next: KpiSheet, message: string) {
                setSheet(next)
                setRows(rowsFromItems(next.items))
                setNotes(next.notes ?? '')
                setJdId(next.job_description ? String(next.job_description.id) : '')
                setWarnings(next.warnings)
                setErrors(null)
                setDirty(false)
                setNotice(message)
        }

        function edit(next: ItemRow[]) {
                setRows(next)
                setDirty(true)
                setNotice(null)
                if (errors) setErrors(validateRows(next, directions))
        }

        async function save(): Promise<KpiSheet | undefined> {
                const found = validateRows(rows, directions)
                setErrors(found)
                if (hasRowErrors(found)) return undefined
                const result = await action.run(() =>
                        saveSheet(sheet.id, {
                                items: rowsToInput(rows, directions),
                                notes: notes.trim() || null,
                                job_description_id: jdId ? Number(jdId) : null,
                        }),
                )
                if (!result) return undefined
                load(result.sheet, 'Draft saved.')
                setWarnings(result.warnings)
                return result.sheet
        }

        async function publish() {
                const found = validateRows(rows, directions)
                setErrors(found)
                if (
                        hasRowErrors(found) ||
                        !summarizeWeights(rows.map((r) => r.weightage)).complete
                ) {
                        setNotice(null)
                        return
                }
                const saved = dirty ? await save() : sheet
                if (!saved) return
                const published = await action.run(() => publishSheet(sheet.id))
                if (published)
                        load(
                                published,
                                'Published. The KPIs lock when HR starts scoring for the quarter.',
                        )
        }

        async function reopen(reason: string) {
                const reopened = await action.run(() => reopenSheet(sheet.id, reason))
                if (reopened) {
                        setReopening(false)
                        load(reopened, 'Reopened as a draft.')
                }
        }

        const summary = summarizeWeights(rows.map((r) => r.weightage))
        const publishBlocked = errors !== null && (hasRowErrors(errors) || !summary.complete)

        return (
                <>
                        <PageHeader
                                title={`${assignment.employee.full_name} · ${quarter.name}`}
                                breadcrumbs={[
                                        {
                                                label: 'KPI sheets',
                                                to: `/kpi/sheets?quarter=${quarter.id}`,
                                        },
                                        {
                                                label: `${assignment.employee.employee_code} · ${quarter.name}`,
                                        },
                                ]}
                                meta={
                                        <>
                                                <SheetStatusBadge status={sheet.status} />
                                                <AssignmentTypeBadge
                                                        primary={assignment.is_primary}
                                                />
                                                <span className="text-sm text-slate-700">
                                                        {assignment.department.name} —{' '}
                                                        {assignment.plant.name} ·{' '}
                                                        {assignment.designation.name}
                                                </span>
                                                <QuarterStatusBadge status={quarter.status} />
                                        </>
                                }
                        />

                        <div className="space-y-4">
                                {notice && <Alert title={notice} />}
                                <ActionError error={action.error} />
                                <StatusExplanation
                                        sheet={sheet}
                                        writer={writer}
                                        reopening={reopening}
                                        onReopen={() => setReopening(true)}
                                        onRequestDeviation={() => setRequesting(true)}
                                        requesting={requesting}
                                />
                                {reopening && (
                                        <ReasonForm
                                                label="Why does this sheet need to change?"
                                                hint="Recorded in the audit trail."
                                                submitLabel="Reopen as draft"
                                                busy={action.busy}
                                                onSubmit={reopen}
                                                onCancel={() => setReopening(false)}
                                        />
                                )}

                                {sheet.can_edit ? (
                                        <section
                                                aria-labelledby="items-heading"
                                                className="space-y-4"
                                        >
                                                <h2
                                                        id="items-heading"
                                                        className="text-lg font-semibold text-slate-900"
                                                >
                                                        KPIs, weightages and targets
                                                </h2>
                                                {usableKpis.length === 0 && (
                                                        <Alert
                                                                tone="warning"
                                                                title="No KPIs available here"
                                                        >
                                                                No KPI in the library applies to{' '}
                                                                {assignment.department.name} at{' '}
                                                                {assignment.plant.name}.{' '}
                                                                <Link
                                                                        to="/kpi/library/new"
                                                                        className={linkClasses}
                                                                >
                                                                        Add one to the library
                                                                </Link>
                                                                .
                                                        </Alert>
                                                )}
                                                <ItemsEditor
                                                        caption={`KPIs for ${assignment.employee.full_name}, ${quarter.name}`}
                                                        rows={rows}
                                                        onChange={edit}
                                                        kpis={kpis}
                                                        policies={policies}
                                                        errors={errors}
                                                />
                                                {warnings.length > 0 && (
                                                        <Alert
                                                                tone="warning"
                                                                title="Check before publishing"
                                                        >
                                                                <ul className="list-disc pl-5">
                                                                        {warnings.map((w) => (
                                                                                <li key={w}>{w}</li>
                                                                        ))}
                                                                </ul>
                                                        </Alert>
                                                )}
                                                <div
                                                        className={`${cardClasses} grid grid-cols-1 gap-4 p-4 md:grid-cols-2`}
                                                >
                                                        <SelectField
                                                                label="Job description (optional)"
                                                                hint="The role's JD for this department and plant."
                                                                value={jdId}
                                                                onChange={(e) => {
                                                                        setJdId(e.target.value)
                                                                        setDirty(true)
                                                                }}
                                                                options={[
                                                                        {
                                                                                value: '',
                                                                                label: 'Not linked',
                                                                        },
                                                                        ...jds.map((jd) => ({
                                                                                value: String(
                                                                                        jd.id,
                                                                                ),
                                                                                label: `${jd.title} (${jd.code})`,
                                                                        })),
                                                                ]}
                                                        />
                                                        <TextAreaField
                                                                label="Notes (optional)"
                                                                maxLength={1000}
                                                                value={notes}
                                                                onChange={(e) => {
                                                                        setNotes(e.target.value)
                                                                        setDirty(true)
                                                                }}
                                                        />
                                                </div>
                                                {publishBlocked && (
                                                        <Alert
                                                                tone="danger"
                                                                assertive
                                                                title="Not ready to publish"
                                                        >
                                                                {hasRowErrors(errors!)
                                                                        ? 'Fix the highlighted fields.'
                                                                        : 'Weightages must total exactly 100% before publishing.'}
                                                        </Alert>
                                                )}
                                                <div className="flex flex-wrap gap-2">
                                                        <Button
                                                                isLoading={action.busy}
                                                                onClick={save}
                                                        >
                                                                Save draft
                                                        </Button>
                                                        <Button
                                                                variant="primary"
                                                                isLoading={action.busy}
                                                                onClick={publish}
                                                        >
                                                                {dirty
                                                                        ? 'Save and publish'
                                                                        : 'Publish'}
                                                        </Button>
                                                </div>
                                        </section>
                                ) : requesting ? (
                                        <DeviationRequest
                                                sheet={sheet}
                                                kpis={kpis}
                                                policies={policies}
                                                onCancel={() => setRequesting(false)}
                                        />
                                ) : (
                                        <ItemsTable sheet={sheet} />
                                )}

                                {writer && sheet.items.length > 0 && !requesting && (
                                        <CopyToQuarter sheet={sheet} quarters={quarters} />
                                )}
                        </div>
                </>
        )
}

function StatusExplanation({
        sheet,
        writer,
        reopening,
        requesting,
        onReopen,
        onRequestDeviation,
}: {
        sheet: KpiSheet
        writer: boolean
        reopening: boolean
        requesting: boolean
        onReopen: () => void
        onRequestDeviation: () => void
}) {
        const { quarter } = sheet
        if (sheet.status === 'LOCKED') {
                return (
                        <Alert
                                tone="info"
                                title={`Locked${sheet.locked_at ? ` since ${formatDate(sheet.locked_at)}` : ''}: scoring has started for ${quarter.name}`}
                                action={
                                        sheet.pending_deviation_id !== null ? (
                                                <Link
                                                        to={`/kpi/deviations/${sheet.pending_deviation_id}`}
                                                        className={buttonClasses('secondary', 'sm')}
                                                >
                                                        View the pending deviation
                                                </Link>
                                        ) : (
                                                sheet.can_request_deviation &&
                                                !requesting && (
                                                        <Button
                                                                size="sm"
                                                                onClick={onRequestDeviation}
                                                        >
                                                                Request a deviation…
                                                        </Button>
                                                )
                                        )
                                }
                        >
                                KPIs, weightages and targets can now change only through a deviation
                                approved by both the HR Head and the Plant Head.
                                {sheet.pending_deviation_id !== null &&
                                        ' A deviation is awaiting approval.'}
                        </Alert>
                )
        }
        if (sheet.status === 'PUBLISHED') {
                return (
                        <Alert
                                tone="info"
                                title={`Published${sheet.published_at ? ` on ${formatDate(sheet.published_at)}` : ''}`}
                                action={
                                        writer &&
                                        quarter.status === 'DRAFT' &&
                                        !reopening && (
                                                <Button size="sm" onClick={onReopen}>
                                                        Reopen for changes…
                                                </Button>
                                        )
                                }
                        >
                                {quarter.status === 'DRAFT'
                                        ? 'The sheet locks when HR starts scoring for the quarter. Until then it can be reopened, with a reason.'
                                        : 'Scoring has started.'}
                        </Alert>
                )
        }
        if (!sheet.can_edit) {
                return (
                        <Alert tone="warning" title="Read-only draft">
                                {quarter.status !== 'DRAFT'
                                        ? `This draft was not published before scoring started for ${quarter.name}, so it cannot be scored or changed.`
                                        : 'You can view this sheet but not change it.'}
                        </Alert>
                )
        }
        return null
}

function ItemsTable({ sheet }: { sheet: KpiSheet }) {
        if (sheet.items.length === 0) {
                return (
                        <p className={`${cardClasses} p-4 text-sm text-slate-600`}>
                                No KPIs on this sheet.
                        </p>
                )
        }
        return (
                <Table
                        caption={`KPIs for ${sheet.assignment.employee.full_name}, ${sheet.quarter.name}`}
                >
                        <thead>
                                <tr>
                                        <Th>KPI</Th>
                                        <Th align="right">Weightage</Th>
                                        <Th align="right">Quarterly target</Th>
                                        <Th>Unit</Th>
                                        <Th>Scoring rule</Th>
                                        <Th className="hidden lg:table-cell">Target note</Th>
                                </tr>
                        </thead>
                        <TBody>
                                {sheet.items.map((item) => (
                                        <tr key={item.id}>
                                                <Td className="min-w-48">
                                                        {item.kpi.name}
                                                        <p className="text-xs text-slate-600">
                                                                {
                                                                        DIRECTION_LABELS[
                                                                                item.kpi.direction
                                                                        ]
                                                                }
                                                        </p>
                                                </Td>
                                                <Td align="right">{item.weightage.toFixed(2)}%</Td>
                                                <Td align="right">{item.target_value ?? '—'}</Td>
                                                <Td>{item.unit}</Td>
                                                <Td>
                                                        {item.scoring_policy.name}
                                                        {item.frozen && (
                                                                <Badge tone="info" className="ml-2">
                                                                        <Snowflake
                                                                                aria-hidden="true"
                                                                                className="mr-1 size-3"
                                                                        />
                                                                        Frozen
                                                                </Badge>
                                                        )}
                                                        {item.matrix_version && (
                                                                <p className="text-xs text-slate-600">
                                                                        {
                                                                                item.matrix_version
                                                                                        .matrix_code
                                                                        }{' '}
                                                                        version{' '}
                                                                        {
                                                                                item.matrix_version
                                                                                        .version_no
                                                                        }
                                                                </p>
                                                        )}
                                                </Td>
                                                <Td className="hidden lg:table-cell">
                                                        {item.target_note ?? '—'}
                                                </Td>
                                        </tr>
                                ))}
                        </TBody>
                        <tfoot className="border-t border-slate-200 bg-slate-50">
                                <tr>
                                        <th
                                                scope="row"
                                                className="px-4 py-3 text-left text-sm font-semibold"
                                        >
                                                Total
                                        </th>
                                        <td className="px-4 py-3 text-right text-sm font-semibold tabular-nums">
                                                {sheet.total.toFixed(2)}%
                                        </td>
                                        <td colSpan={4} />
                                </tr>
                        </tfoot>
                </Table>
        )
}

function CopyToQuarter({ sheet, quarters }: { sheet: KpiSheet; quarters: Quarter[] }) {
        const navigate = useNavigate()
        const targets = quarters.filter((q) => q.status === 'DRAFT' && q.id !== sheet.quarter.id)
        const [target, setTarget] = useState(targets[0] ? String(targets[0].id) : '')
        const action = useAction()
        if (targets.length === 0) return null

        async function copy() {
                const created = await action.run(() => copySheet(sheet.id, Number(target)))
                if (created) navigate(`/kpi/sheets/${created.id}`)
        }

        return (
                <section aria-labelledby="copy-heading" className={`${cardClasses} space-y-3 p-4`}>
                        <h2 id="copy-heading" className="text-base font-semibold text-slate-900">
                                Use these KPIs for another quarter
                        </h2>
                        <p className="text-sm text-slate-600">
                                Creates a draft sheet for the same assignment in the chosen quarter.
                                Each quarter keeps its own version; later edits do not affect this
                                one.
                        </p>
                        <ActionError error={action.error} title="The sheet could not be copied" />
                        <div className="flex flex-wrap items-end gap-2">
                                <div className="min-w-72">
                                        <SelectField
                                                label="Copy to quarter"
                                                value={target}
                                                onChange={(e) => setTarget(e.target.value)}
                                                options={targets.map((q) => ({
                                                        value: String(q.id),
                                                        label: quarterLabel(q),
                                                }))}
                                        />
                                </div>
                                <Button isLoading={action.busy} onClick={copy}>
                                        Copy as draft
                                </Button>
                        </div>
                </section>
        )
}

function DeviationRequest({
        sheet,
        kpis,
        policies,
        onCancel,
}: {
        sheet: KpiSheet
        kpis: Kpi[]
        policies: ScoringPolicy[]
        onCancel: () => void
}) {
        const navigate = useNavigate()
        const [rows, setRows] = useState<ItemRow[]>(() => rowsFromItems(sheet.items))
        const [reason, setReason] = useState('')
        const [errors, setErrors] = useState<RowErrors[] | null>(null)
        const [attempted, setAttempted] = useState(false)
        const action = useAction()
        const directions = new Map(kpis.map((k) => [k.id, k]))
        const summary = summarizeWeights(rows.map((r) => r.weightage))
        const reasonError =
                attempted && reason.trim().length < 10
                        ? 'Explain the reason (at least 10 characters).'
                        : undefined

        async function submit() {
                setAttempted(true)
                const found = validateRows(rows, directions)
                setErrors(found)
                if (hasRowErrors(found) || !summary.complete || reason.trim().length < 10) return
                const created = await action.run(() =>
                        requestDeviation({
                                sheet_id: sheet.id,
                                reason: reason.trim(),
                                items: rowsToInput(rows, directions),
                        }),
                )
                if (created) navigate(`/kpi/deviations/${created.id}`)
        }

        return (
                <section aria-labelledby="deviation-heading" className="space-y-4">
                        <h2
                                id="deviation-heading"
                                className="flex items-center gap-2 text-lg font-semibold text-slate-900"
                        >
                                <Lock aria-hidden="true" className="size-5" />
                                Request a deviation
                        </h2>
                        <p className="text-sm text-slate-700">
                                Propose the revised KPIs. Nothing changes until both the HR Head and
                                the Plant Head approve; the original and revised versions, the
                                reason, the approvers and the times are kept in the audit trail.
                        </p>
                        <ActionError error={action.error} title="The deviation was not requested" />
                        <ItemsEditor
                                caption="Proposed KPIs"
                                rows={rows}
                                onChange={(next) => {
                                        setRows(next)
                                        if (errors) setErrors(validateRows(next, directions))
                                }}
                                kpis={kpis}
                                policies={policies}
                                errors={errors}
                        />
                        {attempted && !summary.complete && !hasRowErrors(errors ?? []) && (
                                <Alert tone="danger" assertive>
                                        The proposed weightages must total exactly 100%.
                                </Alert>
                        )}
                        <TextAreaField
                                label="Reason for the deviation"
                                hint="At least 10 characters. Shown to both approvers."
                                maxLength={1000}
                                rows={3}
                                value={reason}
                                error={reasonError}
                                onChange={(e) => setReason(e.target.value)}
                        />
                        <div className="flex flex-wrap gap-2">
                                <Button variant="primary" isLoading={action.busy} onClick={submit}>
                                        Submit for approval
                                </Button>
                                <Button variant="ghost" disabled={action.busy} onClick={onCancel}>
                                        Cancel
                                </Button>
                        </div>
                </section>
        )
}
