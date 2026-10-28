import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { LockKeyhole } from 'lucide-react'
import { PageHeader } from '../../components/common/PageHeader'
import { useAuth, useCurrentUser } from './AuthContext'
import { CheckingSession, ServiceUnavailable } from './FullPageStatus'
import {
        canReadAllocations,
        canReadAnnual,
        canReadBudget,
        canReadOrganization,
} from './permissions'

export interface LoginRedirectState {
        from?: string
        reason?: 'expired' | 'signed-out'
}

/**
 * Renders protected content only for a verified session. Nothing protected
 * is rendered (or fetched) while the session check is still in progress.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
        const { state, retrySessionCheck } = useAuth()
        const location = useLocation()

        if (state.status === 'checking') return <CheckingSession />
        if (state.status === 'unavailable') {
                return <ServiceUnavailable error={state.error} onRetry={retrySessionCheck} />
        }
        if (state.status === 'unauthenticated') {
                const redirectState: LoginRedirectState = {
                        from:
                                state.reason === 'signed-out'
                                        ? undefined
                                        : location.pathname + location.search,
                        reason: state.reason === 'initial' ? undefined : state.reason,
                }
                return <Navigate to="/login" replace state={redirectState} />
        }
        return children
}

/** Organization pages: shown only to users whose roles carry org:read. */
export function RequireOrgAccess() {
        const user = useCurrentUser()
        if (canReadOrganization(user)) return <Outlet />
        return <AccessDenied />
}

/** Annual results: only for users whose roles carry annual:read. */
export function RequireAnnualAccess() {
        const user = useCurrentUser()
        if (canReadAnnual(user)) return <Outlet />
        return <AccessDenied />
}

/** Compensation and budget: only for users whose roles carry budget:read. */
export function RequireBudgetAccess() {
        const user = useCurrentUser()
        if (canReadBudget(user)) return <Outlet />
        return <AccessDenied />
}

/** Budget distribution and increment allocations (the API limits each reader further). */
export function RequireAllocationAccess() {
        const user = useCurrentUser()
        if (canReadAllocations(user)) return <Outlet />
        return <AccessDenied />
}

export function AccessDenied() {
        return (
                <>
                        <PageHeader title="Access denied" />
                        <div
                                role="alert"
                                className="flex flex-col items-center gap-2 rounded-lg border border-slate-200 bg-white px-6 py-10 text-center shadow-sm"
                        >
                                <LockKeyhole aria-hidden="true" className="size-8 text-slate-500" />
                                <p className="font-semibold text-slate-900">
                                        You do not have access to this page
                                </p>
                                <p className="max-w-prose text-sm text-slate-600">
                                        Your account is not assigned to any plant or department for
                                        organizational data. Contact your PMS administrator if you
                                        need access.
                                </p>
                        </div>
                </>
        )
}
