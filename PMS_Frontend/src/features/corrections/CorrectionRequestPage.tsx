import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Button } from '../../components/common/Button'
import { SelectField, TextAreaField, TextField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { cardClasses } from '../../components/common/styles'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { previewCorrection, requestCorrection } from '../../services/correctionsApi'
import { listQuarters } from '../../services/kpiApi'
import { listEmployeeResults } from '../../services/quarterlyApi'
import { getResult, listResults } from '../../services/scoresApi'
import type {
        CorrectionPreview,
        CorrectionRequest,
        EmployeeResult,
        Quarter,
        ResultRow,
} from '../../types/api'
import { unitLabel } from '../../utils/labels'
import { parseId } from '../../utils/params'
import { InvalidLink } from '../common/InvalidLink'
import { monthLabel } from '../scores/scoreLabels'
import { CorrectionImpact } from './CorrectionImpact'

interface ValueDraft {
        uid: number
        sheetId: string
        kpiId: string
        period: string
        actual: string
}

interface WeightsDraft {
        uid: number
        employeeId: string
        weights: Record<number, string>
}

let nextUid = 1
const newValue = (): ValueDraft => ({
        uid: nextUid++,
        sheetId: '',
        kpiId: '',
        period: '',
        actual: '',
})

/** /scores/corrections/new?quarter=ID */
export function CorrectionRequestPage() {
        const [params] = useSearchParams()
        const quarterId = parseId(params.get('quarter'))
        const quarters = useApiQuery('quarters', (signal) => listQuarters(signal))
        if (quarterId === undefined)
                return (
                        <InvalidLink
                                backTo="/scores/quarter"
                                backLabel="Back to the quarter overview"
                        />
                )
        if (quarters.isLoading) return <LoadingState label="Loading the quarter…" />
        if (quarters.error !== undefined || !quarters.data)
                return <ErrorState error={quarters.error} onRetry={quarters.reload} />
        const quarter = quarters.data.find((q) => q.id === quarterId)
        if (!quarter)
                return (
                        <InvalidLink
                                backTo="/scores/quarter"
                                backLabel="Back to the quarter overview"
                        />
                )
        return <RequestForm quarter={quarter} />
}

function RequestForm({ quarter }: { quarter: Quarter }) {
        const navigate = useNavigate()
        const results = useApiQuery(`results|${quarter.id}|`, (signal) =>
                listResults({ quarterId: quarter.id }, signal),
        )
        const employees = useApiQuery(`employee-results|${quarter.id}|`, (signal) =>
                listEmployeeResults({ quarterId: quarter.id }, signal),
        )
        const [values, setValues] = useState<ValueDraft[]>(() => [newValue()])
        const [weights, setWeights] = useState<WeightsDraft[]>([])
        const [reason, setReason] = useState('')
        const [preview, setPreview] = useState<CorrectionPreview | null>(null)
        const [checked, setChecked] = useState<string | null>(null)
        const check = useAction()
        const submit = useAction()

        const header = (
                <PageHeader
                        title={`Request a correction of ${quarter.name}`}
                        description="The published quarter is not changed. The CHRO approves or rejects the request; an approved correction becomes a new version that is reviewed, normalized and published again before it is current."
                        breadcrumbs={[
                                {
                                        label: 'Quarter overview',
                                        to: `/scores/quarter?quarter=${quarter.id}`,
                                },
                                { label: 'Request a correction' },
                        ]}
                />
        )
        if (quarter.status !== 'PUBLISHED') {
                return (
                        <>
                                {header}
                                <Alert
                                        tone="warning"
                                        title="Only a published quarter is corrected this way"
                                >
                                        {quarter.name} is still in its review steps; return it to
                                        data collection to change its data.
                                </Alert>
                        </>
                )
        }
        if ((results.isLoading && !results.data) || (employees.isLoading && !employees.data))
                return (
                        <>
                                {header}
                                <LoadingState label="Loading the quarter’s results…" />
                        </>
                )
        if (!results.data || !employees.data)
                return (
                        <>
                                {header}
                                <ErrorState
                                        error={results.error ?? employees.error}
                                        onRetry={() => {
                                                results.reload()
                                                employees.reload()
                                        }}
                                />
                        </>
                )

        const sheets = results.data.rows.filter((r) => r.sheet.status === 'LOCKED')
        const multi = employees.data.filter((e) => e.components.length > 1)
        const body: CorrectionRequest = {
                reason: reason.trim(),
                values: values
                        .filter((v) => v.sheetId && v.kpiId && v.period)
                        .map((v) => ({
                                sheet_id: Number(v.sheetId),
                                kpi_definition_id: Number(v.kpiId),
                                period: v.period,
                                actual: v.actual.trim() || null,
                        })),
                weights: weights
                        .filter((w) => w.employeeId)
                        .map((w) => ({
                                employee_id: Number(w.employeeId),
                                weights: Object.entries(w.weights).map(([id, weight]) => ({
                                        assignment_id: Number(id),
                                        weight: weight.trim(),
                                })),
                        })),
        }
        const key = JSON.stringify({ values: body.values, weights: body.weights })
        const current = checked === key && preview !== null

        async function handleCheck() {
                const result = await check.run(() => previewCorrection(quarter.id, body))
                if (result) {
                        setPreview(result)
                        setChecked(key)
                }
        }

        async function handleSubmit() {
                const created = await submit.run(() => requestCorrection(quarter.id, body))
                if (created) navigate(`/scores/corrections/${created.id}`)
        }

        return (
                <>
                        {header}
                        <div className="space-y-4">
                                <section
                                        aria-labelledby="values-heading"
                                        className={`${cardClasses} space-y-3 p-4`}
                                >
                                        <h2
                                                id="values-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Corrected monthly values
                                        </h2>
                                        <p className="text-sm text-slate-700">
                                                Each change replaces one month’s value of one KPI
                                                for this version only; the stored value is kept,
                                                with the matrix version frozen on the sheet.
                                        </p>
                                        {values.map((v, index) => (
                                                <ValueRow
                                                        key={v.uid}
                                                        number={index + 1}
                                                        draft={v}
                                                        sheets={sheets}
                                                        onChange={(next) =>
                                                                setValues(
                                                                        values.map((x) =>
                                                                                x.uid === v.uid
                                                                                        ? next
                                                                                        : x,
                                                                        ),
                                                                )
                                                        }
                                                        onRemove={() =>
                                                                setValues(
                                                                        values.filter(
                                                                                (x) =>
                                                                                        x.uid !==
                                                                                        v.uid,
                                                                        ),
                                                                )
                                                        }
                                                />
                                        ))}
                                        <Button
                                                size="sm"
                                                onClick={() => setValues([...values, newValue()])}
                                        >
                                                <Plus aria-hidden="true" className="size-4" />
                                                Add a value change
                                        </Button>
                                </section>

                                {multi.length > 0 && (
                                        <section
                                                aria-labelledby="weights-heading"
                                                className={`${cardClasses} space-y-3 p-4`}
                                        >
                                                <h2
                                                        id="weights-heading"
                                                        className="text-base font-semibold text-slate-900"
                                                >
                                                        Corrected contribution weights
                                                </h2>
                                                {weights.map((w, index) => (
                                                        <WeightsRow
                                                                key={w.uid}
                                                                number={index + 1}
                                                                draft={w}
                                                                employees={multi}
                                                                onChange={(next) =>
                                                                        setWeights(
                                                                                weights.map((x) =>
                                                                                        x.uid ===
                                                                                        w.uid
                                                                                                ? next
                                                                                                : x,
                                                                                ),
                                                                        )
                                                                }
                                                                onRemove={() =>
                                                                        setWeights(
                                                                                weights.filter(
                                                                                        (x) =>
                                                                                                x.uid !==
                                                                                                w.uid,
                                                                                ),
                                                                        )
                                                                }
                                                        />
                                                ))}
                                                <Button
                                                        size="sm"
                                                        onClick={() =>
                                                                setWeights([
                                                                        ...weights,
                                                                        {
                                                                                uid: nextUid++,
                                                                                employeeId: '',
                                                                                weights: {},
                                                                        },
                                                                ])
                                                        }
                                                >
                                                        <Plus
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        Add a weights change
                                                </Button>
                                        </section>
                                )}

                                <section
                                        aria-labelledby="reason-heading"
                                        className={`${cardClasses} space-y-3 p-4`}
                                >
                                        <h2
                                                id="reason-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Reason and check
                                        </h2>
                                        <TextAreaField
                                                label="Reason for the correction"
                                                hint="At least 10 characters; the CHRO sees it with the request."
                                                maxLength={2000}
                                                value={reason}
                                                onChange={(e) => setReason(e.target.value)}
                                        />
                                        <ActionError
                                                error={check.error}
                                                title="The correction can’t be made as entered"
                                        />
                                        <div className="flex flex-wrap gap-2">
                                                <Button
                                                        isLoading={check.busy}
                                                        onClick={handleCheck}
                                                >
                                                        Check the correction
                                                </Button>
                                                <Button
                                                        variant="primary"
                                                        isLoading={submit.busy}
                                                        disabled={
                                                                !current ||
                                                                reason.trim().length < 10
                                                        }
                                                        onClick={handleSubmit}
                                                >
                                                        Submit for CHRO approval
                                                </Button>
                                        </div>
                                        {preview && !current && (
                                                <p className="text-sm text-amber-900">
                                                        The changes were edited since the check;
                                                        check again.
                                                </p>
                                        )}
                                        <ActionError
                                                error={submit.error}
                                                title="The correction was not requested"
                                        />
                                </section>

                                {preview && current && (
                                        <section
                                                aria-labelledby="effect-heading"
                                                className="space-y-2"
                                        >
                                                <h2
                                                        id="effect-heading"
                                                        className="text-base font-semibold text-slate-900"
                                                >
                                                        Projected effect
                                                </h2>
                                                {preview.problems.length > 0 && (
                                                        <Alert
                                                                tone="warning"
                                                                title="The corrected results would not be complete"
                                                        >
                                                                <ul className="list-disc space-y-0.5 pl-5">
                                                                        {preview.problems.map(
                                                                                (p) => (
                                                                                        <li key={p}>
                                                                                                {p}
                                                                                        </li>
                                                                                ),
                                                                        )}
                                                                </ul>
                                                        </Alert>
                                                )}
                                                <CorrectionImpact
                                                        changes={null}
                                                        preview={preview}
                                                        affected={null}
                                                />
                                        </section>
                                )}
                        </div>
                </>
        )
}

function ValueRow({
        number,
        draft,
        sheets,
        onChange,
        onRemove,
}: {
        number: number
        draft: ValueDraft
        sheets: ResultRow[]
        onChange: (next: ValueDraft) => void
        onRemove: () => void
}) {
        const sheetId = parseId(draft.sheetId)
        const detail = useApiQuery(sheetId === undefined ? null : `result|${sheetId}`, (signal) =>
                getResult(sheetId!, signal),
        )
        const items = detail.data?.items ?? []
        const item = items.find((i) => String(i.kpi_id) === draft.kpiId)
        const stored = item?.monthly.find((m) => m.month === draft.period)
        return (
                <fieldset className="grid grid-cols-1 items-end gap-3 rounded-md border border-slate-200 p-3 md:grid-cols-[2fr_2fr_1fr_1fr_auto]">
                        <legend className="px-1 text-sm font-medium text-slate-800">
                                Change {number}
                        </legend>
                        <SelectField
                                label={`Employee and assignment (change ${number})`}
                                value={draft.sheetId}
                                onChange={(e) =>
                                        onChange({
                                                ...draft,
                                                sheetId: e.target.value,
                                                kpiId: '',
                                                period: '',
                                        })
                                }
                                options={[
                                        { value: '', label: 'Choose…' },
                                        ...sheets.map((r) => ({
                                                value: String(r.sheet.id),
                                                label: `${r.assignment.employee.employee_code} ${r.assignment.employee.full_name} · ${unitLabel(r.assignment.department, r.assignment.plant)}`,
                                        })),
                                ]}
                        />
                        <SelectField
                                label={`KPI (change ${number})`}
                                value={draft.kpiId}
                                disabled={!items.length}
                                onChange={(e) =>
                                        onChange({ ...draft, kpiId: e.target.value, period: '' })
                                }
                                options={[
                                        { value: '', label: 'Choose…' },
                                        ...items.map((i) => ({
                                                value: String(i.kpi_id),
                                                label: `${i.kpi_code} ${i.kpi_name}`,
                                        })),
                                ]}
                        />
                        <SelectField
                                label={`Month (change ${number})`}
                                value={draft.period}
                                disabled={!item}
                                onChange={(e) => onChange({ ...draft, period: e.target.value })}
                                options={[
                                        { value: '', label: 'Choose…' },
                                        ...(item?.months_expected ?? []).map((m) => ({
                                                value: m,
                                                label: monthLabel(m),
                                        })),
                                ]}
                        />
                        <TextField
                                label={`Corrected value (change ${number})`}
                                hint={
                                        draft.period
                                                ? `Published: ${stored?.actual ?? 'no value'}${item ? ` ${item.unit}` : ''}`
                                                : undefined
                                }
                                inputMode="decimal"
                                value={draft.actual}
                                onChange={(e) => onChange({ ...draft, actual: e.target.value })}
                        />
                        <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Remove change ${number}`}
                                onClick={onRemove}
                        >
                                <Trash2 aria-hidden="true" className="size-4" />
                        </Button>
                </fieldset>
        )
}

function WeightsRow({
        number,
        draft,
        employees,
        onChange,
        onRemove,
}: {
        number: number
        draft: WeightsDraft
        employees: EmployeeResult[]
        onChange: (next: WeightsDraft) => void
        onRemove: () => void
}) {
        const chosen = employees.find((e) => String(e.employee.id) === draft.employeeId)
        return (
                <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
                        <legend className="px-1 text-sm font-medium text-slate-800">
                                Weights change {number}
                        </legend>
                        <div className="flex flex-wrap items-end gap-3">
                                <div className="min-w-64 flex-1">
                                        <SelectField
                                                label={`Employee (weights change ${number})`}
                                                value={draft.employeeId}
                                                onChange={(e) => {
                                                        const next = employees.find(
                                                                (x) =>
                                                                        String(x.employee.id) ===
                                                                        e.target.value,
                                                        )
                                                        onChange({
                                                                ...draft,
                                                                employeeId: e.target.value,
                                                                weights: Object.fromEntries(
                                                                        (
                                                                                next?.components ??
                                                                                []
                                                                        ).map((c) => [
                                                                                c.assignment_id,
                                                                                c.weight ?? '',
                                                                        ]),
                                                                ),
                                                        })
                                                }}
                                                options={[
                                                        { value: '', label: 'Choose…' },
                                                        ...employees.map((e) => ({
                                                                value: String(e.employee.id),
                                                                label: `${e.employee.employee_code} ${e.employee.full_name}`,
                                                        })),
                                                ]}
                                        />
                                </div>
                                <Button
                                        variant="ghost"
                                        size="sm"
                                        aria-label={`Remove weights change ${number}`}
                                        onClick={onRemove}
                                >
                                        <Trash2 aria-hidden="true" className="size-4" />
                                </Button>
                        </div>
                        {chosen && (
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                        {chosen.components.map((c) => (
                                                <TextField
                                                        key={c.assignment_id}
                                                        label={`Weight % for ${unitLabel(c.department, c.plant)} (weights change ${number})`}
                                                        hint={`Published: ${c.weight ?? '—'} %`}
                                                        inputMode="decimal"
                                                        value={draft.weights[c.assignment_id] ?? ''}
                                                        onChange={(e) =>
                                                                onChange({
                                                                        ...draft,
                                                                        weights: {
                                                                                ...draft.weights,
                                                                                [c.assignment_id]:
                                                                                        e.target
                                                                                                .value,
                                                                        },
                                                                })
                                                        }
                                                />
                                        ))}
                                </div>
                        )}
                </fieldset>
        )
}
