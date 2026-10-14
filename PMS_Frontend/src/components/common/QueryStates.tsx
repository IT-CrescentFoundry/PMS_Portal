import { Inbox, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from './Button'
import { describeError } from './errorDescription'
import { Spinner } from './Spinner'
import { cardClasses } from './styles'

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
        return (
                <div
                        role="status"
                        className={`${cardClasses} flex items-center justify-center gap-3 px-6 py-12 text-sm text-slate-600`}
                >
                        <Spinner />
                        <span>{label}</span>
                </div>
        )
}

export function EmptyState({
        title,
        children,
        action,
}: {
        title: string
        children?: ReactNode
        action?: ReactNode
}) {
        return (
                <div
                        className={`${cardClasses} flex flex-col items-center gap-2 px-6 py-12 text-center`}
                >
                        <Inbox aria-hidden="true" className="size-8 text-slate-400" />
                        <p className="font-semibold text-slate-800">{title}</p>
                        {children && (
                                <div className="max-w-prose text-sm text-slate-600">{children}</div>
                        )}
                        {action && <div className="pt-2">{action}</div>}
                </div>
        )
}

export function ErrorState({
        error,
        onRetry,
        action,
}: {
        error: unknown
        onRetry?: () => void
        /** Extra recovery action, e.g. a link back to a list. */
        action?: ReactNode
}) {
        const { title, message, icon: Icon, retryable } = describeError(error)
        const showRetry = retryable && onRetry !== undefined
        return (
                <div
                        role="alert"
                        className={`${cardClasses} flex flex-col items-center gap-2 px-6 py-10 text-center`}
                >
                        <Icon aria-hidden="true" className="size-8 text-slate-500" />
                        <p className="font-semibold text-slate-900">{title}</p>
                        <p className="max-w-prose text-sm text-slate-600">{message}</p>
                        {(showRetry || action) && (
                                <div className="flex flex-wrap justify-center gap-2 pt-2">
                                        {showRetry && (
                                                <Button onClick={onRetry} variant="secondary">
                                                        <RefreshCw
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                        Retry
                                                </Button>
                                        )}
                                        {action}
                                </div>
                        )}
                </div>
        )
}
