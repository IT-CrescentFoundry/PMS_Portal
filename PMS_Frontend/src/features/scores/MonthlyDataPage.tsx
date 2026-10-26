import { Download, FileSpreadsheet } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ActionError } from '../../components/common/ActionError'
import { Alert } from '../../components/common/Alert'
import { Badge } from '../../components/common/Badge'
import { Button } from '../../components/common/Button'
import { CheckboxField, SelectField } from '../../components/common/Fields'
import { PageHeader } from '../../components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '../../components/common/QueryStates'
import { buttonClasses, cardClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import { useAction } from '../../hooks/useAction'
import { useApiQuery } from '../../hooks/useApiQuery'
import { saveBlob } from '../../services/apiClient'
import { listQuarters } from '../../services/kpiApi'
import {
        confirmDataImport,
        downloadDataTemplate,
        listDataImports,
        previewDataImport,
        type DataImportRequest,
} from '../../services/scoresApi'
import type { DataImportConfirmed, DataImportPreview, Quarter } from '../../types/api'
import { csvBlob } from '../../utils/csv'
import { formatDate, formatNumber, plural } from '../../utils/format'
import { parseId, withParams } from '../../utils/params'
import { useCurrentUser } from '../auth/AuthContext'
import { canWriteKpi } from '../auth/permissions'
import { AccessDenied } from '../auth/RequireAuth'
import { quarterLabel } from '../kpi/kpiLabels'
import { monthLabel, scoringQuarter, startedMonths } from './scoreLabels'

const MAX_BYTES = 2_000_000
const ACTION_LABELS = { new: 'New', replace: 'Replaces', unchanged: 'Unchanged' } as const

/** /scores/data */
export function MonthlyDataPage() {
        const user = useCurrentUser()
        const allowed = canWriteKpi(user)
        const [params, setParams] = useSearchParams()
        const quarters = useApiQuery(allowed ? 'quarters' : null, (signal) => listQuarters(signal))
        if (!allowed) return <AccessDenied />
        if (quarters.isLoading) return <LoadingState label="Loading quarters…" />
        if (quarters.error !== undefined || !quarters.data)
                return <ErrorState error={quarters.error} onRetry={quarters.reload} />
        const chosen = parseId(params.get('quarter'))
        const quarter =
                quarters.data.find((q) => q.id === chosen) ??
                scoringQuarter(quarters.data, ['OPEN'])
        if (!quarter) {
                return (
                        <>
                                <DataHeader />
                                <EmptyState title="No PMS cycle has been set up yet" />
                        </>
                )
        }
        return (
                <Importer
                        key={quarter.id}
                        quarters={quarters.data}
                        quarter={quarter}
                        onQuarter={(id) =>
                                setParams(withParams(params, { quarter: id }), { replace: true })
                        }
                />
        )
}

function DataHeader() {
        return (
                <PageHeader
                        title="Monthly KPI data"
                        description="Import the month’s actual values from a CSV or Excel file. The file is checked first and nothing is saved until you confirm; then every value is stored together, or none is. Source values stay separate from calculated, reviewed and published scores."
                />
        )
}

function Importer({
        quarters,
        quarter,
        onQuarter,
}: {
        quarters: Quarter[]
        quarter: Quarter
        onQuarter: (id: number) => void
}) {
        const months = startedMonths(quarter)
        const [period, setPeriod] = useState(months[months.length - 1] ?? '')
        const [file, setFile] = useState<File | null>(null)
        const [fileError, setFileError] = useState<string | null>(null)
        const [mapping, setMapping] = useState<Record<string, string | null> | null>(null)
        const [replaceExisting, setReplaceExisting] = useState(false)
        const [preview, setPreview] = useState<DataImportPreview | null>(null)
        const [checkedWith, setCheckedWith] = useState('')
        const [confirmed, setConfirmed] = useState<DataImportConfirmed | null>(null)
        const [inputKey, setInputKey] = useState(0)
        const imports = useApiQuery(`data-imports|${quarter.id}`, (signal) =>
                listDataImports(quarter.id, signal),
        )
        const template = useAction()
        const check = useAction()
        const save = useAction()

        const request = (): DataImportRequest => ({
                quarterId: quarter.id,
                period,
                file: file!,
                mapping: mapping ?? undefined,
                replaceExisting,
        })
        const settings = JSON.stringify({
                period,
                mapping,
                replaceExisting,
                name: file?.name,
                size: file?.size,
        })
        const current = preview !== null && checkedWith === settings

        function chooseFile(chosen: File | null) {
                setPreview(null)
                setConfirmed(null)
                setMapping(null)
                check.clearError()
                save.clearError()
                setFile(chosen)
                const name = chosen?.name.toLowerCase() ?? ''
                if (chosen === null) setFileError(null)
                else if (!name.endsWith('.csv') && !name.endsWith('.xlsx'))
                        setFileError('Choose a CSV (.csv) or Excel (.xlsx) file.')
                else if (chosen.size > MAX_BYTES) setFileError('The file is larger than 2 MB.')
                else setFileError(null)
        }

        async function handleCheck(event: FormEvent) {
                event.preventDefault()
                if (!file || fileError) {
                        setFileError(fileError ?? 'Choose the file to import.')
                        return
                }
                setConfirmed(null)
                const result = await check.run(() => previewDataImport(request()))
                if (result) {
                        setPreview(result)
                        setMapping(result.mapping)
                        setCheckedWith(
                                JSON.stringify({
                                        period,
                                        mapping: result.mapping,
                                        replaceExisting,
                                        name: file.name,
                                        size: file.size,
                                }),
                        )
                }
        }

        async function handleConfirm() {
                if (!file) return
                const result = await save.run(() => confirmDataImport(request()))
                if (result) {
                        setConfirmed(result)
                        setPreview(null)
                        setFile(null)
                        setMapping(null)
                        setReplaceExisting(false)
                        setInputKey((k) => k + 1)
                        imports.reload()
                }
        }

        async function handleTemplate() {
                const blob = await template.run(() => downloadDataTemplate(quarter.id, period))
                if (blob) saveBlob(blob, `kpi-data-${period}.xlsx`)
        }

        return (
                <>
                        <DataHeader />
                        <div className="space-y-4">
                                <section
                                        aria-labelledby="period-heading"
                                        className={`${cardClasses} space-y-3 p-4`}
                                >
                                        <h2
                                                id="period-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                1. Month and template
                                        </h2>
                                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                                <SelectField
                                                        label="Quarter"
                                                        value={String(quarter.id)}
                                                        onChange={(e) =>
                                                                onQuarter(Number(e.target.value))
                                                        }
                                                        options={quarters.map((q) => ({
                                                                value: String(q.id),
                                                                label: quarterLabel(q),
                                                        }))}
                                                />
                                                <SelectField
                                                        label="Month"
                                                        value={period}
                                                        disabled={months.length === 0}
                                                        onChange={(e) => {
                                                                setPeriod(e.target.value)
                                                                setPreview(null)
                                                                setConfirmed(null)
                                                        }}
                                                        options={
                                                                months.length
                                                                        ? months.map((m) => ({
                                                                                  value: m,
                                                                                  label: monthLabel(
                                                                                          m,
                                                                                  ),
                                                                          }))
                                                                        : [
                                                                                  {
                                                                                          value: '',
                                                                                          label: 'No month has started yet',
                                                                                  },
                                                                          ]
                                                        }
                                                />
                                        </div>
                                        <p className="text-sm text-slate-700">
                                                One row per employee and KPI: Employee Code, KPI
                                                (code or name), Period (YYYY-MM) and Actual, plus
                                                Plant Code and Department Code for employees with
                                                more than one assignment. The template is pre-filled
                                                with the KPIs that need data for the month, from
                                                published and locked KPI sheets only.
                                        </p>
                                        <ActionError
                                                error={template.error}
                                                title="The template could not be downloaded"
                                        />
                                        <Button
                                                isLoading={template.busy}
                                                disabled={!period}
                                                onClick={handleTemplate}
                                        >
                                                <Download aria-hidden="true" className="size-4" />
                                                Download template for{' '}
                                                {period ? monthLabel(period) : 'the month'}
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
                                        <div className="space-y-1">
                                                <label
                                                        htmlFor="data-file"
                                                        className="block text-sm font-medium text-slate-800"
                                                >
                                                        CSV or Excel file (up to 2 MB)
                                                </label>
                                                <input
                                                        key={inputKey}
                                                        id="data-file"
                                                        type="file"
                                                        accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                                                        aria-invalid={fileError ? true : undefined}
                                                        aria-describedby={
                                                                fileError
                                                                        ? 'data-file-error'
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
                                                                id="data-file-error"
                                                                className="text-xs font-medium text-red-700"
                                                        >
                                                                {fileError}
                                                        </p>
                                                )}
                                        </div>
                                        {preview && mapping && (
                                                <fieldset className="space-y-3">
                                                        <legend className="text-sm font-semibold text-slate-900">
                                                                Columns in the file
                                                        </legend>
                                                        <p className="text-sm text-slate-700">
                                                                Columns were matched by name. Change
                                                                a match if your file uses other
                                                                headings, then check the file again.
                                                        </p>
                                                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                                                                {preview.contract.map((c) => (
                                                                        <SelectField
                                                                                key={c.key}
                                                                                label={`${c.label}${c.required ? ' (required)' : ''}`}
                                                                                hint={c.description}
                                                                                value={
                                                                                        mapping[
                                                                                                c
                                                                                                        .key
                                                                                        ] ?? ''
                                                                                }
                                                                                onChange={(e) =>
                                                                                        setMapping({
                                                                                                ...mapping,
                                                                                                [c.key]:
                                                                                                        e
                                                                                                                .target
                                                                                                                .value ||
                                                                                                        null,
                                                                                        })
                                                                                }
                                                                                options={[
                                                                                        {
                                                                                                value: '',
                                                                                                label: 'Not in the file',
                                                                                        },
                                                                                        ...preview.columns.map(
                                                                                                (
                                                                                                        col,
                                                                                                ) => ({
                                                                                                        value: col,
                                                                                                        label: col,
                                                                                                }),
                                                                                        ),
                                                                                ]}
                                                                        />
                                                                ))}
                                                        </div>
                                                </fieldset>
                                        )}
                                        <CheckboxField
                                                label="Replace values already stored for this month"
                                                checked={replaceExisting}
                                                onChange={(e) =>
                                                        setReplaceExisting(e.target.checked)
                                                }
                                        />
                                        <ActionError
                                                error={check.error}
                                                title="The file could not be checked"
                                        />
                                        <Button
                                                type="submit"
                                                variant="primary"
                                                isLoading={check.busy}
                                                disabled={!period}
                                        >
                                                <FileSpreadsheet
                                                        aria-hidden="true"
                                                        className="size-4"
                                                />
                                                {preview ? 'Check the file again' : 'Check file'}
                                        </Button>
                                </form>

                                {confirmed && (
                                        <Alert
                                                title="Monthly values saved"
                                                action={
                                                        <Link
                                                                to={`/scores/results?quarter=${quarter.id}`}
                                                                className={buttonClasses(
                                                                        'secondary',
                                                                        'sm',
                                                                )}
                                                        >
                                                                Calculate and review scores
                                                        </Link>
                                                }
                                        >
                                                {plural(confirmed.created, 'new value')},{' '}
                                                {plural(confirmed.replaced, 'replaced value')} and{' '}
                                                {formatNumber(confirmed.unchanged)} unchanged from{' '}
                                                {plural(confirmed.rows, 'row')}.
                                        </Alert>
                                )}

                                {preview && !current && (
                                        <Alert
                                                tone="warning"
                                                title="The settings changed since the check"
                                        >
                                                Check the file again before saving.
                                        </Alert>
                                )}
                                {preview && <ImportPreview preview={preview} />}

                                {preview && current && preview.ready && (
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
                                                        The file is checked again when you save. Its
                                                        name, size and fingerprint are recorded with
                                                        your name; the file itself is not stored.
                                                        {preview.counts.replace > 0 &&
                                                                ` ${plural(preview.counts.replace, 'stored value')} will be replaced.`}
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
                                                        {plural(
                                                                preview.counts.new +
                                                                        preview.counts.replace +
                                                                        preview.counts.unchanged,
                                                                'value',
                                                        )}{' '}
                                                        for {monthLabel(preview.period)}
                                                </Button>
                                        </section>
                                )}

                                <section aria-labelledby="imports-heading" className="space-y-2">
                                        <h2
                                                id="imports-heading"
                                                className="text-base font-semibold text-slate-900"
                                        >
                                                Imports for {quarter.name}
                                        </h2>
                                        {imports.isLoading ? (
                                                <LoadingState label="Loading imports…" />
                                        ) : imports.error !== undefined || !imports.data ? (
                                                <ErrorState
                                                        error={imports.error}
                                                        onRetry={imports.reload}
                                                />
                                        ) : imports.data.length === 0 ? (
                                                <EmptyState title="No data imported for this quarter yet" />
                                        ) : (
                                                <Table caption={`Imports for ${quarter.name}`}>
                                                        <thead>
                                                                <tr>
                                                                        <Th>Month</Th>
                                                                        <Th>File</Th>
                                                                        <Th align="right">Rows</Th>
                                                                        <Th align="right">New</Th>
                                                                        <Th align="right">
                                                                                Replaced
                                                                        </Th>
                                                                        <Th className="hidden md:table-cell">
                                                                                By
                                                                        </Th>
                                                                        <Th className="hidden md:table-cell">
                                                                                On
                                                                        </Th>
                                                                </tr>
                                                        </thead>
                                                        <TBody>
                                                                {imports.data.map((i) => (
                                                                        <tr key={i.id}>
                                                                                <Td>
                                                                                        {monthLabel(
                                                                                                i.period,
                                                                                        )}
                                                                                </Td>
                                                                                <Td>
                                                                                        {
                                                                                                i.file_name
                                                                                        }
                                                                                </Td>
                                                                                <Td align="right">
                                                                                        {
                                                                                                i.row_count
                                                                                        }
                                                                                </Td>
                                                                                <Td align="right">
                                                                                        {
                                                                                                i.rows_created
                                                                                        }
                                                                                </Td>
                                                                                <Td align="right">
                                                                                        {
                                                                                                i.rows_replaced
                                                                                        }
                                                                                </Td>
                                                                                <Td className="hidden md:table-cell">
                                                                                        {i.created_by ??
                                                                                                '—'}
                                                                                </Td>
                                                                                <Td className="hidden md:table-cell">
                                                                                        {formatDate(
                                                                                                i.created_at,
                                                                                        )}
                                                                                </Td>
                                                                        </tr>
                                                                ))}
                                                        </TBody>
                                                </Table>
                                        )}
                                </section>
                        </div>
                </>
        )
}

function ImportPreview({ preview }: { preview: DataImportPreview }) {
        const issues = preview.issues
        return (
                <section aria-labelledby="preview-heading" className="space-y-3">
                        <h2 id="preview-heading" className="text-lg font-semibold text-slate-900">
                                Check result for {monthLabel(preview.period)}
                        </h2>
                        {issues.length > 0 ? (
                                <Alert
                                        tone="danger"
                                        assertive
                                        title={`${plural(issues.length, 'problem')} found in ${plural(preview.row_count, 'row')}`}
                                >
                                        Correct the file (or the column matches) and check it again.
                                        Nothing has been saved.
                                </Alert>
                        ) : preview.lines.length === 0 ? (
                                <Alert tone="warning" title="The file has no values to import" />
                        ) : (
                                <Alert title="The file is valid">
                                        {plural(preview.counts.new, 'new value')},{' '}
                                        {plural(preview.counts.replace, 'replacement')} and{' '}
                                        {formatNumber(preview.counts.unchanged)} unchanged.
                                </Alert>
                        )}
                        {preview.duplicate_import && (
                                <Alert tone="warning" title="This file was imported before">
                                        The same file was imported as “
                                        {preview.duplicate_import.file_name}” on{' '}
                                        {formatDate(preview.duplicate_import.created_at)}.
                                </Alert>
                        )}
                        {preview.warnings.length > 0 && (
                                <Alert
                                        tone="warning"
                                        title={plural(preview.warnings.length, 'warning')}
                                >
                                        <ul className="list-disc pl-5">
                                                {preview.warnings.map((w) => (
                                                        <li key={w}>{w}</li>
                                                ))}
                                        </ul>
                                </Alert>
                        )}
                        {issues.length > 0 && (
                                <>
                                        <Button
                                                size="sm"
                                                onClick={() =>
                                                        saveBlob(
                                                                csvBlob([
                                                                        ['Row', 'Problem'],
                                                                        ...issues.map((i) => [
                                                                                i.row ?? '',
                                                                                i.message,
                                                                        ]),
                                                                ]),
                                                                `kpi-data-${preview.period}-problems.csv`,
                                                        )
                                                }
                                        >
                                                <Download aria-hidden="true" className="size-4" />
                                                Download the problems (CSV)
                                        </Button>
                                        <Table caption="Problems in the file">
                                                <thead>
                                                        <tr>
                                                                <Th align="right">Row</Th>
                                                                <Th>Problem</Th>
                                                        </tr>
                                                </thead>
                                                <TBody>
                                                        {issues.map((issue, index) => (
                                                                <tr key={index}>
                                                                        <Td align="right">
                                                                                {issue.row ?? '—'}
                                                                        </Td>
                                                                        <Td>{issue.message}</Td>
                                                                </tr>
                                                        ))}
                                                </TBody>
                                        </Table>
                                </>
                        )}
                        {preview.lines.length > 0 && (
                                <Table caption="Values in the file">
                                        <thead>
                                                <tr>
                                                        <Th align="right">Row</Th>
                                                        <Th>Employee</Th>
                                                        <Th className="hidden lg:table-cell">
                                                                Assignment
                                                        </Th>
                                                        <Th>KPI</Th>
                                                        <Th align="right">Actual</Th>
                                                        <Th align="right">Stored now</Th>
                                                        <Th>Action</Th>
                                                </tr>
                                        </thead>
                                        <TBody>
                                                {preview.lines.map((line) => (
                                                        <tr key={line.row}>
                                                                <Td align="right">{line.row}</Td>
                                                                <Td>
                                                                        {line.employee_name}
                                                                        <div className="text-xs text-slate-600">
                                                                                {line.employee_code}
                                                                        </div>
                                                                </Td>
                                                                <Td className="hidden lg:table-cell">
                                                                        {line.assignment}
                                                                </Td>
                                                                <Td>
                                                                        {line.kpi_name}
                                                                        {line.inputs &&
                                                                                Object.keys(
                                                                                        line.inputs,
                                                                                ).length > 0 && (
                                                                                        <div className="text-xs text-slate-600">
                                                                                                {Object.entries(
                                                                                                        line.inputs,
                                                                                                )
                                                                                                        .map(
                                                                                                                ([
                                                                                                                        k,
                                                                                                                        v,
                                                                                                                ]) =>
                                                                                                                        `${k}: ${String(v)}`,
                                                                                                        )
                                                                                                        .join(
                                                                                                                ', ',
                                                                                                        )}
                                                                                        </div>
                                                                                )}
                                                                        {line.note && (
                                                                                <div className="text-xs text-amber-900">
                                                                                        {line.note}
                                                                                </div>
                                                                        )}
                                                                </Td>
                                                                <Td align="right">
                                                                        {line.actual ?? '—'}
                                                                </Td>
                                                                <Td align="right">
                                                                        {line.previous_actual ??
                                                                                '—'}
                                                                </Td>
                                                                <Td>
                                                                        <Badge
                                                                                tone={
                                                                                        line.action ===
                                                                                        'new'
                                                                                                ? 'success'
                                                                                                : line.action ===
                                                                                                    'replace'
                                                                                                  ? 'warning'
                                                                                                  : 'neutral'
                                                                                }
                                                                        >
                                                                                {
                                                                                        ACTION_LABELS[
                                                                                                line
                                                                                                        .action
                                                                                        ]
                                                                                }
                                                                        </Badge>
                                                                </Td>
                                                        </tr>
                                                ))}
                                        </TBody>
                                </Table>
                        )}
                        {preview.lines_truncated && (
                                <p className="text-sm text-slate-700">
                                        Only the first {plural(preview.lines.length, 'row')} are
                                        shown; all {formatNumber(preview.row_count)} are checked and
                                        saved.
                                </p>
                        )}
                </section>
        )
}
