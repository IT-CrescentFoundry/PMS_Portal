import { useState, type FormEvent } from 'react'
import { Button } from './Button'
import { TextAreaField } from './Fields'
import { cardClasses } from './styles'

interface ReasonFormProps {
        /** e.g. "Reason for returning this JD" */
        label: string
        hint?: string
        submitLabel: string
        minLength?: number
        busy?: boolean
        tone?: 'primary' | 'danger'
        onSubmit: (reason: string) => void
        onCancel: () => void
}

/** Inline form for actions that must record a reason (return, reopen, reject). */
export function ReasonForm({
        label,
        hint,
        submitLabel,
        minLength = 1,
        busy = false,
        tone = 'primary',
        onSubmit,
        onCancel,
}: ReasonFormProps) {
        const [reason, setReason] = useState('')
        const [touched, setTouched] = useState(false)
        const trimmed = reason.trim()
        const error =
                touched && trimmed.length < minLength
                        ? minLength > 1
                                ? `Enter at least ${minLength} characters.`
                                : 'Enter a reason.'
                        : undefined

        function handleSubmit(event: FormEvent) {
                event.preventDefault()
                setTouched(true)
                if (trimmed.length >= minLength) onSubmit(trimmed)
        }

        return (
                <form onSubmit={handleSubmit} noValidate className={`${cardClasses} space-y-3 p-4`}>
                        <TextAreaField
                                label={label}
                                hint={hint}
                                error={error}
                                value={reason}
                                maxLength={1000}
                                required
                                autoFocus
                                onChange={(event) => setReason(event.target.value)}
                        />
                        <div className="flex flex-wrap gap-2">
                                <Button
                                        type="submit"
                                        variant={tone === 'danger' ? 'danger' : 'primary'}
                                        isLoading={busy}
                                >
                                        {submitLabel}
                                </Button>
                                <Button variant="ghost" onClick={onCancel} disabled={busy}>
                                        Cancel
                                </Button>
                        </div>
                </form>
        )
}
