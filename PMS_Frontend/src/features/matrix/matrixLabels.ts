import type { BadgeTone } from '../../components/common/Badge'
import type {
        MatrixAggregation,
        MatrixDataType,
        MatrixField,
        MatrixValue,
        MatrixVersionSource,
        MatrixVersionStatus,
} from '../../types/api'
import { formatDate } from '../../utils/format'

export const VERSION_STATUS: Record<MatrixVersionStatus, { label: string; tone: BadgeTone }> = {
        DRAFT: { label: 'Draft', tone: 'warning' },
        SUBMITTED: { label: 'Awaiting CHRO approval', tone: 'info' },
        APPROVED: { label: 'Approved · not yet published', tone: 'brand' },
        REJECTED: { label: 'Rejected', tone: 'danger' },
        PUBLISHED: { label: 'Published', tone: 'success' },
        SUPERSEDED: { label: 'Superseded', tone: 'neutral' },
}

export const VERSION_SOURCE: Record<MatrixVersionSource, string> = {
        PORTAL: 'Portal',
        UPLOAD: 'Excel upload',
        SEED: 'Synthetic demo data',
}

/** How the monthly values of an imported input combine into the quarter. */
export const MATRIX_AGGREGATION_LABELS: Record<MatrixAggregation, string> = {
        SUM: 'Sum of the months',
        AVERAGE: 'Average of the months',
        MIN: 'Lowest month',
        MAX: 'Highest month',
        FIRST: 'First month',
        LAST: 'Latest month',
        ANY: 'Yes if any month is yes',
        ALL: 'Yes only if every month is yes',
}

/** Fallback when type metadata is not at hand (the API sends its own labels). */
export const DATA_TYPE_LABELS: Record<MatrixDataType, string> = {
        DECIMAL: 'Number',
        INTEGER: 'Whole number',
        PERCENT: 'Percentage',
        CATEGORY: 'Category',
        BOOLEAN: 'Yes / No',
        DATE: 'Date',
}

/** "100 %", "Yes", "—" */
export function formatMatrixValue(
        field: Pick<MatrixField, 'data_type' | 'unit'> | undefined,
        value: MatrixValue | undefined,
): string {
        if (value === null || value === undefined || value === '') return '—'
        if (typeof value === 'boolean') return value ? 'Yes' : 'No'
        if (field?.data_type === 'BOOLEAN') {
                const text = String(value).toLowerCase()
                if (['true', 'yes', 'y', '1'].includes(text)) return 'Yes'
                if (['false', 'no', 'n', '0'].includes(text)) return 'No'
        }
        if (field?.data_type === 'DATE') return formatDate(String(value))
        const unit = field?.unit ?? ''
        if (!unit) return String(value)
        return unit === '%' ? `${value}%` : `${value} ${unit}`
}

/** "1 Apr 2026 onwards", "1 Apr 2026 – 31 Mar 2027", "No date set" */
export function effectiveLabel(version: {
        effective_from: string | null
        effective_to: string | null
}): string {
        if (!version.effective_from) return 'No date set'
        if (!version.effective_to) return `${formatDate(version.effective_from)} onwards`
        return `${formatDate(version.effective_from)} – ${formatDate(version.effective_to)}`
}

/** Where a validation problem is, from its path ("rules[1].conditions.x" -> "Rule row 2"). */
export function problemLocation(path: string): string {
        const indexed = /^(fields|rules|test_cases)\[(\d+)\]/.exec(path)
        if (indexed) {
                const n = Number(indexed[2]) + 1
                return indexed[1] === 'fields'
                        ? `Field ${n}`
                        : indexed[1] === 'rules'
                          ? `Rule row ${n}`
                          : `Test case ${n}`
        }
        const top = path.split('.')[0]
        const names: Record<string, string> = {
                fields: 'Fields',
                rules: 'Rules',
                test_cases: 'Test cases',
                no_match: 'When no rule matches',
                effective_from: 'Effective from',
                applicability: 'Applies to',
                schema_version: 'Schema version',
        }
        return names[top] ?? 'Configuration'
}

/** Human label of a lineage attribute value, e.g. the scoring direction. */
export function attributeValueLabel(value: string): string {
        const words = value.toLowerCase().split('_').join(' ')
        return words.charAt(0).toUpperCase() + words.slice(1)
}

/** "Score: 4, Band: A" for a set of values keyed by field. */
export function describeValues(
        fields: MatrixField[],
        values: Record<string, MatrixValue> | null,
): string {
        if (values === null) return '—'
        const parts = Object.entries(values).map(([key, value]) => {
                const field = fields.find((f) => f.key === key)
                return `${field?.label ?? key}: ${formatMatrixValue(field, value)}`
        })
        return parts.join(', ') || '—'
}
