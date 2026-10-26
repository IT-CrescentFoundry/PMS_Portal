import type { InputHTMLAttributes, SelectHTMLAttributes } from 'react'
import { Badge } from '../../components/common/Badge'
import type { SelectOption } from '../../components/common/Fields'
import { inputClasses } from '../../components/common/styles'
import type { MatrixDataType, MatrixVersionStatus } from '../../types/api'
import { VERSION_STATUS } from './matrixLabels'

/** Dense input for grids; the accessible name comes from aria-label. */
export function CompactInput({
        className = '',
        ...rest
}: InputHTMLAttributes<HTMLInputElement> & { 'aria-label': string }) {
        return <input className={`${inputClasses} h-9 ${className}`} {...rest} />
}

export function CompactSelect({
        options,
        className = '',
        ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { options: SelectOption[]; 'aria-label': string }) {
        return (
                <select className={`${inputClasses} h-9 pr-8 ${className}`} {...rest}>
                        {options.map((option) => (
                                <option key={option.value} value={option.value}>
                                        {option.label}
                                </option>
                        ))}
                </select>
        )
}

export interface ValueField {
        dataType: MatrixDataType
        /** Allowed values of a category field. */
        allowed: string[]
}

/** The right control for one value of a field: number, date, category or yes/no. */
export function ValueInput({
        field,
        value,
        onChange,
        label,
        disabled,
}: {
        field: ValueField
        value: string
        onChange: (value: string) => void
        label: string
        disabled?: boolean
}) {
        if (field.dataType === 'CATEGORY' || field.dataType === 'BOOLEAN') {
                const choices =
                        field.dataType === 'BOOLEAN'
                                ? [
                                          { value: 'true', label: 'Yes' },
                                          { value: 'false', label: 'No' },
                                  ]
                                : field.allowed.map((v) => ({ value: v, label: v }))
                // A value that is no longer allowed stays visible instead of vanishing.
                const stale =
                        value !== '' && !choices.some((c) => c.value === value)
                                ? [{ value, label: `${value} (not allowed)` }]
                                : []
                return (
                        <CompactSelect
                                aria-label={label}
                                value={value}
                                disabled={disabled}
                                onChange={(e) => onChange(e.target.value)}
                                options={[{ value: '', label: '—' }, ...choices, ...stale]}
                        />
                )
        }
        return (
                <CompactInput
                        aria-label={label}
                        type={field.dataType === 'DATE' ? 'date' : 'text'}
                        inputMode={
                                field.dataType === 'DATE'
                                        ? undefined
                                        : field.dataType === 'INTEGER'
                                          ? 'numeric'
                                          : 'decimal'
                        }
                        value={value}
                        disabled={disabled}
                        onChange={(e) => onChange(e.target.value)}
                />
        )
}

export function MatrixStatusBadge({ status }: { status: MatrixVersionStatus }) {
        const { label, tone } = VERSION_STATUS[status]
        return <Badge tone={tone}>{label}</Badge>
}
