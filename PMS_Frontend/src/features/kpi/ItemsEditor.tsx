import { Plus, Trash2 } from 'lucide-react'
import { Button } from '../../components/common/Button'
import { inputClasses } from '../../components/common/styles'
import { Table, TBody, Td, Th } from '../../components/tables/Table'
import type { Kpi, ScoringPolicy } from '../../types/api'
import { newRow, type ItemRow, type RowErrors } from './itemRows'
import { formatCents, summarizeWeights, totalMessage } from './weightage'

interface ItemsEditorProps {
        caption: string
        rows: ItemRow[]
        onChange: (rows: ItemRow[]) => void
        /** KPIs usable at the assignment's plant and department. */
        kpis: Kpi[]
        policies: ScoringPolicy[]
        /** Shown after the first save attempt. */
        errors: RowErrors[] | null
}

/** The API's limit per sheet; 3–5 is guidance, not a rule. */
const MAX_ITEMS = 30

/** Editable KPI rows with a live weightage total (must reach exactly 100%). */
export function ItemsEditor({ caption, rows, onChange, kpis, policies, errors }: ItemsEditorProps) {
        const summary = summarizeWeights(rows.map((r) => r.weightage))
        const byId = new Map(kpis.map((k) => [String(k.id), k]))
        const update = (index: number, change: Partial<ItemRow>) =>
                onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)))
        const count = rows.length

        return (
                <div className="space-y-3">
                        <Table caption={caption}>
                                <thead>
                                        <tr>
                                                <Th>KPI</Th>
                                                <Th>Weightage %</Th>
                                                <Th>Quarterly target</Th>
                                                <Th className="hidden lg:table-cell">Unit</Th>
                                                <Th className="hidden lg:table-cell">
                                                        Scoring rule
                                                </Th>
                                                <Th className="hidden xl:table-cell">
                                                        Target note
                                                </Th>
                                                <Th>
                                                        <span className="sr-only">Remove</span>
                                                </Th>
                                        </tr>
                                </thead>
                                <TBody>
                                        {rows.map((row, index) => {
                                                const kpi = byId.get(row.kpiId)
                                                const zero = kpi?.direction === 'ZERO_TOLERANCE'
                                                const rowErrors = errors?.[index] ?? {}
                                                const n = index + 1
                                                const choices = policies.filter(
                                                        (p) =>
                                                                p.is_active &&
                                                                kpi !== undefined &&
                                                                p.direction === kpi.direction,
                                                )
                                                return (
                                                        <tr key={row.key}>
                                                                <Td className="min-w-56">
                                                                        <select
                                                                                aria-label={`KPI ${n}`}
                                                                                className={
                                                                                        inputClasses
                                                                                }
                                                                                value={row.kpiId}
                                                                                aria-invalid={
                                                                                        rowErrors.kpi
                                                                                                ? true
                                                                                                : undefined
                                                                                }
                                                                                aria-describedby={
                                                                                        rowErrors.kpi
                                                                                                ? `${row.key}-kpi`
                                                                                                : undefined
                                                                                }
                                                                                onChange={(e) =>
                                                                                        update(
                                                                                                index,
                                                                                                {
                                                                                                        kpiId: e
                                                                                                                .target
                                                                                                                .value,
                                                                                                        policyId: '',
                                                                                                        unit: '',
                                                                                                },
                                                                                        )
                                                                                }
                                                                        >
                                                                                <option value="">
                                                                                        Choose a
                                                                                        KPI…
                                                                                </option>
                                                                                {kpis.map((k) => (
                                                                                        <option
                                                                                                key={
                                                                                                        k.id
                                                                                                }
                                                                                                value={
                                                                                                        k.id
                                                                                                }
                                                                                        >
                                                                                                {
                                                                                                        k.name
                                                                                                }
                                                                                        </option>
                                                                                ))}
                                                                        </select>
                                                                        <CellError
                                                                                id={`${row.key}-kpi`}
                                                                                message={
                                                                                        rowErrors.kpi
                                                                                }
                                                                        />
                                                                </Td>
                                                                <Td className="w-32">
                                                                        <input
                                                                                aria-label={`Weightage % for KPI ${n}`}
                                                                                inputMode="decimal"
                                                                                className={`${inputClasses} text-right`}
                                                                                value={
                                                                                        row.weightage
                                                                                }
                                                                                aria-invalid={
                                                                                        rowErrors.weightage
                                                                                                ? true
                                                                                                : undefined
                                                                                }
                                                                                aria-describedby={
                                                                                        rowErrors.weightage
                                                                                                ? `${row.key}-weightage`
                                                                                                : undefined
                                                                                }
                                                                                onChange={(e) =>
                                                                                        update(
                                                                                                index,
                                                                                                {
                                                                                                        weightage: e
                                                                                                                .target
                                                                                                                .value,
                                                                                                },
                                                                                        )
                                                                                }
                                                                        />
                                                                        <CellError
                                                                                id={`${row.key}-weightage`}
                                                                                message={
                                                                                        rowErrors.weightage
                                                                                }
                                                                        />
                                                                </Td>
                                                                <Td className="w-40">
                                                                        {zero ? (
                                                                                <p className="pt-2 text-sm text-slate-700">
                                                                                        0 (zero
                                                                                        tolerance)
                                                                                </p>
                                                                        ) : (
                                                                                <>
                                                                                        <input
                                                                                                aria-label={`Quarterly target for KPI ${n}`}
                                                                                                inputMode="decimal"
                                                                                                className={`${inputClasses} text-right`}
                                                                                                value={
                                                                                                        row.target
                                                                                                }
                                                                                                aria-invalid={
                                                                                                        rowErrors.target
                                                                                                                ? true
                                                                                                                : undefined
                                                                                                }
                                                                                                aria-describedby={
                                                                                                        rowErrors.target
                                                                                                                ? `${row.key}-target`
                                                                                                                : undefined
                                                                                                }
                                                                                                onChange={(
                                                                                                        e,
                                                                                                ) =>
                                                                                                        update(
                                                                                                                index,
                                                                                                                {
                                                                                                                        target: e
                                                                                                                                .target
                                                                                                                                .value,
                                                                                                                },
                                                                                                        )
                                                                                                }
                                                                                        />
                                                                                        <CellError
                                                                                                id={`${row.key}-target`}
                                                                                                message={
                                                                                                        rowErrors.target
                                                                                                }
                                                                                        />
                                                                                </>
                                                                        )}
                                                                </Td>
                                                                <Td className="hidden w-28 lg:table-cell">
                                                                        <input
                                                                                aria-label={`Unit for KPI ${n}`}
                                                                                className={
                                                                                        inputClasses
                                                                                }
                                                                                maxLength={30}
                                                                                placeholder={
                                                                                        kpi?.unit ??
                                                                                        ''
                                                                                }
                                                                                value={row.unit}
                                                                                onChange={(e) =>
                                                                                        update(
                                                                                                index,
                                                                                                {
                                                                                                        unit: e
                                                                                                                .target
                                                                                                                .value,
                                                                                                },
                                                                                        )
                                                                                }
                                                                        />
                                                                </Td>
                                                                <Td className="hidden min-w-44 lg:table-cell">
                                                                        <select
                                                                                aria-label={`Scoring rule for KPI ${n}`}
                                                                                className={
                                                                                        inputClasses
                                                                                }
                                                                                value={row.policyId}
                                                                                disabled={
                                                                                        kpi ===
                                                                                        undefined
                                                                                }
                                                                                onChange={(e) =>
                                                                                        update(
                                                                                                index,
                                                                                                {
                                                                                                        policyId: e
                                                                                                                .target
                                                                                                                .value,
                                                                                                },
                                                                                        )
                                                                                }
                                                                        >
                                                                                <option value="">
                                                                                        {kpi
                                                                                                ? `Default (${kpi.default_scoring_policy.name})`
                                                                                                : 'Default'}
                                                                                </option>
                                                                                {choices
                                                                                        .filter(
                                                                                                (
                                                                                                        p,
                                                                                                ) =>
                                                                                                        p.id !==
                                                                                                        kpi
                                                                                                                ?.default_scoring_policy
                                                                                                                .id,
                                                                                        )
                                                                                        .map(
                                                                                                (
                                                                                                        p,
                                                                                                ) => (
                                                                                                        <option
                                                                                                                key={
                                                                                                                        p.id
                                                                                                                }
                                                                                                                value={
                                                                                                                        p.id
                                                                                                                }
                                                                                                        >
                                                                                                                {
                                                                                                                        p.name
                                                                                                                }
                                                                                                        </option>
                                                                                                ),
                                                                                        )}
                                                                        </select>
                                                                </Td>
                                                                <Td className="hidden min-w-40 xl:table-cell">
                                                                        <input
                                                                                aria-label={`Target note for KPI ${n}`}
                                                                                className={
                                                                                        inputClasses
                                                                                }
                                                                                maxLength={255}
                                                                                value={row.note}
                                                                                onChange={(e) =>
                                                                                        update(
                                                                                                index,
                                                                                                {
                                                                                                        note: e
                                                                                                                .target
                                                                                                                .value,
                                                                                                },
                                                                                        )
                                                                                }
                                                                        />
                                                                </Td>
                                                                <Td>
                                                                        <Button
                                                                                variant="ghost"
                                                                                aria-label={`Remove KPI ${n}`}
                                                                                onClick={() =>
                                                                                        onChange(
                                                                                                rows.filter(
                                                                                                        (
                                                                                                                _,
                                                                                                                i,
                                                                                                        ) =>
                                                                                                                i !==
                                                                                                                index,
                                                                                                ),
                                                                                        )
                                                                                }
                                                                        >
                                                                                <Trash2
                                                                                        aria-hidden="true"
                                                                                        className="size-4"
                                                                                />
                                                                        </Button>
                                                                </Td>
                                                        </tr>
                                                )
                                        })}
                                </TBody>
                                <tfoot className="border-t border-slate-200 bg-slate-50">
                                        <tr>
                                                <th
                                                        scope="row"
                                                        className="px-4 py-3 text-left text-sm font-semibold text-slate-900"
                                                >
                                                        Total
                                                </th>
                                                <td
                                                        className={`px-4 py-3 text-right text-sm font-semibold tabular-nums ${summary.complete ? 'text-emerald-800' : 'text-red-700'}`}
                                                >
                                                        {formatCents(summary.totalCents)}%
                                                </td>
                                                <td
                                                        colSpan={5}
                                                        className="px-4 py-3 text-sm text-slate-700"
                                                >
                                                        <span aria-live="polite">
                                                                {totalMessage(summary)}
                                                        </span>
                                                </td>
                                        </tr>
                                </tfoot>
                        </Table>
                        <div className="flex flex-wrap items-center gap-3">
                                <Button
                                        size="sm"
                                        disabled={count >= MAX_ITEMS || kpis.length === 0}
                                        onClick={() => onChange([...rows, newRow()])}
                                >
                                        <Plus aria-hidden="true" className="size-4" />
                                        Add KPI
                                </Button>
                                <p className="text-xs text-slate-600">
                                        3 to 5 KPIs are recommended (up to 8 is usual). Weightages
                                        use at most two decimals and must total exactly 100% to
                                        publish.
                                </p>
                        </div>
                </div>
        )
}

function CellError({ id, message }: { id: string; message: string | undefined }) {
        if (!message) return null
        return (
                <p id={id} className="mt-1 text-xs font-medium text-red-700">
                        {message}
                </p>
        )
}
