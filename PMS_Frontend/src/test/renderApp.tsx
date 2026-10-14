import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { AppRoutes } from '../app/AppRoutes'
import { AuthProvider } from '../features/auth/AuthProvider'

/** Render the real application (routes, session, layout) at `path`. */
export function renderApp(path = '/') {
        const user = userEvent.setup()
        const result = render(
                <MemoryRouter initialEntries={[path]}>
                        <AuthProvider>
                                <AppRoutes />
                        </AuthProvider>
                </MemoryRouter>,
        )
        return { user, ...result }
}
