import { Download, FileSpreadsheet } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { SelectField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { buttonClasses, cardClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { saveBlob } from '../../services/apiClient'
import {
        confirmUpload,
        downloadUploadTemplate,
        listQuarters,
        previewUpload,
        UPLOAD_TEMPLATE_NAME,
} from '../../services/kpiApi'
import type { Quarter, UploadConfirmed, UploadPreview } from '../../types/api'
import { plural } from '../../utils/format'
import { parseId } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { canWriteKpi } from '../auth/permissions'
import { AccessDenied } from '../auth/RequireAuth'
import { quarterLabel } from './kpiLabels'

const MAX_BYTES = 1_000_000

export function KpiUploadPage() {
        const user = useCurrentUser()
        const quarters = useApiQuery('quarters', (signal) => listQuarters(signal))
        if (!canWriteKpi(user)) return <AccessDenied />
        if (quarters.isLoading) return <LoadingState label="Loading quarters…" />
        if (quarters.error !== undefined || !quarters.data)
                return <ErrorState error={quarters.error} onRetry={quarters.reload} />
        const open = quarters.data.filter((q) => q.status === 'DRAFT')
        if (open.length === 0) {
                return (
                        <>
                                <UploadHeader />
                                <EmptyState title="No quarter is open for KPI setup">
                                        Scoring has started for every quarter. Changes to locked
                                        sheets need a deviation.
                                </EmptyState>
                        </>
                )
        }
        return <Uploader quarters={open} />
}

function UploadHeader() {
        return (
                <PageHeader
                        title="Upload KPI sheets from Excel"
                        description="Department Heads can prepare KPIs for many employees in one workbook. The file is checked first and nothing is saved until you confirm; then every sheet in the file is saved as a draft together, or none is."
                        breadcrumbs={[
                                { label: 'KPI sheets', to: '/kpi/sheets' },
                                { label: 'Upload from Excel' },
                        ]}
                />
        )
}

function Uploader({ quarters }: { quarters: Quarter[] }) {
        const [params] = useSearchParams()
        const requested = parseId(params.get('quarter'))
        const [quarterId, setQuarterId] = useState(
                String((quarters.find((q) => q.id === requested) ?? quarters[0]).id),
        )
        const [file, setFile] = useState<File | null>(null)
        const [fileError, setFileError] = useState<string | null>(null)
        const [preview, setPreview] = useState<UploadPreview | null>(null)
        const [confirmed, setConfirmed] = useState<UploadConfirmed | null>(null)
        const [inputKey, setInputKey] = useState(0)
        const template = useAction()
        const check = useAction()
        const save = useAction()

        function reset() {
                setPreview(null)
                setConfirmed(null)
                check.clearError()
                save.clearError()
        }

        function chooseFile(chosen: File | null) {
                reset()
                setFile(chosen)
                if (chosen === null) setFileError(null)
                else if (!chosen.name.toLowerCase().endsWith('.xlsx'))
                        setFileError(
                                'Choose an Excel workbook (.xlsx). Save older .xls files as .xlsx first.',
                        )
                else if (chosen.size > MAX_BYTES) setFileError('The file is larger than 1 MB.')
                else setFileError(null)
        }

        async function handleCheck(event: FormEvent) {
                event.preventDefault()
                if (!file || fileError) {
                        setFileError(fileError ?? 'Choose the Excel file to upload.')
                        return
                }
                reset()
                const result = await check.run(() => previewUpload(Number(quarterId), file))
                if (result) setPreview(result)
        }

        async function handleConfirm() {
                if (!file) return
                const result = await save.run(() => confirmUpload(Number(quarterId), file))
                if (result) {
                        setConfirmed(result)
                        setPreview(null)
                        setFile(null)
                        setInputKey((k) => k + 1)
                }
        }

        async function handleTemplate() {
                const blob = await template.run(() => downloadUploadTemplate())
                if (blob) saveBlob(blob, UPLOAD_TEMPLATE_NAME)
        }

        const quarter = quarters.find((q) => String(q.id) === quarterId)!
        const ready = preview !== null && preview.issues.length === 0 && preview.sheets.length > 0

        return (
                <>
                        <UploadHeader />
                        <div className="space-y-4">
                                <section
                                        aria-labelledby="template-heading"
                                        className={`${cardClasses} space-y-2 p-4`}
                                >
                                        <h2
                                                id="template-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                1. Fill in the template
                                        </h2>
                                        <p className="text-sm text-slate-700">
                                                One row per KPI per employee: Employee Code, KPI
                                                (name or code from the library), Weightage % and the
                                                quarterly target. Add Plant Code and Department Code
                                                only for employees who work in more than one unit.
                                                The template lists the KPIs and scoring rules you
                                                can use.
                                        </p>
                                        <ActionError
                                                error={template.error}
                                                title="The template could not be downloaded"
                                        />
                                        <Button isLoading={template.busy} onClick={handleTemplate}>
                                                <Download aria-hidden="true" className="size-4" />
                                                Download template
                                        </Button>
                                </section>

                                <form
                                        onSubmit={handleCheck}
                                        aria-labelledby="file-heading"
                                        className={`${cardClasses} space-y-4 p-4`}
                                >
                                        <h2
                                                id="file-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                2. Check the file
                                        </h2>
                                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                                <SelectField
                                                        label="Quarter"
                                                        value={quarterId}
                                                        onChange={(e) => {
                                                                setQuarterId(e.target.value)
                                                                reset()
                                                        }}
                                                        options={quarters.map((q) => ({
                                                                value: String(q.id),
                                                                label: quarterLabel(q),
                                                        }))}
                                                />
                                                <div className="space-y-1">
                                                        <label
                                                                htmlFor="kpi-file"
                                                                className="block text-sm font-medium text-slate-800"
                                                        >
                                                                Excel file (.xlsx, up to 1 MB)
                                                        </label>
                                                        <input
                                                                key={inputKey}
                                                                id="kpi-file"
                                                                type="file"
                                                                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                                                                aria-invalid={
                                                                        fileError ? true : undefined
                                                                }
                                                                aria-describedby={
                                                                        fileError
                                                                                ? 'kpi-file-error'
                                                                                : undefined
                                                                }
                                                                className="block w-full text-sm text-slate-800 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium"
                                                                onChange={(e) =>
                                                                        chooseFile(
                                                                                e.target
                                                                                        .files?.[0] ??
                                                                                        null,
                                                                        )
                                                                }
                                                        />
                                                        {fileError && (
                                                                <p
                                                                        id="kpi-file-error"
                                                                        className="text-xs font-medium text-red-700"
                                                                >
                                                                        {fileError}
                                                                </p>
                                                        )}
                                                </div>
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
                                                Check file
                                        </Button>
                                </form>

                                {confirmed && (
                                        <Alert
                                                title="Upload saved"
                                                action={
                                                        <Link
                                                                to={`/kpi/sheets?quarter=${quarter.id}`}
                                                                className={buttonClasses(
                                                                        'secondary',
                                                                        'sm',
                                                                )}
                                                        >
                                                                Review and publish the sheets
                                                        </Link>
                                                }
                                        >
                                                {plural(confirmed.sheets_created, 'sheet')} created
                                                and{' '}
                                                {plural(confirmed.sheets_updated, 'draft sheet')}{' '}
                                                replaced, with {plural(confirmed.items, 'KPI')} from{' '}
                                                {plural(confirmed.rows, 'row')}. They are drafts
                                                until published.
                                        </Alert>
                                )}

                                {preview && <PreviewResult preview={preview} />}

                                {ready && (
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
                                                        The file is checked again when you save.
                                                        Existing draft sheets for these employees in{' '}
                                                        {quarter.name} are replaced by the file’s
                                                        rows.
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
                                                        Save{' '}
                                                        {plural(preview.sheets.length, 'sheet')} as
                                                        drafts
                                                </Button>
                                        </section>
                                )}
                        </div>
                </>
        )
}

function PreviewResult({ preview }: { preview: UploadPreview }) {
        if (preview.issues.length > 0) {
                return (
                        <section aria-labelledby="issues-heading" className="space-y-2">
                                <Alert
                                        tone="danger"
                                        assertive
                                        title={`${plural(preview.issues.length, 'problem')} found in ${plural(preview.row_count, 'row')}`}
                                >
                                        Correct the file and check it again. Nothing has been saved.
                                </Alert>
                                <h2 id="issues-heading" className="sr-only">
                                        Problems in the file
                                </h2>
                                <Table caption="Problems in the file">
                                        <thead>
                                                <tr>
                                                        <Th align="right">Row</Th>
                                                        <Th>Problem</Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {preview.issues.map((issue, index) => (
                                                        <tr key={index}>
                                                                <Td align="right">
                                                                        {issue.row ?? '—'}
                                                                </Td>
                                                                <Td>{issue.message}</Td>
                                                        </tr>
                                                ))}
                                        </TBody>
                                </Table>
                        </section>
                )
        }
        if (preview.sheets.length === 0) {
                return <EmptyState title="The file has no KPI rows" />
        }
        return (
                <section aria-labelledby="preview-heading" className="space-y-4">
                        <Alert title="The file is valid">
                                {plural(preview.row_count, 'row')} for{' '}
                                {plural(preview.sheets.length, 'employee sheet')} in{' '}
                                {preview.quarter.name}. Review them below, then save.
                        </Alert>
                        <h2 id="preview-heading" className="text-lg font-semibold text-slate-900">
                                Preview
                        </h2>
                        {preview.sheets.map((sheet) => (
                                <div
                                        key={`${sheet.employee.id}-${sheet.plant.id}-${sheet.department.id}`}
                                        className="space-y-2"
                                >
                                        <div className="flex flex-wrap items-center gap-2">
                                                <h3 className="font-semibold text-slate-900">
                                                        {sheet.employee.full_name} (
                                                        {sheet.employee.employee_code})
                                                </h3>
                                                <span className="text-sm text-slate-700">
                                                        {sheet.department.name} — {sheet.plant.name}
                                                </span>
                                                <Badge
                                                        tone={
                                                                sheet.action === 'create'
                                                                        ? 'success'
                                                                        : 'warning'
                                                        }
                                                >
                                                        {sheet.action === 'create'
                                                                ? 'New sheet'
                                                                : 'Replaces the draft'}
                                                </Badge>
                                        </div>
                                        <Table
                                                caption={`Uploaded KPIs for ${sheet.employee.full_name}`}
                                        >
                                                <thead>
                                                        <tr>
                                                                <Th align="right">Row</Th>
                                                                <Th>KPI</Th>
                                                                <Th align="right">Weightage</Th>
                                                                <Th align="right">Target</Th>
                                                                <Th className="hidden md:table-cell">
                                                                        Scoring rule
                                                                </Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {sheet.items.map((item) => (
                                                                <tr key={item.row}>
                                                                        <Td align="right">
                                                                                {item.row}
                                                                        </Td>
                                                                        <Td>{item.kpi_name}</Td>
                                                                        <Td align="right">
                                                                                {item.weightage.toFixed(
                                                                                        2,
                                                                                )}
                                                                                %
                                                                        </Td>
                                                                        <Td align="right">
                                                                                {item.target_value ??
                                                                                        '—'}{' '}
                                                                                {item.unit ?? ''}
                                                                        </Td>
                                                                        <Td className="hidden md:table-cell">
                                                                                {item.scoring_policy ??
                                                                                        'Default'}
                                                                        </Td>
                                                                </tr>
                                                        ))}
                                                </TBody>
                                                <tfoot className="border-t border-slate-200 bg-slate-50">
                                                        <tr>
                                                                <td />
                                                                <th
                                                                        scope="row"
                                                                        className="px-4 py-2 text-left text-sm font-semibold"
                                                                >
                                                                        Total
                                                                </th>
                                                                <td className="px-4 py-2 text-right text-sm font-semibold tabular-nums">
                                                                        {sheet.total.toFixed(2)}%
                                                                </td>
                                                                <td colSpan={2} />
                                                        </tr>
                                                </tfoot>
                                        </Table>
                                </div>
                        ))}
                </section>
        )
}
