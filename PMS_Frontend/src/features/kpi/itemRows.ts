/** Editable KPI sheet rows (text as typed) and their validation. */
import type { Kpi, SheetItem, SheetItemInput } from '../../types/api'
import { weightageError, weightageText } from './weightage'

export interface ItemRow {
        /** Stable React key for the row. */
        key: string
        kpiId: string
        weightage: string
        target: string
        note: string
        /** Blank = the KPI's unit. */
        unit: string
        /** Blank = the KPI's default scoring rule. */
        policyId: string
}

let nextKey = 0
export function newRow(partial: Partial<ItemRow> = {}): ItemRow {
        nextKey += 1
        return {
                key: `row-${nextKey}`,
                kpiId: '',
                weightage: '',
                target: '',
                note: '',
                unit: '',
                policyId: '',
                ...partial,
        }
}

export function rowsFromItems(items: SheetItem[]): ItemRow[] {
        return items.map((item) =>
                newRow({
                        kpiId: String(item.kpi.id),
                        weightage: weightageText(item.weightage),
                        target: item.target_value === null ? '' : String(item.target_value),
                        note: item.target_note ?? '',
                        unit: item.unit,
                        policyId: String(item.scoring_policy.id),
                }),
        )
}

const TARGET = /^\d{1,14}(\.\d{1,4})?$/

export type RowErrors = Partial<Record<'kpi' | 'weightage' | 'target', string>>

/** Problems per row (same rules as the API, which re-checks everything). */
export function validateRows(
        rows: ItemRow[],
        kpis: Map<number, Pick<Kpi, 'direction'>>,
): RowErrors[] {
        const seen = new Set<string>()
        return rows.map((row) => {
                const errors: RowErrors = {}
                if (row.kpiId === '') errors.kpi = 'Choose a KPI.'
                else if (seen.has(row.kpiId)) errors.kpi = 'This KPI is already on the sheet.'
                seen.add(row.kpiId)
                const weightage = weightageError(row.weightage)
                if (weightage) errors.weightage = weightage
                const kpi = kpis.get(Number(row.kpiId))
                if (kpi && kpi.direction !== 'ZERO_TOLERANCE') {
                        const target = row.target.trim()
                        if (!TARGET.test(target) || Number(target) <= 0)
                                errors.target =
                                        'Enter the quarterly target (more than 0, up to 4 decimals).'
                }
                return errors
        })
}

export function hasRowErrors(errors: RowErrors[]): boolean {
        return errors.some((e) => Object.keys(e).length > 0)
}

export function rowsToInput(
        rows: ItemRow[],
        kpis: Map<number, Pick<Kpi, 'direction'>>,
): SheetItemInput[] {
        return rows.map((row) => {
                const zero = kpis.get(Number(row.kpiId))?.direction === 'ZERO_TOLERANCE'
                return {
                        kpi_definition_id: Number(row.kpiId),
                        weightage: row.weightage.trim(),
                        target_value: zero ? null : row.target.trim() || null,
                        target_note: row.note.trim() || null,
                        unit: row.unit.trim() || null,
                        scoring_policy_id: row.policyId ? Number(row.policyId) : null,
                }
        })
}
