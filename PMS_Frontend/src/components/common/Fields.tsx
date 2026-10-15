import {
        useId,
        type InputHTMLAttributes,
        type ReactNode,
        type SelectHTMLAttributes,
        type TextareaHTMLAttributes,
} from 'react'
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
        error?: string
}

export function SelectField({
        label,
        options,
        hint,
        error,
        id,
        className = '',
        ...rest
}: SelectFieldProps) {
        const generatedId = useId()
        const fieldId = id ?? generatedId
        const describedBy = error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined
        return (
                <FieldShell id={fieldId} label={label} hint={hint} error={error}>
                        <select
                                id={fieldId}
                                className={`${inputClasses} pr-8 ${className}`}
                                aria-invalid={error ? true : undefined}
                                aria-describedby={describedBy}
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

interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
        label: string
        hint?: ReactNode
        error?: string
}

export function TextAreaField({
        label,
        hint,
        error,
        id,
        className = '',
        rows = 3,
        ...rest
}: TextAreaFieldProps) {
        const generatedId = useId()
        const fieldId = id ?? generatedId
        const describedBy = error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined
        return (
                <FieldShell id={fieldId} label={label} hint={hint} error={error}>
                        <textarea
                                id={fieldId}
                                rows={rows}
                                className={`${inputClasses} h-auto py-2 ${className}`}
                                aria-invalid={error ? true : undefined}
                                aria-describedby={describedBy}
                                {...rest}
                        />
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
