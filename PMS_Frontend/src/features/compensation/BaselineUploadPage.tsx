import { Download, FileSpreadsheet } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { PageHeader } from '../../components/common/PageHeader'
import { ErrorState, LoadingState } from '../../components/common/QueryStates'
import { buttonClasses, cardClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { saveBlob } from '../../services/apiClient'
import {
        confirmBaseline,
        downloadBaselineTemplate,
        getCompensationCycle,
        previewBaseline,
} from '../../services/compensationApi'
import type { BaselinePreview, BaselineSummary, CompensationCycleDetail } from '../../types/api'
import { plural } from '../../utils/format'
import { parseId } from '../../utils/params'
import { AccessDenied } from '../auth/RequireAuth'
import { InvalidLink } from '../common/InvalidLink'
import { money } from './compensationLabels'

const MAX_BYTES = 2_000_000

/** /compensation/cycles/:cycleId/baseline */
export function BaselineUploadPage() {
        const cycleId = parseId(useParams().cycleId)
        const query = useApiQuery(
                cycleId === undefined ? null : `compensation-cycle|${cycleId}`,
                (signal) => getCompensationCycle(cycleId!, signal),
        )
        if (cycleId === undefined)
                return <InvalidLink backTo="/compensation" backLabel="Back to compensation" />
        if (query.isLoading) return <LoadingState label="Loading the compensation cycle…" />
        if (query.error !== undefined || !query.data)
                return <ErrorState error={query.error} onRetry={query.reload} />
        if (!query.data.actions.can_manage || query.data.status !== 'OPEN') return <AccessDenied />
        return <Uploader cycle={query.data} />
}

function Uploader({ cycle }: { cycle: CompensationCycleDetail }) {
        const [file, setFile] = useState<File | null>(null)
        const [fileError, setFileError] = useState<string | null>(null)
        const [preview, setPreview] = useState<BaselinePreview | null>(null)
        const [saved, setSaved] = useState<BaselineSummary | null>(null)
        const [inputKey, setInputKey] = useState(0)
        const template = useAction()
        const check = useAction()
        const save = useAction()

        function chooseFile(chosen: File | null) {
                setPreview(null)
                setSaved(null)
                check.clearError()
                save.clearError()
                setFile(chosen)
                const name = chosen?.name.toLowerCase() ?? ''
                if (chosen === null) setFileError(null)
                else if (!name.endsWith('.xlsx') && !name.endsWith('.csv'))
                        setFileError('Choose an Excel workbook (.xlsx) or a CSV file.')
                else if (chosen.size > MAX_BYTES) setFileError('The file is larger than 2 MB.')
                else setFileError(null)
        }

        async function handleTemplate() {
                const blob = await template.run(() => downloadBaselineTemplate(cycle.id))
                if (blob) saveBlob(blob, `${cycle.code.toLowerCase()}-salary-baseline.xlsx`)
        }

        async function handleCheck(event: FormEvent) {
                event.preventDefault()
                if (!file || fileError) {
                        setFileError(fileError ?? 'Choose the file to check.')
                        return
                }
                setPreview(null)
                setSaved(null)
                const result = await check.run(() => previewBaseline(cycle.id, file))
                if (result) setPreview(result)
        }

        async function handleConfirm() {
                if (!file) return
                const result = await save.run(() => confirmBaseline(cycle.id, file))
                if (result) {
                        setSaved(result)
                        setPreview(null)
                        setFile(null)
                        setInputKey((k) => k + 1)
                }
        }

        return (
                <>
                        <PageHeader
                                title="Import a salary baseline"
                                description={`Current and reference salaries for ${cycle.name}. Each import becomes a new baseline version; earlier versions and the scenarios calculated from them are kept unchanged. Salary amounts are visible only to compensation roles and are never written to the audit trail.`}
                                breadcrumbs={[
                                        { label: 'Compensation & budget', to: '/compensation' },
                                        {
                                                label: cycle.name,
                                                to: `/compensation/cycles/${cycle.id}`,
                                        },
                                        { label: 'Salary baseline' },
                                ]}
                        />
                        <div className="space-y-4">
                                <section
                                        aria-labelledby="template-heading"
                                        className={`${cardClasses} space-y-3 p-4`}
                                >
                                        <h2
                                                id="template-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                1. Get the template
                                        </h2>
                                        <p className="text-sm text-slate-700">
                                                Columns: Employee Code, Current Salary (annual),
                                                Reference Salary ({cycle.reference_label}), Grade
                                                (optional), Eligible (Yes/No) and Exclusion Reason
                                                (required when not eligible). One row per employee;
                                                an employee working in several plants appears once.
                                        </p>
                                        <Button isLoading={template.busy} onClick={handleTemplate}>
                                                <Download aria-hidden="true" className="size-4" />
                                                Download the template
                                        </Button>
                                        <ActionError
                                                error={template.error}
                                                title="The template could not be downloaded"
                                        />
                                </section>

                                <form
                                        onSubmit={handleCheck}
                                        aria-labelledby="file-heading"
                                        className={`${cardClasses} space-y-3 p-4`}
                                >
                                        <h2
                                                id="file-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                2. Check the file
                                        </h2>
                                        <div className="space-y-1">
                                                <label
                                                        htmlFor="baseline-file"
                                                        className="block text-sm font-medium text-slate-800"
                                                >
                                                        Salary baseline (.xlsx or .csv, up to 2 MB)
                                                </label>
                                                <input
                                                        key={inputKey}
                                                        id="baseline-file"
                                                        type="file"
                                                        accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                                                        aria-invalid={fileError ? true : undefined}
                                                        aria-describedby={
                                                                fileError
                                                                        ? 'baseline-file-error'
                                                                        : undefined
                                                        }
                                                        className="block w-full text-sm text-slate-800 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium"
                                                        onChange={(e) =>
                                                                chooseFile(
                                                                        e.target.files?.[0] ?? null,
                                                                )
                                                        }
                                                />
                                                {fileError && (
                                                        <p
                                                                id="baseline-file-error"
                                                                className="text-xs font-medium text-red-700"
                                                        >
                                                                {fileError}
                                                        </p>
                                                )}
                                        </div>
                                        <ActionError
                                                error={check.error}
                                                title="The file could not be checked"
                                        />
                                        <Button
                                                type="submit"
                                                variant="primary"
                                                isLoading={check.busy}
                                        >
                                                <FileSpreadsheet
                                                        aria-hidden="true"
                                                        className="size-4"
                                                />
                                                Check the file
                                        </Button>
                                </form>

                                {saved && (
                                        <Alert
                                                title={`Saved as baseline version ${saved.version_no}`}
                                                action={
                                                        <Link
                                                                to={`/compensation/cycles/${cycle.id}`}
                                                                className={buttonClasses(
                                                                        'secondary',
                                                                        'sm',
                                                                )}
                                                        >
                                                                Back to the cycle
                                                        </Link>
                                                }
                                        >
                                                {plural(saved.row_count, 'employee')} imported.
                                                Calculate a scenario from the cycle page.
                                        </Alert>
                                )}

                                {preview && <PreviewResult preview={preview} />}

                                {preview?.ready && (
                                        <section
                                                aria-labelledby="confirm-heading"
                                                className={`${cardClasses} space-y-3 p-4`}
                                        >
                                                <h2
                                                        id="confirm-heading"
                                                        className="text-base font-semibold text-slate-900"
                                                >
                                                        3. Save
                                                </h2>
                                                <p className="text-sm text-slate-700">
                                                        Saves the whole file as baseline version{' '}
                                                        {cycle.baselines.length + 1}. The file is
                                                        checked again when you save, and nothing is
                                                        stored if any row fails.
                                                </p>
                                                <ActionError
                                                        error={save.error}
                                                        title="Nothing was saved"
                                                />
                                                <Button
                                                        variant="primary"
                                                        isLoading={save.busy}
                                                        onClick={handleConfirm}
                                                >
                                                        Save the baseline
                                                </Button>
                                        </section>
                                )}
                        </div>
                </>
        )
}

function PreviewResult({ preview }: { preview: BaselinePreview }) {
        return (
                <section aria-labelledby="result-heading" className="space-y-3">
                        <h2 id="result-heading" className="text-lg font-semibold text-slate-900">
                                Validation report
                        </h2>
                        {preview.issues.length > 0 ? (
                                <Alert
                                        tone="danger"
                                        assertive
                                        title={`${plural(preview.issues.length, 'problem')} found in ${plural(preview.rows, 'row')}`}
                                >
                                        Correct the file and check it again. Nothing has been saved.
                                </Alert>
                        ) : (
                                <Alert title="The file is valid">
                                        {plural(preview.rows, 'employee')}: {preview.eligible}{' '}
                                        eligible, {preview.not_eligible} not eligible. Review the
                                        rows below, then save.
                                </Alert>
                        )}
                        {preview.issues.length > 0 && (
                                <Table caption="Problems in the file">
                                        <thead>
                                                <tr>
                                                        <Th align="right">Row</Th>
                                                        <Th>Column</Th>
                                                        <Th>Problem</Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {preview.issues.map((issue, index) => (
                                                        <tr key={index}>
                                                                <Td align="right">
                                                                        {issue.row ?? '—'}
                                                                </Td>
                                                                <Td>{issue.field ?? '—'}</Td>
                                                                <Td>{issue.message}</Td>
                                                        </tr>
                                                ))}
                                        </TBody>
                                </Table>
                        )}
                        {preview.warnings.length > 0 && (
                                <Alert tone="warning" title="Check before saving">
                                        <ul className="list-disc space-y-1 pl-5">
                                                {preview.warnings.map((w) => (
                                                        <li key={w}>{w}</li>
                                                ))}
                                        </ul>
                                </Alert>
                        )}
                        {preview.lines.length > 0 && (
                                <Table caption="Rows in the file">
                                        <thead>
                                                <tr>
                                                        <Th align="right">Row</Th>
                                                        <Th>Employee</Th>
                                                        <Th align="right">Current salary</Th>
                                                        <Th align="right">Reference salary</Th>
                                                        <Th>Grade</Th>
                                                        <Th>Eligible</Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {preview.lines.map((line) => (
                                                        <tr key={line.row}>
                                                                <Td align="right">{line.row}</Td>
                                                                <Td>
                                                                        {line.employee.full_name}
                                                                        <div className="text-xs text-slate-600">
                                                                                {
                                                                                        line
                                                                                                .employee
                                                                                                .employee_code
                                                                                }
                                                                        </div>
                                                                </Td>
                                                                <Td align="right">
                                                                        {money(line.current_salary)}
                                                                </Td>
                                                                <Td align="right">
                                                                        {money(
                                                                                line.reference_salary,
                                                                        )}
                                                                </Td>
                                                                <Td>{line.grade ?? '—'}</Td>
                                                                <Td>
                                                                        {line.eligible ? (
                                                                                <Badge tone="success">
                                                                                        Yes
                                                                                </Badge>
                                                                        ) : (
                                                                                <>
                                                                                        <Badge tone="neutral">
                                                                                                No
                                                                                        </Badge>
                                                                                        <div className="text-xs text-slate-600">
                                                                                                {
                                                                                                        line.exclusion_reason
                                                                                                }
                                                                                        </div>
                                                                                </>
                                                                        )}
                                                                </Td>
                                                        </tr>
                                                ))}
                                        </TBody>
                                </Table>
                        )}
                        {preview.lines_truncated && (
                                <p className="text-sm text-slate-600">
                                        Only the first rows are shown; every row was checked.
                                </p>
                        )}
                </section>
        )
}
