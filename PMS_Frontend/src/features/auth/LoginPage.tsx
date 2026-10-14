import { Eye, EyeOff, LogIn } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { Alert } from '../../components/common/Alert'
import { Button } from '../../components/common/Button'
import { describeError } from '../../components/common/errorDescription'
import { TextField } from '../../components/common/Fields'
import { APP_NAME } from '../../config'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { ApiError } from '../../services/apiClient'
import { SessionNotPersistedError, useAuth } from './AuthContext'
import { CheckingSession, ServiceUnavailable } from './FullPageStatus'
import { safeReturnPath } from './permissions'
import type { LoginRedirectState } from './RequireAuth'

interface FieldErrors {
        username?: string
        password?: string
}

function validate(username: string, password: string): FieldErrors {
        const errors: FieldErrors = {}
        if (!username.trim()) errors.username = 'Enter your username.'
        if (!password) errors.password = 'Enter your password.'
        return errors
}

function loginErrorMessage(error: unknown): string {
        if (error instanceof SessionNotPersistedError) return error.message
        if (error instanceof ApiError && error.status === 401) {
                return 'The username or password is incorrect, or the account is inactive.'
        }
        if (error instanceof ApiError && error.status === 422)
                return 'Check your username and password.'
        return describeError(error).message
}

export function LoginPage() {
        useDocumentTitle('Sign in')
        const { state, login, retrySessionCheck } = useAuth()
        const location = useLocation()
        const navigate = useNavigate()
        const redirect = (location.state ?? {}) as LoginRedirectState
        const returnTo = safeReturnPath(redirect.from)

        const [username, setUsername] = useState('')
        const [password, setPassword] = useState('')
        const [showPassword, setShowPassword] = useState(false)
        const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
        const [formError, setFormError] = useState<string | null>(null)
        const [submitting, setSubmitting] = useState(false)

        if (state.status === 'checking') return <CheckingSession />
        if (state.status === 'unavailable') {
                return <ServiceUnavailable error={state.error} onRetry={retrySessionCheck} />
        }
        if (state.status === 'authenticated' && !submitting) {
                return <Navigate to={returnTo} replace />
        }

        async function handleSubmit(event: FormEvent<HTMLFormElement>) {
                event.preventDefault()
                if (submitting) return
                const errors = validate(username, password)
                setFieldErrors(errors)
                setFormError(null)
                if (errors.username || errors.password) return

                setSubmitting(true)
                try {
                        await login(username.trim(), password)
                        navigate(returnTo, { replace: true })
                } catch (error) {
                        setFormError(loginErrorMessage(error))
                        setPassword('')
                        setSubmitting(false)
                }
        }

        return (
                <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10">
                        <div className="w-full max-w-sm space-y-6">
                                <div className="space-y-2 text-center">
                                        <span
                                                aria-hidden="true"
                                                className="mx-auto flex size-10 items-center justify-center rounded-lg bg-brand-700 text-lg font-bold text-white"
                                        >
                                                P
                                        </span>
                                        <h1 className="text-2xl font-semibold text-slate-900">
                                                Sign in to {APP_NAME}
                                        </h1>
                                        <p className="text-sm text-slate-600">
                                                Performance Management System for HR, department
                                                heads and management.
                                        </p>
                                </div>

                                {redirect.reason === 'expired' && !formError && (
                                        <Alert tone="warning" title="Your session has expired">
                                                Please sign in again to continue.
                                        </Alert>
                                )}
                                {redirect.reason === 'signed-out' && !formError && (
                                        <Alert tone="info">You have been signed out.</Alert>
                                )}
                                {formError && (
                                        <Alert tone="danger" title="Sign-in failed" assertive>
                                                {formError}
                                        </Alert>
                                )}

                                <form
                                        noValidate
                                        onSubmit={handleSubmit}
                                        className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
                                >
                                        <TextField
                                                label="Username"
                                                name="username"
                                                autoComplete="username"
                                                autoCapitalize="none"
                                                spellCheck={false}
                                                value={username}
                                                onChange={(event) =>
                                                        setUsername(event.target.value)
                                                }
                                                error={fieldErrors.username}
                                                disabled={submitting}
                                                required
                                        />
                                        <div className="space-y-1">
                                                <div className="relative">
                                                        <TextField
                                                                label="Password"
                                                                name="password"
                                                                type={
                                                                        showPassword
                                                                                ? 'text'
                                                                                : 'password'
                                                                }
                                                                autoComplete="current-password"
                                                                value={password}
                                                                onChange={(event) =>
                                                                        setPassword(
                                                                                event.target.value,
                                                                        )
                                                                }
                                                                error={fieldErrors.password}
                                                                disabled={submitting}
                                                                className="pr-11"
                                                                required
                                                        />
                                                        <button
                                                                type="button"
                                                                onClick={() =>
                                                                        setShowPassword(
                                                                                (shown) => !shown,
                                                                        )
                                                                }
                                                                aria-label={
                                                                        showPassword
                                                                                ? 'Hide password'
                                                                                : 'Show password'
                                                                }
                                                                aria-pressed={showPassword}
                                                                className="absolute top-7 right-1 flex size-9 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100"
                                                        >
                                                                {showPassword ? (
                                                                        <EyeOff
                                                                                aria-hidden="true"
                                                                                className="size-4"
                                                                        />
                                                                ) : (
                                                                        <Eye
                                                                                aria-hidden="true"
                                                                                className="size-4"
                                                                        />
                                                                )}
                                                        </button>
                                                </div>
                                        </div>
                                        <Button
                                                type="submit"
                                                variant="primary"
                                                className="w-full"
                                                isLoading={submitting}
                                        >
                                                {!submitting && (
                                                        <LogIn
                                                                aria-hidden="true"
                                                                className="size-4"
                                                        />
                                                )}
                                                {submitting ? 'Signing in…' : 'Sign in'}
                                        </Button>
                                </form>
                                <p className="text-center text-xs text-slate-500">
                                        For security, sessions expire after a fixed time and you
                                        will be asked to sign in again.
                                </p>
                        </div>
                </main>
        )
}
