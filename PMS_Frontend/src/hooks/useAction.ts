import { useCallback, useRef, useState } from 'react'

export interface Action {
        /** A request is in flight; buttons should show a spinner and be disabled. */
        busy: boolean
        /** Failure of the latest run, for <ActionError />. */
        error: unknown
        /**
         * Run one change (save, sign-off, upload). A second call while one is in
         * flight is ignored, so a double click cannot submit twice. Resolves to
         * the result, or undefined when it failed (the error is then in `error`).
         */
        run: <T>(change: () => Promise<T>) => Promise<T | undefined>
        clearError: () => void
}

export function useAction(): Action {
        const [busy, setBusy] = useState(false)
        const [error, setError] = useState<unknown>(undefined)
        const inFlight = useRef(false)

        const run = useCallback(async <T>(change: () => Promise<T>) => {
                if (inFlight.current) return undefined
                inFlight.current = true
                setBusy(true)
                setError(undefined)
                try {
                        return await change()
                } catch (failure) {
                        setError(failure)
                        return undefined
                } finally {
                        inFlight.current = false
                        setBusy(false)
                }
        }, [])

        const clearError = useCallback(() => setError(undefined), [])
        return { busy, error, run, clearError }
}
