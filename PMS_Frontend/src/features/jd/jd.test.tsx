import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { adminUser, headcountReport, plants, units } from '../../test/fixtures'
import {
        deptHeadUser,
        hrHeadUser,
        jdDetail,
        jdVersion,
        plantHeadUser,
} from '../../test/kpiFixtures'
import { installMockApi, reply } from '../../test/mockApi'
import { renderApp } from '../../test/renderApp'
import type { CurrentUser } from '../../types/api'
import { contentFromForm, emptyForm, validateForm } from './jdForm'

function setupDetail(me: CurrentUser) {
        return installMockApi({
                'GET /api/auth/me': reply(200, me),
                'GET /api/jds/5': reply(200, jdDetail),
                'GET /api/jds/5/versions/50': reply(200, jdVersion()),
        })
}

describe('JD sign-off', () => {
        it('shows the full current-format content and the sign-off trail', async () => {
                setupDetail(deptHeadUser)
                renderApp('/jds/5')
                expect(
                        await screen.findByRole('heading', {
                                name: 'Quality Engineer — Inspection',
                        }),
                ).toBeInTheDocument()
                const signOff = screen.getByRole('region', { name: 'Sign-off' })
                expect(within(signOff).getByText('Proposed by HOD')).toBeInTheDocument()
                expect(within(signOff).getByText('test.depthead, 1 Aug 2026')).toBeInTheDocument()
                expect(within(signOff).getAllByText('Pending')).toHaveLength(2)
                expect(screen.getByText('Oversee inspection')).toBeInTheDocument()
                expect(screen.getByText('4 · Advanced')).toBeInTheDocument()
                // The author has no reviewer action on a proposed version.
                expect(
                        screen.queryByRole('button', { name: /Authorise|Approve|Return/ }),
                ).not.toBeInTheDocument()
        })

        it('lets the Plant Head authorise a proposed JD', async () => {
                const api = setupDetail(plantHeadUser)
                api.set(
                        'POST /api/jds/5/versions/50/authorise',
                        reply(200, jdVersion({ status: 'AUTHORISED' })),
                )
                const { user } = renderApp('/jds/5')
                await user.click(
                        await screen.findByRole('button', { name: 'Authorise (Plant Head)' }),
                )
                expect(api.callsTo('POST', '/api/jds/5/versions/50/authorise')).toHaveLength(1)
        })

        it('shows why a sign-off was refused', async () => {
                const api = setupDetail(plantHeadUser)
                api.set(
                        'POST /api/jds/5/versions/50/authorise',
                        reply(403, {
                                detail: 'The person who proposed a JD cannot also authorise it.',
                        }),
                )
                const { user } = renderApp('/jds/5')
                await user.click(
                        await screen.findByRole('button', { name: 'Authorise (Plant Head)' }),
                )
                expect(
                        await screen.findByText(
                                'The person who proposed a JD cannot also authorise it.',
                        ),
                ).toBeInTheDocument()
        })

        it('returns a JD to draft only with a reason', async () => {
                const api = setupDetail(plantHeadUser)
                api.set(
                        'POST /api/jds/5/versions/50/return',
                        reply(
                                200,
                                jdVersion({
                                        status: 'DRAFT',
                                        returned_reason: 'Add machining scope',
                                }),
                        ),
                )
                const { user } = renderApp('/jds/5')
                await user.click(await screen.findByRole('button', { name: 'Return to draft' }))
                await user.type(
                        screen.getByLabelText('What needs to change?'),
                        'Add machining scope',
                )
                await user.click(screen.getByRole('button', { name: 'Return to draft' }))
                expect(
                        JSON.parse(
                                String(
                                        api.callsTo('POST', '/api/jds/5/versions/50/return')[0].init
                                                .body,
                                ),
                        ),
                ).toEqual({ reason: 'Add machining scope' })
        })
})

describe('JD editor', () => {
        function setupEditor(me: CurrentUser) {
                return installMockApi({
                        'GET /api/auth/me': reply(200, me),
                        'GET /api/org-units': reply(200, units),
                        'GET /api/designations': reply(200, [
                                { id: 100, code: 'ENG', name: 'Engineer' },
                        ]),
                })
        }

        it('keeps the HR-only budget field read-only for others', async () => {
                setupEditor(deptHeadUser)
                renderApp('/jds/new')
                expect(
                        await screen.findByLabelText('Available budget for the department'),
                ).toBeDisabled()
        })

        it('lets HR fill in the budget', async () => {
                setupEditor(hrHeadUser)
                renderApp('/jds/new')
                expect(
                        await screen.findByLabelText('Available budget for the department'),
                ).toBeEnabled()
        })

        it('validates before sending and lists the problems', async () => {
                const api = setupEditor(deptHeadUser)
                const { user } = renderApp('/jds/new')
                await user.click(await screen.findByRole('button', { name: 'Create draft' }))
                expect(screen.getByText('Please correct the following')).toBeInTheDocument()
                expect(screen.getByLabelText('Role title')).toHaveAccessibleDescription(
                        'Enter the role title (at least 2 characters).',
                )
                expect(api.callsTo('POST', '/api/jds')).toHaveLength(0)
        })

        it('sends every current-format field, blanks as null', () => {
                const form = {
                        ...emptyForm(),
                        title: ' QE ',
                        departmentId: '10',
                        vacancies: '2',
                        vacancy_type: 'REPLACEMENT',
                        replacement_of: 'Previous incumbent',
                        responsibilities: [
                                {
                                        heading: 'Inspection',
                                        points: 'Oversee inspection\n\n Approve FAI ',
                                },
                        ],
                        technical: [
                                { name: 'GD&T', level: '5' },
                                { name: '  ', level: '3' },
                        ],
                }
                expect(validateForm(form, true)).toEqual({})
                const content = contentFromForm(form)
                expect(content.vacancies).toBe(2)
                expect(content.available_budget).toBeNull()
                expect(content.responsibilities).toEqual([
                        { heading: 'Inspection', points: ['Oversee inspection', 'Approve FAI'] },
                ])
                expect(content.technical_competencies).toEqual([{ name: 'GD&T', level: 5 }])
                expect(
                        validateForm({ ...form, replacement_of: '' }, true).replacement_of,
                ).toBeDefined()
        })
})

describe('navigation for JD & KPI setup', () => {
        it('shows upload and deviations only to roles that use them', async () => {
                installMockApi({
                        'GET /api/auth/me': reply(200, { ...adminUser, permissions: ['org:read'] }),
                        'GET /api/plants': reply(200, plants),
                        'GET /api/departments': reply(200, []),
                        'GET /api/org-units': reply(200, units),
                        'GET /api/reports/headcount': reply(200, headcountReport()),
                })
                renderApp('/')
                const nav = await screen.findByRole('navigation', { name: 'Main' })
                expect(
                        within(nav).getByRole('link', { name: 'Job descriptions' }),
                ).toBeInTheDocument()
                expect(within(nav).getByRole('link', { name: 'KPI sheets' })).toBeInTheDocument()
                expect(
                        within(nav).queryByRole('link', { name: 'Excel upload' }),
                ).not.toBeInTheDocument()
                expect(
                        within(nav).queryByRole('link', { name: 'Deviations' }),
                ).not.toBeInTheDocument()
        })
})
