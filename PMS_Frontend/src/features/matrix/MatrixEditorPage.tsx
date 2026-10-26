import { FlaskConical, ListChecks, Save } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Button } from '../../components/common/Button'
import { TextAreaField, TextField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { buttonClasses, cardClasses } from '../../components/common/styles'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import {
        checkDefinition,
        getMatrix,
        getMatrixVersion,
        listMatrixTypes,
        saveMatrixDraft,
} from '../../services/matrixApi'
import { listOrgUnits } from '../../services/organizationApi'
import type {
        MatrixCheckResponse,
        MatrixDetail,
        MatrixField,
        MatrixReport,
        MatrixRuleSummary,
        MatrixTypeMeta,
        MatrixVersion,
        MatrixVersionCheck,
        OrgUnit,
} from '../../types/api'
import { parseId } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { canWriteMatrices } from '../auth/permissions'
import { AccessDenied } from '../auth/RequireAuth'
import { InvalidLink } from '../common/InvalidLink'
import { CheckReport } from './CheckReport'
import { MatrixStatusBadge } from './controls'
import { FieldsEditor } from './FieldsEditor'
import { SettingsEditor } from './SettingsEditor'
import {
        definitionFromDraft,
        draftFromDefinition,
        inputsOf,
        previewInputs,
        type MatrixDraftState,
} from './matrixDraft'
import { describeValues } from './matrixLabels'
import { RulesEditor } from './RulesEditor'
import { RuleSummaryTable } from './RuleSummaryTable'
import { ScopeRows } from './ScopeRows'
import { COMPANY_WIDE, scopeInputs, scopeRowsFrom, type ScopeRow } from './scopes'
import { InputValues, TestCasesEditor } from './TestCasesEditor'

/** /matrices/:matrixId/versions/:versionId/edit */
export function MatrixEditorPage() {
        const params = useParams()
        const matrixId = parseId(params.matrixId)
        const versionId = parseId(params.versionId)
        const user = useCurrentUser()
        const valid = matrixId !== undefined && versionId !== undefined
        const types = useApiQuery(valid ? 'matrix-types' : null, (signal) =>
                listMatrixTypes(signal),
        )
        const units = useApiQuery(valid ? 'org-units' : null, (signal) => listOrgUnits({}, signal))
        const matrix = useApiQuery(valid ? `matrix|${matrixId}` : null, (signal) =>
                getMatrix(matrixId!, signal),
        )
        const version = useApiQuery(
                valid ? `matrix-version|${matrixId}|${versionId}` : null,
                (signal) => getMatrixVersion(matrixId!, versionId!, signal),
        )
        if (!valid) return <InvalidLink backTo="/matrices" backLabel="Back to matrices" />
        if (!canWriteMatrices(user)) return <AccessDenied />
        const failed = [types, units, matrix, version].find((q) => q.error !== undefined)
        if (failed) return <ErrorState error={failed.error} onRetry={failed.reload} />
        if (!types.data || !units.data || !matrix.data || !version.data)
                return <LoadingState label="Loading the draft…" />
        const meta = types.data.find((t) => t.code === matrix.data!.matrix_type)
        const versionPath = `/matrices/${matrixId}/versions/${versionId}`
        if (!meta || !version.data.actions.can_edit) {
                return (
                        <>
                                <PageHeader title="This version cannot be edited" />
                                <Alert
                                        tone="warning"
                                        title="Only a draft can be edited"
                                        action={
                                                <Link
                                                        to={versionPath}
                                                        className={buttonClasses('secondary', 'sm')}
                                                >
                                                        Open the version
                                                </Link>
                                        }
                                >
                                        Submitted, approved and published versions never change. To
                                        change the rules, start a new revision from the matrix page.
                                </Alert>
                        </>
                )
        }
        return (
                <MatrixEditor
                        key={version.data.id}
                        meta={meta}
                        matrix={matrix.data}
                        version={version.data}
                        units={units.data}
                />
        )
}

interface Verdict {
        check: MatrixReport | MatrixVersionCheck
        rules: MatrixRuleSummary[]
        fields: MatrixField[]
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
        return (
                <section aria-labelledby={id} className={`${cardClasses} space-y-4 p-4`}>
                        <h2 id={id} className="text-lg font-semibold text-slate-900">
                                {title}
                        </h2>
                        {children}
                </section>
        )
}

function MatrixEditor({
        meta,
        matrix,
        version,
        units,
}: {
        meta: MatrixTypeMeta
        matrix: MatrixDetail
        version: MatrixVersion
        units: OrgUnit[]
}) {
        const [loaded] = useState(() => draftFromDefinition(version.definition, meta))
        const [draft, setDraft] = useState<MatrixDraftState>(loaded.state)
        const [effectiveFrom, setEffectiveFrom] = useState(version.effective_from ?? '')
        const [effectiveTo, setEffectiveTo] = useState(version.effective_to ?? '')
        const [scopes, setScopes] = useState<ScopeRow[]>(() =>
                version.applicability.length > 0
                        ? scopeRowsFrom(version.applicability)
                        : [{ ...COMPANY_WIDE }],
        )
        const [changeSummary, setChangeSummary] = useState(version.change_summary ?? '')
        const [verdict, setVerdict] = useState<Verdict>({
                check: version.check,
                rules: version.rule_summaries,
                fields: version.definition.fields,
        })
        const [saved, setSaved] = useState<MatrixVersion | null>(null)
        const [dirty, setDirty] = useState(false)
        const [tryValues, setTryValues] = useState<Record<string, string>>({})
        const [tried, setTried] = useState<MatrixCheckResponse | null>(null)
        const check = useAction()
        const save = useAction()
        const preview = useAction()
        const versionPath = `/matrices/${matrix.id}/versions/${version.id}`

        function change(next: MatrixDraftState) {
                setDraft(next)
                setDirty(true)
                setSaved(null)
                setTried(null)
        }

        function touched<T>(setter: (value: T) => void) {
                return (value: T) => {
                        setter(value)
                        setDirty(true)
                        setSaved(null)
                }
        }

        async function handleCheck() {
                const definition = definitionFromDraft(draft)
                const result = await check.run(() =>
                        checkDefinition(meta.code, { definition, attributes: matrix.attributes }),
                )
                if (result)
                        setVerdict({
                                check: result.check,
                                rules: result.rule_summaries,
                                fields: definition.fields,
                        })
        }

        async function handleSave(event: FormEvent) {
                event.preventDefault()
                const result = await save.run(() =>
                        saveMatrixDraft(matrix.id, version.id, {
                                definition: definitionFromDraft(draft),
                                effective_from: effectiveFrom || null,
                                effective_to: effectiveTo || null,
                                applicability: scopeInputs(scopes),
                                change_summary: changeSummary.trim() || null,
                        }),
                )
                if (!result) return
                setSaved(result)
                setDirty(false)
                setVerdict({
                        check: result.check,
                        rules: result.rule_summaries,
                        fields: result.definition.fields,
                })
        }

        async function handlePreview(event: FormEvent) {
                event.preventDefault()
                const definition = definitionFromDraft(draft)
                const result = await preview.run(() =>
                        checkDefinition(meta.code, {
                                definition,
                                attributes: matrix.attributes,
                                inputs: previewInputs(draft, tryValues),
                        }),
                )
                if (result) setTried(result)
        }

        const title = `${matrix.name} · version ${version.version_no}`
        const definitionFields = definitionFromDraft(draft).fields

        return (
                <>
                        <PageHeader
                                title={`Edit ${title}`}
                                description={`${matrix.code} · ${matrix.type_name}. Drafts can be saved with problems; submission needs a clean check, an effective date and where the version applies.`}
                                breadcrumbs={[
                                        { label: 'Matrices', to: '/matrices' },
                                        { label: matrix.name, to: `/matrices/${matrix.id}` },
                                        { label: `Version ${version.version_no}`, to: versionPath },
                                        { label: 'Edit' },
                                ]}
                                meta={
                                        <>
                                                <MatrixStatusBadge status={version.status} />
                                                {dirty && (
                                                        <span className="text-sm font-medium text-amber-900">
                                                                Unsaved changes
                                                        </span>
                                                )}
                                        </>
                                }
                        />
                        <form onSubmit={handleSave} noValidate className="space-y-6">
                                {loaded.dropped.length > 0 && (
                                        <Alert
                                                tone="warning"
                                                title="Some saved content refers to unknown fields"
                                        >
                                                <ul className="list-disc pl-5">
                                                        {loaded.dropped.map((message) => (
                                                                <li key={message}>{message}</li>
                                                        ))}
                                                </ul>
                                                <p>
                                                        It is not shown here and is removed when you
                                                        save.
                                                </p>
                                        </Alert>
                                )}

                                <Section id="settings-heading" title="1. Version settings">
                                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                                <TextField
                                                        label="Effective from"
                                                        type="date"
                                                        hint="Needed before submitting."
                                                        value={effectiveFrom}
                                                        onChange={(e) =>
                                                                touched(setEffectiveFrom)(
                                                                        e.target.value,
                                                                )
                                                        }
                                                />
                                                <TextField
                                                        label="Effective to (optional)"
                                                        type="date"
                                                        hint="Leave empty while the version stays in force."
                                                        value={effectiveTo}
                                                        onChange={(e) =>
                                                                touched(setEffectiveTo)(
                                                                        e.target.value,
                                                                )
                                                        }
                                                />
                                        </div>
                                        <p className="text-sm text-slate-700">
                                                {meta.selection === 'REFERENCE'
                                                        ? 'KPIs choose this matrix through their scoring policy; when a KPI sheet is published, the version in force on the quarter’s start date is frozen on it.'
                                                        : 'At scoring time the published version in force for the unit and date is used, so versions of this type may not overlap.'}
                                        </p>
                                        <h3 className="text-base font-semibold text-slate-900">
                                                Applies to
                                        </h3>
                                        <ScopeRows
                                                rows={scopes}
                                                units={units}
                                                onChange={touched(setScopes)}
                                        />
                                        <TextAreaField
                                                label="What changed in this version (optional)"
                                                maxLength={1000}
                                                value={changeSummary}
                                                onChange={(e) =>
                                                        touched(setChangeSummary)(e.target.value)
                                                }
                                        />
                                </Section>

                                {meta.settings && draft.settings && (
                                        <Section id="policy-heading" title="Normalization settings">
                                                <SettingsEditor
                                                        options={meta.settings}
                                                        state={draft}
                                                        onChange={change}
                                                />
                                        </Section>
                                )}

                                <Section id="fields-heading" title="2. Fields">
                                        <FieldsEditor meta={meta} state={draft} onChange={change} />
                                </Section>

                                <Section id="rules-heading" title="3. Rules">
                                        <RulesEditor meta={meta} state={draft} onChange={change} />
                                </Section>

                                <Section id="tests-heading" title="4. Test cases">
                                        <TestCasesEditor state={draft} onChange={change} />
                                </Section>

                                <Section id="check-heading" title="5. Check">
                                        <p className="text-sm text-slate-700">
                                                Checks overlaps, gaps, boundaries, duplicate
                                                priorities, invalid values and the test cases.
                                                Nothing is saved.
                                        </p>
                                        <ActionError
                                                error={check.error}
                                                title="The check could not run"
                                        />
                                        <Button isLoading={check.busy} onClick={handleCheck}>
                                                <ListChecks aria-hidden="true" className="size-4" />
                                                Check the rules
                                        </Button>
                                        <CheckReport
                                                report={verdict.check}
                                                fields={verdict.fields}
                                                headingId="verdict-heading"
                                                heading={
                                                        dirty
                                                                ? 'Last check (before your latest changes)'
                                                                : 'Check results'
                                                }
                                        />
                                        <RuleSummaryTable
                                                rules={verdict.rules}
                                                fields={verdict.fields}
                                        />
                                </Section>

                                <ActionError error={save.error} title="The draft was not saved" />
                                {saved && (
                                        <Alert
                                                title="Draft saved"
                                                action={
                                                        <Link
                                                                to={versionPath}
                                                                className={buttonClasses(
                                                                        'secondary',
                                                                        'sm',
                                                                )}
                                                        >
                                                                {saved.check.ready_to_submit
                                                                        ? 'Review and submit for approval'
                                                                        : 'Open the version'}
                                                        </Link>
                                                }
                                        >
                                                {saved.check.ready_to_submit
                                                        ? 'The version is ready to submit to the CHRO.'
                                                        : 'Fix the problems listed in the check before submitting.'}
                                        </Alert>
                                )}
                                <div className="flex flex-wrap gap-2">
                                        <Button
                                                type="submit"
                                                variant="primary"
                                                isLoading={save.busy}
                                        >
                                                <Save aria-hidden="true" className="size-4" />
                                                Save draft
                                        </Button>
                                        <Link to={versionPath} className={buttonClasses('ghost')}>
                                                Back to the version
                                        </Link>
                                </div>
                        </form>

                        <form
                                onSubmit={handlePreview}
                                aria-labelledby="try-heading"
                                className={`${cardClasses} mt-6 space-y-4 p-4`}
                        >
                                <h2
                                        id="try-heading"
                                        className="text-lg font-semibold text-slate-900"
                                >
                                        6. Try it
                                </h2>
                                <p className="text-sm text-slate-700">
                                        Enter input values to see which rule applies to the current
                                        (unsaved) rules.
                                </p>
                                <InputValues
                                        fields={inputsOf(draft)}
                                        values={tryValues}
                                        context="try it"
                                        onChange={(values) => {
                                                setTryValues(values)
                                                setTried(null)
                                        }}
                                />
                                <ActionError
                                        error={preview.error}
                                        title="The preview could not run"
                                />
                                <Button type="submit" isLoading={preview.busy}>
                                        <FlaskConical aria-hidden="true" className="size-4" />
                                        Show the result
                                </Button>
                                <div aria-live="polite">
                                        {tried?.preview_error && (
                                                <Alert tone="warning" title="No result">
                                                        {tried.preview_error}
                                                </Alert>
                                        )}
                                        {tried?.preview && (
                                                <Alert
                                                        title={`Result: ${describeValues(definitionFields, tried.preview.outputs)}`}
                                                >
                                                        {tried.preview.rule
                                                                ? `Rule ${tried.preview.rule.priority}${tried.preview.rule.label ? ` (${tried.preview.rule.label})` : ''}: ${tried.preview.rule.description}.`
                                                                : 'No rule matched; the default result applied.'}
                                                </Alert>
                                        )}
                                </div>
                        </form>
                </>
        )
}
