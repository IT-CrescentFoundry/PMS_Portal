import type { CurrentUser, LoginResponse } from '../types/api'
import { apiRequest } from './apiClient'

/** Browser login: the API sets the HttpOnly session cookie; no token is returned. */
export function login(username: string, password: string): Promise<LoginResponse> {
        return apiRequest<LoginResponse>('/api/auth/login', {
                method: 'POST',
                body: { username, password },
                // A 401 here means "wrong credentials", not "session expired".
                skipUnauthorizedHandler: true,
        })
}

/** The signed-in user; rejects with ApiError(401) when there is no valid session. */
export function getCurrentUser(signal?: AbortSignal): Promise<CurrentUser> {
        return apiRequest<CurrentUser>('/api/auth/me', { signal, skipUnauthorizedHandler: true })
}

export function logout(): Promise<void> {
        return apiRequest<void>('/api/auth/logout', {
                method: 'POST',
                skipUnauthorizedHandler: true,
        })
}
