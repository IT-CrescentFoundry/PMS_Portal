import { Download, FlaskConical, Pencil } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Button } from '../../components/common/Button'
import { TextAreaField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { ReasonForm } from '../../components/common/ReasonForm'
import { buttonClasses, cardClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { saveBlob } from '../../services/apiClient'
import {
        approveMatrixVersion,
        downloadVersionTemplate,
        getMatrix,
        getMatrixVersion,
        listMatrixTypes,
        matrixVersionStep,
        previewMatrixVersion,
        rejectMatrixVersion,
        type MatrixStep,
} from '../../services/matrixApi'
import type {
        MatrixDetail,
        MatrixEvaluation,
        MatrixTypeMeta,
        MatrixVersion,
        UserRef,
} from '../../types/api'
import { formatDate } from '../../utils/format'
import { parseId } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { canReadMatrices } from '../auth/permissions'
import { AccessDenied } from '../auth/RequireAuth'
import { InvalidLink } from '../common/InvalidLink'
import { CheckReport } from './CheckReport'
import { MatrixStatusBadge } from './controls'
import { draftFromDefinition, inputsOf, previewInputs } from './matrixDraft'
import {
        DATA_TYPE_LABELS,
        describeValues,
        effectiveLabel,
        MATRIX_AGGREGATION_LABELS,
        VERSION_SOURCE,
} from './matrixLabels'
import { RuleSummaryTable } from './RuleSummaryTable'
import { InputValues } from './TestCasesEditor'

/** /matrices/:matrixId/versions/:versionId */
export function MatrixVersionPage() {
        const params = useParams()
        const matrixId = parseId(params.matrixId)
        const versionId = parseId(params.versionId)
        const user = useCurrentUser()
        const valid = matrixId !== undefined && versionId !== undefined && canReadMatrices(user)
        const types = useApiQuery(valid ? 'matrix-types' : null, (signal) =>
                listMatrixTypes(signal),
        )
        const matrix = useApiQuery(valid ? `matrix|${matrixId}` : null, (signal) =>
                getMatrix(matrixId!, signal),
        )
        const version = useApiQuery(
                valid ? `matrix-version|${matrixId}|${versionId}` : null,
                (signal) => getMatrixVersion(matrixId!, versionId!, signal),
        )
        if (matrixId === undefined || versionId === undefined)
                return <InvalidLink backTo="/matrices" backLabel="Back to matrices" />
        if (!canReadMatrices(user)) return <AccessDenied />
        const failed = [types, matrix, version].find((q) => q.error !== undefined)
        if (failed) {
                return (
                        <>
                                <PageHeader
                                        title="Matrix version"
                                        breadcrumbs={[
                                                { label: 'Matrices', to: '/matrices' },
                                                { label: 'Version' },
                                        ]}
                                />
                                <ErrorState error={failed.error} onRetry={failed.reload} />
                        </>
                )
        }
        if (!types.data || !matrix.data || !version.data)
                return <LoadingState label="Loading the version…" />
        const meta = types.data.find((t) => t.code === matrix.data!.matrix_type)
        return (
                <VersionView
                        key={version.data.id}
                        meta={meta}
                        matrix={matrix.data}
                        initial={version.data}
                        onMatrixChanged={matrix.reload}
                />
        )
}

function Who({ label, by, at }: { label: string; by: UserRef | null; at: string | null }) {
        if (!at) return null
        return (
                <div>
                        <dt className="text-sm font-medium text-slate-700">{label}</dt>
                        <dd className="text-sm text-slate-900">
                                {by?.username ?? '—'} · {formatDate(at)}
                        </dd>
                </div>
        )
}

function VersionView({
        meta,
        matrix,
        initial,
        onMatrixChanged,
}: {
        meta: MatrixTypeMeta | undefined
        matrix: MatrixDetail
        initial: MatrixVersion
        onMatrixChanged: () => void
}) {
        const [version, setVersion] = useState(initial)
        const [mode, setMode] = useState<'idle' | 'approving' | 'rejecting'>('idle')
        const [note, setNote] = useState('')
        const [done, setDone] = useState<string | null>(null)
        const action = useAction()
        const download = useAction()
        const a = version.actions
        const fields = version.definition.fields

        async function step(name: MatrixStep, message: string) {
                const updated = await action.run(() =>
                        matrixVersionStep(matrix.id, version.id, name),
                )
                if (updated) {
                        setVersion(updated)
                        setDone(message)
                        onMatrixChanged()
                }
        }

        async function approve(event: FormEvent) {
                event.preventDefault()
                const updated = await action.run(() =>
                        approveMatrixVersion(matrix.id, version.id, note.trim() || null),
                )
                if (updated) {
                        setVersion(updated)
                        setMode('idle')
                        setDone('Approved. The HR Head (or you) can now publish it.')
                        onMatrixChanged()
                }
        }

        async function reject(reason: string) {
                const updated = await action.run(() =>
                        rejectMatrixVersion(matrix.id, version.id, reason),
                )
                if (updated) {
                        setVersion(updated)
                        setMode('idle')
                        setDone('Rejected. The reason is recorded on the version.')
                        onMatrixChanged()
                }
        }

        async function handleDownload() {
                const blob = await download.run(() =>
                        downloadVersionTemplate(matrix.id, version.id),
                )
                if (blob) saveBlob(blob, `${matrix.code}-v${version.version_no}.xlsx`)
        }

        const anyAction =
                a.can_edit || a.can_submit || a.can_withdraw || a.can_approve || a.can_publish

        return (
                <>
                        <PageHeader
                                title={`${matrix.name} · version ${version.version_no}`}
                                description={`${matrix.code} · ${matrix.type_name}`}
                                breadcrumbs={[
                                        { label: 'Matrices', to: '/matrices' },
                                        { label: matrix.name, to: `/matrices/${matrix.id}` },
                                        { label: `Version ${version.version_no}` },
                                ]}
                                meta={
                                        <>
                                                <MatrixStatusBadge status={version.status} />
                                                <span className="text-sm text-slate-700">
                                                        {effectiveLabel(version)}
                                                </span>
                                        </>
                                }
                                actions={
                                        <Button isLoading={download.busy} onClick={handleDownload}>
                                                <Download aria-hidden="true" className="size-4" />
                                                Download as Excel
                                        </Button>
                                }
                        />
                        <div className="space-y-4">
                                <ActionError
                                        error={download.error}
                                        title="The workbook could not be downloaded"
                                />
                                {done && <Alert title={done} />}
                                {version.status === 'REJECTED' && (
                                        <Alert
                                                tone="warning"
                                                title={`Rejected by ${version.rejected_by?.username ?? '—'} on ${formatDate(version.rejected_at)}`}
                                        >
                                                {version.rejection_reason}
                                        </Alert>
                                )}
                                {version.status === 'SUBMITTED' && !a.can_approve && (
                                        <Alert title="Awaiting CHRO approval">
                                                The version cannot change while it is under review.
                                                Withdraw it to edit.
                                        </Alert>
                                )}
                                {matrix.policy_note && (
                                        <Alert tone="warning">{matrix.policy_note}</Alert>
                                )}

                                <section
                                        aria-labelledby="workflow-heading"
                                        className={`${cardClasses} space-y-3 p-4`}
                                >
                                        <h2
                                                id="workflow-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Approval trail
                                        </h2>
                                        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                                <Who
                                                        label="Drafted"
                                                        by={version.created_by}
                                                        at={version.created_at}
                                                />
                                                <Who
                                                        label="Submitted"
                                                        by={version.submitted_by}
                                                        at={version.submitted_at}
                                                />
                                                <Who
                                                        label="Approved (CHRO)"
                                                        by={version.approved_by}
                                                        at={version.approved_at}
                                                />
                                                <Who
                                                        label="Rejected"
                                                        by={version.rejected_by}
                                                        at={version.rejected_at}
                                                />
                                                <Who
                                                        label="Published"
                                                        by={version.published_by}
                                                        at={version.published_at}
                                                />
                                                <Who
                                                        label="Superseded"
                                                        by={null}
                                                        at={version.superseded_at}
                                                />
                                        </dl>
                                        {version.approval_note && (
                                                <p className="text-sm text-slate-700">
                                                        <span className="font-medium">
                                                                Approval note:
                                                        </span>{' '}
                                                        {version.approval_note}
                                                </p>
                                        )}
                                        <ActionError
                                                error={action.error}
                                                title="The step was not completed"
                                        />
                                        {anyAction && mode === 'idle' && (
                                                <div className="flex flex-wrap gap-2">
                                                        {a.can_edit && (
                                                                <Link
                                                                        to={`/matrices/${matrix.id}/versions/${version.id}/edit`}
                                                                        className={buttonClasses(
                                                                                'secondary',
                                                                        )}
                                                                >
                                                                        <Pencil
                                                                                aria-hidden="true"
                                                                                className="size-4"
                                                                        />
                                                                        Edit the draft
                                                                </Link>
                                                        )}
                                                        {a.can_submit && (
                                                                <Button
                                                                        variant="primary"
                                                                        isLoading={action.busy}
                                                                        disabled={
                                                                                !version.check
                                                                                        .ready_to_submit
                                                                        }
                                                                        onClick={() =>
                                                                                step(
                                                                                        'submit',
                                                                                        'Submitted for CHRO approval.',
                                                                                )
                                                                        }
                                                                >
                                                                        Submit for approval
                                                                </Button>
                                                        )}
                                                        {a.can_withdraw && (
                                                                <Button
                                                                        isLoading={action.busy}
                                                                        onClick={() =>
                                                                                step(
                                                                                        'withdraw',
                                                                                        'Withdrawn to draft.',
                                                                                )
                                                                        }
                                                                >
                                                                        Withdraw to draft
                                                                </Button>
                                                        )}
                                                        {a.can_approve && (
                                                                <>
                                                                        <Button
                                                                                variant="primary"
                                                                                disabled={
                                                                                        action.busy
                                                                                }
                                                                                onClick={() =>
                                                                                        setMode(
                                                                                                'approving',
                                                                                        )
                                                                                }
                                                                        >
                                                                                Approve…
                                                                        </Button>
                                                                        <Button
                                                                                variant="danger"
                                                                                disabled={
                                                                                        action.busy
                                                                                }
                                                                                onClick={() =>
                                                                                        setMode(
                                                                                                'rejecting',
                                                                                        )
                                                                                }
                                                                        >
                                                                                Reject…
                                                                        </Button>
                                                                </>
                                                        )}
                                                        {a.can_publish && (
                                                                <Button
                                                                        variant="primary"
                                                                        isLoading={action.busy}
                                                                        onClick={() =>
                                                                                step(
                                                                                        'publish',
                                                                                        'Published. Earlier versions keep their history.',
                                                                                )
                                                                        }
                                                                >
                                                                        Publish
                                                                </Button>
                                                        )}
                                                </div>
                                        )}
                                        {a.can_submit && !version.check.ready_to_submit && (
                                                <p className="text-sm text-slate-700">
                                                        Submission needs a clean check, an effective
                                                        date and where the version applies (see
                                                        below).
                                                </p>
                                        )}
                                        {a.can_publish && (
                                                <p className="text-sm text-slate-700">
                                                        Publishing puts the version in force from{' '}
                                                        {formatDate(version.effective_from)}; an
                                                        earlier version in force ends the day
                                                        before. Sheets already published keep the
                                                        version frozen on them.
                                                </p>
                                        )}
                                        {mode === 'approving' && (
                                                <form
                                                        onSubmit={approve}
                                                        className={`${cardClasses} space-y-3 p-4`}
                                                >
                                                        <TextAreaField
                                                                label="Approval note (optional)"
                                                                maxLength={1000}
                                                                value={note}
                                                                onChange={(e) =>
                                                                        setNote(e.target.value)
                                                                }
                                                        />
                                                        <div className="flex flex-wrap gap-2">
                                                                <Button
                                                                        type="submit"
                                                                        variant="primary"
                                                                        isLoading={action.busy}
                                                                >
                                                                        Approve version{' '}
                                                                        {version.version_no}
                                                                </Button>
                                                                <Button
                                                                        variant="ghost"
                                                                        disabled={action.busy}
                                                                        onClick={() =>
                                                                                setMode('idle')
                                                                        }
                                                                >
                                                                        Cancel
                                                                </Button>
                                                        </div>
                                                </form>
                                        )}
                                        {mode === 'rejecting' && (
                                                <ReasonForm
                                                        label="Reason for rejecting"
                                                        hint="The HR Head sees this reason and starts a new revision."
                                                        submitLabel={`Reject version ${version.version_no}`}
                                                        tone="danger"
                                                        busy={action.busy}
                                                        onSubmit={reject}
                                                        onCancel={() => setMode('idle')}
                                                />
                                        )}
                                </section>

                                <section
                                        aria-labelledby="settings-heading"
                                        className={`${cardClasses} space-y-2 p-4`}
                                >
                                        <h2
                                                id="settings-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Settings
                                        </h2>
                                        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                                                <div>
                                                        <dt className="font-medium text-slate-700">
                                                                In force
                                                        </dt>
                                                        <dd>{effectiveLabel(version)}</dd>
                                                </div>
                                                <div>
                                                        <dt className="font-medium text-slate-700">
                                                                Applies to
                                                        </dt>
                                                        <dd>
                                                                {version.applicability
                                                                        .map((s) => s.label)
                                                                        .join('; ') ||
                                                                        'Not chosen yet'}
                                                        </dd>
                                                </div>
                                                <div>
                                                        <dt className="font-medium text-slate-700">
                                                                Source
                                                        </dt>
                                                        <dd>
                                                                {VERSION_SOURCE[version.source]}
                                                                {version.source_file_name &&
                                                                        ` · ${version.source_file_name}`}
                                                                {version.template_version !==
                                                                        null &&
                                                                        ` · template v${version.template_version}`}
                                                        </dd>
                                                </div>
                                                <div>
                                                        <dt className="font-medium text-slate-700">
                                                                Content fingerprint
                                                        </dt>
                                                        <dd className="font-mono text-xs break-all">
                                                                {version.definition_hash.slice(
                                                                        0,
                                                                        16,
                                                                )}
                                                        </dd>
                                                </div>
                                                {version.change_summary && (
                                                        <div className="sm:col-span-2">
                                                                <dt className="font-medium text-slate-700">
                                                                        What changed
                                                                </dt>
                                                                <dd className="whitespace-pre-line">
                                                                        {version.change_summary}
                                                                </dd>
                                                        </div>
                                                )}
                                        </dl>
                                </section>

                                <section aria-labelledby="rules-heading" className="space-y-2">
                                        <h2
                                                id="rules-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Rules
                                        </h2>
                                        <RuleSummaryTable
                                                rules={version.rule_summaries}
                                                fields={fields}
                                        />
                                        <p className="text-sm text-slate-700">
                                                When no rule matches:{' '}
                                                {version.definition.no_match === null
                                                        ? 'not chosen yet'
                                                        : version.definition.no_match.mode ===
                                                            'error'
                                                          ? 'stop with an error (no result)'
                                                          : `default result ${describeValues(fields, version.definition.no_match.outputs ?? {})}`}
                                                .
                                        </p>
                                </section>

                                <section aria-labelledby="fields-heading" className="space-y-2">
                                        <h2
                                                id="fields-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Fields
                                        </h2>
                                        <Table caption="Fields of this version">
                                                <thead>
                                                        <tr>
                                                                <Th>Field</Th>
                                                                <Th>Role</Th>
                                                                <Th>Type</Th>
                                                                <Th>Value comes from</Th>
                                                                <Th>Limits</Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {fields.map((f) => (
                                                                <tr key={f.key}>
                                                                        <Td>
                                                                                <span className="font-medium">
                                                                                        {f.label}
                                                                                </span>{' '}
                                                                                <span className="font-mono text-xs text-slate-600">
                                                                                        {f.key}
                                                                                </span>
                                                                        </Td>
                                                                        <Td>
                                                                                {f.role === 'input'
                                                                                        ? f.required
                                                                                                ? 'Input'
                                                                                                : 'Input (optional)'
                                                                                        : 'Output'}
                                                                        </Td>
                                                                        <Td>
                                                                                {meta
                                                                                        ?.data_type_labels[
                                                                                        f.data_type
                                                                                ] ??
                                                                                        DATA_TYPE_LABELS[
                                                                                                f
                                                                                                        .data_type
                                                                                        ]}
                                                                                {f.unit &&
                                                                                        ` (${f.unit})`}
                                                                        </Td>
                                                                        <Td>
                                                                                {f.source
                                                                                        ? (meta
                                                                                                  ?.source_labels[
                                                                                                  f
                                                                                                          .source
                                                                                          ] ??
                                                                                          f.source)
                                                                                        : '—'}
                                                                                {f.aggregation &&
                                                                                        ` · ${MATRIX_AGGREGATION_LABELS[f.aggregation]}`}
                                                                        </Td>
                                                                        <Td>
                                                                                {f.allowed_values?.join(
                                                                                        ', ',
                                                                                ) ??
                                                                                        ([
                                                                                                f.min &&
                                                                                                        `min ${f.min}`,
                                                                                                f.max &&
                                                                                                        `max ${f.max}`,
                                                                                        ]
                                                                                                .filter(
                                                                                                        Boolean,
                                                                                                )
                                                                                                .join(
                                                                                                        ', ',
                                                                                                ) ||
                                                                                                '—')}
                                                                        </Td>
                                                                </tr>
                                                        ))}
                                                </TBody>
                                        </Table>
                                </section>

                                <div className={`${cardClasses} p-4`}>
                                        <CheckReport
                                                report={version.check}
                                                fields={fields}
                                                headingId="check-heading"
                                                heading="Check"
                                        />
                                </div>

                                {meta && (
                                        <TryVersion
                                                meta={meta}
                                                matrixId={matrix.id}
                                                version={version}
                                        />
                                )}
                        </div>
                </>
        )
}

function TryVersion({
        meta,
        matrixId,
        version,
}: {
        meta: MatrixTypeMeta
        matrixId: number
        version: MatrixVersion
}) {
        const [draft] = useState(() => draftFromDefinition(version.definition, meta).state)
        const [values, setValues] = useState<Record<string, string>>({})
        const [result, setResult] = useState<MatrixEvaluation | null>(null)
        const action = useAction()

        async function handleSubmit(event: FormEvent) {
                event.preventDefault()
                setResult(null)
                const evaluation = await action.run(() =>
                        previewMatrixVersion(matrixId, version.id, previewInputs(draft, values)),
                )
                if (evaluation) setResult(evaluation)
        }

        return (
                <form
                        onSubmit={handleSubmit}
                        aria-labelledby="try-heading"
                        className={`${cardClasses} space-y-3 p-4`}
                >
                        <h2 id="try-heading" className="text-base font-semibold text-slate-900">
                                Try this version
                        </h2>
                        <InputValues
                                fields={inputsOf(draft)}
                                values={values}
                                context="try this version"
                                onChange={(next) => {
                                        setValues(next)
                                        setResult(null)
                                }}
                        />
                        <ActionError error={action.error} title="No result" />
                        <Button type="submit" isLoading={action.busy}>
                                <FlaskConical aria-hidden="true" className="size-4" />
                                Show the result
                        </Button>
                        <div aria-live="polite">
                                {result && (
                                        <Alert
                                                title={`Result: ${describeValues(version.definition.fields, result.outputs)}`}
                                        >
                                                {result.rule
                                                        ? `Rule ${result.rule.priority}${result.rule.label ? ` (${result.rule.label})` : ''}: ${result.rule.description}.`
                                                        : 'No rule matched; the default result applied.'}
                                        </Alert>
                                )}
                        </div>
                </form>
        )
}
