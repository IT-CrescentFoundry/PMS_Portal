import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'
import { inputClasses } from './styles'

interface FieldShellProps {
        id: string
        label: string
        hint?: ReactNode
        error?: string
        children: ReactNode
}

function FieldShell({ id, label, hint, error, children }: FieldShellProps) {
        return (
                <div className="space-y-1">
                        <label htmlFor={id} className="block text-sm font-medium text-slate-800">
                                {label}
                        </label>
                        {children}
                        {hint && !error && (
                                <p id={`${id}-hint`} className="text-xs text-slate-600">
                                        {hint}
                                </p>
                        )}
                        {error && (
                                <p id={`${id}-error`} className="text-xs font-medium text-red-700">
                                        {error}
                                </p>
                        )}
                </div>
        )
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
        label: string
        hint?: ReactNode
        error?: string
}

export function TextField({ label, hint, error, id, className = '', ...rest }: TextFieldProps) {
        const generatedId = useId()
        const fieldId = id ?? generatedId
        const describedBy = error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined
        return (
                <FieldShell id={fieldId} label={label} hint={hint} error={error}>
                        <input
                                id={fieldId}
                                className={`${inputClasses} ${className}`}
                                aria-invalid={error ? true : undefined}
                                aria-describedby={describedBy}
                                {...rest}
                        />
                </FieldShell>
        )
}

export interface SelectOption {
        value: string
        label: string
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
        label: string
        options: SelectOption[]
        hint?: ReactNode
}

export function SelectField({
        label,
        options,
        hint,
        id,
        className = '',
        ...rest
}: SelectFieldProps) {
        const generatedId = useId()
        const fieldId = id ?? generatedId
        return (
                <FieldShell id={fieldId} label={label} hint={hint}>
                        <select
                                id={fieldId}
                                className={`${inputClasses} pr-8 ${className}`}
                                aria-describedby={hint ? `${fieldId}-hint` : undefined}
                                {...rest}
                        >
                                {options.map((option) => (
                                        <option key={option.value} value={option.value}>
                                                {option.label}
                                        </option>
                                ))}
                        </select>
                </FieldShell>
        )
}

interface CheckboxFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
        label: string
}

export function CheckboxField({ label, id, ...rest }: CheckboxFieldProps) {
        const generatedId = useId()
        const fieldId = id ?? generatedId
        return (
                <div className="flex items-center gap-2">
                        <input
                                id={fieldId}
                                type="checkbox"
                                className="size-4 rounded border-slate-400 accent-brand-700"
                                {...rest}
                        />
                        <label htmlFor={fieldId} className="text-sm text-slate-800">
                                {label}
                        </label>
                </div>
        )
}
