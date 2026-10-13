import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiError, isAbortError, setUnauthorizedHandler } from '../../services/apiClient'
import * as authApi from '../../services/authApi'
import { AuthContext, SessionNotPersistedError, type AuthState } from './AuthContext'

function toUnavailable(error: unknown): AuthState {
        const apiError =
                error instanceof ApiError
                        ? error
                        : new ApiError('network', null, 'The session could not be verified.')
        return { status: 'unavailable', error: apiError }
}

/**
 * Owns the browser session. The session itself lives in the HttpOnly cookie;
 * this provider only keeps the signed-in user's profile in memory.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
        const [state, setState] = useState<AuthState>({ status: 'checking' })
        const [checkCount, setCheckCount] = useState(0)

        // Restore an existing session on start-up (and on "Retry").
        useEffect(() => {
                const controller = new AbortController()
                authApi.getCurrentUser(controller.signal).then(
                        (user) => setState({ status: 'authenticated', user }),
                        (error: unknown) => {
                                if (controller.signal.aborted || isAbortError(error)) return
                                if (error instanceof ApiError && error.status === 401) {
                                        setState({ status: 'unauthenticated', reason: 'initial' })
                                } else {
                                        setState(toUnavailable(error))
                                }
                        },
                )
                return () => controller.abort()
        }, [checkCount])

        // Any protected request answered with 401 means the session has ended.
        useEffect(
                () =>
                        setUnauthorizedHandler(() =>
                                setState((current) =>
                                        current.status === 'authenticated'
                                                ? { status: 'unauthenticated', reason: 'expired' }
                                                : current,
                                ),
                        ),
                [],
        )

        const login = useCallback(async (username: string, password: string) => {
                await authApi.login(username, password)
                // Confirm the browser actually stored and sends the session cookie.
                let user
                try {
                        user = await authApi.getCurrentUser()
                } catch (error) {
                        if (error instanceof ApiError && error.status === 401) throw new SessionNotPersistedError()
                        throw error
                }
                setState({ status: 'authenticated', user })
        }, [])

        const logout = useCallback(async () => {
                await authApi.logout() // throws on network failure: state is left untouched
                setState({ status: 'unauthenticated', reason: 'signed-out' })
        }, [])

        const retrySessionCheck = useCallback(() => {
                setState({ status: 'checking' })
                setCheckCount((count) => count + 1)
        }, [])

        const value = useMemo(
                () => ({ state, login, logout, retrySessionCheck }),
                [state, login, logout, retrySessionCheck],
        )
        return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
