import { CircleAlert, LockKeyhole, SearchX, WifiOff, type LucideIcon } from 'lucide-react'
import { ApiError } from '../../services/apiClient'

export interface ErrorDescription {
        title: string
        message: string
        icon: LucideIcon
        retryable: boolean
}

/** Map any thrown value to safe, user-facing wording (no internals). */
export function describeError(error: unknown): ErrorDescription {
        if (!(error instanceof ApiError)) {
                return {
                        title: 'Something went wrong',
                        message: 'An unexpected problem occurred. Please try again.',
                        icon: CircleAlert,
                        retryable: true,
                }
        }
        if (error.kind === 'network') {
                return { title: 'Server unreachable', message: error.message, icon: WifiOff, retryable: true }
        }
        if (error.kind === 'timeout') {
                return { title: 'Request timed out', message: error.message, icon: WifiOff, retryable: true }
        }
        switch (error.status) {
                case 401:
                        return { title: 'Session expired', message: error.message, icon: LockKeyhole, retryable: false }
                case 403:
                        return { title: 'Access denied', message: error.message, icon: LockKeyhole, retryable: false }
                case 404:
                        return { title: 'Not available', message: error.message, icon: SearchX, retryable: false }
                case 422: {
                        const details = error.fieldErrors.map((f) => (f.field ? `${f.field}: ${f.message}` : f.message))
                        return {
                                title: 'Invalid filter',
                                message: [error.message, ...details].join(' '),
                                icon: CircleAlert,
                                retryable: false,
                        }
                }
                default:
                        return {
                                title: error.isRetryable ? 'Service problem' : 'Request failed',
                                message: error.message,
                                icon: CircleAlert,
                                retryable: error.isRetryable,
                        }
        }
}