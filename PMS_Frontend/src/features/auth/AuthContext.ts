import { createContext, useContext } from 'react'
import type { ApiError } from '../../services/apiClient'
import type { CurrentUser } from '../../types/api'

export type SignedOutReason = 'initial' | 'signed-out' | 'expired'

export type AuthState =
        | { status: 'checking' }
        | { status: 'authenticated'; user: CurrentUser }
        | { status: 'unauthenticated'; reason: SignedOutReason }
        /** The session could not be verified because the server was unreachable/failing. */
        | { status: 'unavailable'; error: ApiError }

export interface AuthContextValue {
        state: AuthState
        /** Throws ApiError (e.g. 401 wrong credentials) or SessionNotPersistedError. */
        login: (username: string, password: string) => Promise<void>
        /** Throws if the server could not be reached; the user then stays signed in locally. */
        logout: () => Promise<void>
        /** Re-check the session after an "unavailable" state. */
        retrySessionCheck: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
        const value = useContext(AuthContext)
        if (value === null) throw new Error('useAuth must be used inside <AuthProvider>')
        return value
}

/** Signed in, but the user object is only available in the authenticated state. */
export function useCurrentUser(): CurrentUser {
        const { state } = useAuth()
        if (state.status !== 'authenticated') {
                throw new Error('useCurrentUser must be used inside an authenticated route')
        }
        return state.user
}

/**
 * Login succeeded, yet the follow-up session check failed with 401: the
 * browser did not store or send the session cookie (most often because the
 * page was opened via 127.0.0.1 instead of localhost).
 */
export class SessionNotPersistedError extends Error {
        constructor() {
                super(
                        'You were signed in, but your browser did not keep the session. ' +
                                'Open the portal at http://localhost:5173 (not 127.0.0.1) and allow cookies for this site.',
                )
                this.name = 'SessionNotPersistedError'
        }
}
