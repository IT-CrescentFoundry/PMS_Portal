import { LogOut, Menu, X } from 'lucide-react'
import { useState } from 'react'
import { Outlet, useLocation } from 'react-router'
import { useAuth, useCurrentUser } from '../../features/auth/AuthContext'
import { displayName, roleSummary } from '../../features/auth/permissions'
import { Alert } from '../common/Alert'
import { Button } from '../common/Button'
import { describeError } from '../common/errorDescription'
import { buildNavigation, sectionTitle } from './navigation'
import { Sidebar } from './Sidebar'

/** Authenticated shell: sidebar navigation, header and the routed page. */
export function AppLayout() {
        const user = useCurrentUser()
        const { logout } = useAuth()
        const { pathname } = useLocation()
        const [navOpen, setNavOpen] = useState(false)
        const [signingOut, setSigningOut] = useState(false)
        const [signOutError, setSignOutError] = useState<string | null>(null)
        const groups = buildNavigation(user)

        async function handleSignOut() {
                setSigningOut(true)
                setSignOutError(null)
                try {
                        await logout() // on success the session guard redirects to /login
                } catch (error) {
                        // The server may not have cleared the cookie, so we must not claim
                        // the user is signed out.
                        setSignOutError(describeError(error).message)
                        setSigningOut(false)
                }
        }

        return (
                <div className="min-h-screen">
                        <a
                                href="#main-content"
                                className="sr-only z-50 rounded-md bg-white px-4 py-2 text-sm font-medium text-brand-800 shadow focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
                        >
                                Skip to main content
                        </a>

                        {/* Desktop sidebar */}
                        <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-slate-200 bg-white lg:block">
                                <Sidebar groups={groups} />
                        </aside>

                        {/* Mobile drawer */}
                        {navOpen && (
                                <div className="fixed inset-0 z-40 lg:hidden">
                                        <button
                                                type="button"
                                                aria-label="Close navigation"
                                                className="absolute inset-0 bg-slate-900/40"
                                                onClick={() => setNavOpen(false)}
                                        />
                                        <aside
                                                id="mobile-navigation"
                                                className="absolute inset-y-0 left-0 w-64 max-w-[85%] bg-white shadow-xl"
                                                onKeyDown={(event) => {
                                                        if (event.key === 'Escape') setNavOpen(false)
                                                }}
                                        >
                                                <button
                                                        type="button"
                                                        autoFocus
                                                        aria-label="Close navigation"
                                                        className="absolute top-3 right-3 rounded-md p-1.5 text-slate-600 hover:bg-slate-100"
                                                        onClick={() => setNavOpen(false)}
                                                >
                                                        <X aria-hidden="true" className="size-5" />
                                                </button>
                                                <Sidebar groups={groups} onNavigate={() => setNavOpen(false)} />
                                        </aside>
                                </div>
                        )}

                        <div className="lg:pl-60">
                                <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur sm:px-6">
                                        <button
                                                type="button"
                                                className="-ml-1 rounded-md p-1.5 text-slate-700 hover:bg-slate-100 lg:hidden"
                                                aria-label="Open navigation"
                                                aria-expanded={navOpen}
                                                aria-controls="mobile-navigation"
                                                onClick={() => setNavOpen(true)}
                                        >
                                                <Menu aria-hidden="true" className="size-5" />
                                        </button>
                                        <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">
                                                {sectionTitle(pathname)}
                                        </p>
                                        <div className="hidden min-w-0 text-right sm:block">
                                                <p className="truncate text-sm font-medium text-slate-900">{displayName(user)}</p>
                                                <p className="truncate text-xs text-slate-600">{roleSummary(user)}</p>
                                        </div>
                                        <Button variant="ghost" size="sm" onClick={handleSignOut} isLoading={signingOut}>
                                                {!signingOut && <LogOut aria-hidden="true" className="size-4" />}
                                                Sign out
                                        </Button>
                                </header>

                                <main id="main-content" tabIndex={-1} className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
                                        {signOutError && (
                                                <div className="mb-4">
                                                        <Alert
                                                                tone="danger"
                                                                title="Sign-out could not be confirmed"
                                                                assertive
                                                                action={
                                                                        <Button size="sm" onClick={handleSignOut} isLoading={signingOut}>
                                                                                Try again
                                                                        </Button>
                                                                }
                                                        >
                                                                {signOutError} You may still be signed in on this device.
                                                        </Alert>
                                                </div>
                                        )}
                                        <Outlet />
                                </main>
                        </div>
                </div>
        )
}