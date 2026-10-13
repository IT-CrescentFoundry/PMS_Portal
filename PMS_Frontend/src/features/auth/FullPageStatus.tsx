import { RefreshCw, WifiOff } from 'lucide-react'
import { Button } from '../../components/common/Button'
import { describeError } from '../../components/common/errorDescription'
import { Spinner } from '../../components/common/Spinner'
import { APP_NAME } from '../../config'
import type { ApiError } from '../../services/apiClient'

export function CheckingSession() {
        return (
                <div role="status" className="flex min-h-screen items-center justify-center gap-3 text-slate-600">
                        <Spinner />
                        <span>Checking your session…</span>
                </div>
        )
}

/** The session could not be verified because the API is unreachable or failing. */
export function ServiceUnavailable({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
        const { message } = describeError(error)
        return (
                <main className="flex min-h-screen items-center justify-center px-4">
                        <div
                                role="alert"
                                className="w-full max-w-md space-y-3 rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm"
                        >
                                <WifiOff aria-hidden="true" className="mx-auto size-8 text-slate-500" />
                                <h1 className="text-lg font-semibold text-slate-900">{APP_NAME} is unavailable</h1>
                                <p className="text-sm text-slate-600">{message}</p>
                                <p className="text-sm text-slate-600">
                                        Your session was not checked, so you have not been signed out.
                                </p>
                                <Button variant="primary" onClick={onRetry}>
                                        <RefreshCw aria-hidden="true" className="size-4" />
                                        Retry
                                </Button>
                        </div>
                </main>
        )
}
