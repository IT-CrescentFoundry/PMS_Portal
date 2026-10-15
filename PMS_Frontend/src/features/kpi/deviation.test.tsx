import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { deptHeadUser, deviation, hrHeadUser, plantHeadUser } from '../../test/kpiFixtures'
import { installMockApi, reply } from '../../test/mockApi'
import { renderApp } from '../../test/renderApp'
import type { CurrentUser, Deviation } from '../../types/api'

function setup(me: CurrentUser, current: Deviation = deviation()) {
        return installMockApi({
                'GET /api/auth/me': reply(200, me),
                'GET /api/kpi/deviations/70': reply(200, current),
        })
}

describe('KPI deviation approval', () => {
        it('compares current and proposed KPIs', async () => {
                setup(hrHeadUser)
                renderApp('/kpi/deviations/70')
                const table = await screen.findByRole('table', {
                        name: 'Current and proposed KPIs',
                })
                const profit = within(table).getByText('Test profit').closest('tr')!
                expect(within(profit).getByText('40.00% · target 120')).toBeInTheDocument()
                expect(within(profit).getByText('50.00% · target 120')).toBeInTheDocument()
                expect(within(profit).getByText('Changed')).toBeInTheDocument()
        })

        it('lets the HR Head approve only the HR side, and records the side', async () => {
                const api = setup(hrHeadUser)
                api.set(
                        'POST /api/kpi/deviations/70/approve',
                        reply(
                                200,
                                deviation({
                                        hr_approved_by: {
                                                id: hrHeadUser.id,
                                                username: hrHeadUser.username,
                                        },
                                        hr_approved_at: '2026-08-11T10:00:00Z',
                                }),
                        ),
                )
                const { user } = renderApp('/kpi/deviations/70')
                await user.click(await screen.findByRole('button', { name: 'Approve as HR Head' }))
                expect(
                        screen.queryByRole('button', { name: 'Approve as Plant Head' }),
                ).not.toBeInTheDocument()
                expect(
                        await screen.findByText(
                                'You have approved one side; the other approval must come from a different person.',
                        ),
                ).toBeInTheDocument()
                expect(
                        JSON.parse(
                                String(
                                        api.callsTo('POST', '/api/kpi/deviations/70/approve')[0]
                                                .init.body,
                                ),
                        ),
                ).toEqual({
                        as: 'HR_HEAD',
                })
                // Still pending until the Plant Head approves too.
                expect(screen.getByText('Awaiting approval')).toBeInTheDocument()
        })

        it('applies once the second (Plant Head) approval is given', async () => {
                const halfway = deviation({
                        hr_approved_by: { id: hrHeadUser.id, username: hrHeadUser.username },
                        hr_approved_at: '2026-08-11T10:00:00Z',
                })
                const api = setup(plantHeadUser, halfway)
                api.set(
                        'POST /api/kpi/deviations/70/approve',
                        reply(200, {
                                ...halfway,
                                status: 'APPLIED',
                                plant_approved_by: {
                                        id: plantHeadUser.id,
                                        username: plantHeadUser.username,
                                },
                                plant_approved_at: '2026-08-12T10:00:00Z',
                                applied_at: '2026-08-12T10:00:00Z',
                        }),
                )
                const { user } = renderApp('/kpi/deviations/70')
                expect(
                        screen.queryByRole('button', { name: 'Approve as HR Head' }),
                ).not.toBeInTheDocument()
                await user.click(
                        await screen.findByRole('button', { name: 'Approve as Plant Head' }),
                )
                expect(await screen.findByText('Applied on 12 Aug 2026')).toBeInTheDocument()
                expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument()
        })

        it('does not offer approval to the requester', async () => {
                setup({
                        ...deptHeadUser,
                        permissions: [...deptHeadUser.permissions, 'deviation:approve_hr'],
                })
                renderApp('/kpi/deviations/70')
                expect(
                        await screen.findByText(
                                'You requested this deviation, so you cannot approve or reject it.',
                        ),
                ).toBeInTheDocument()
                expect(
                        screen.queryByRole('button', { name: /Approve|Reject/ }),
                ).not.toBeInTheDocument()
        })

        it('requires a reason to reject', async () => {
                const api = setup(plantHeadUser)
                api.set(
                        'POST /api/kpi/deviations/70/reject',
                        reply(
                                200,
                                deviation({
                                        status: 'REJECTED',
                                        rejected_by: {
                                                id: plantHeadUser.id,
                                                username: plantHeadUser.username,
                                        },
                                        rejected_at: '2026-08-12T10:00:00Z',
                                        rejection_reason: 'Not justified',
                                }),
                        ),
                )
                const { user } = renderApp('/kpi/deviations/70')
                await user.click(await screen.findByRole('button', { name: 'Reject…' }))
                await user.click(screen.getByRole('button', { name: 'Reject deviation' }))
                expect(screen.getByLabelText('Reason for rejecting')).toHaveAccessibleDescription(
                        'Enter a reason.',
                )
                expect(api.callsTo('POST', '/api/kpi/deviations/70/reject')).toHaveLength(0)
                await user.type(screen.getByLabelText('Reason for rejecting'), 'Not justified')
                await user.click(screen.getByRole('button', { name: 'Reject deviation' }))
                expect(await screen.findByText('Not justified')).toBeInTheDocument()
                expect(screen.getByText('Rejected')).toBeInTheDocument()
        })
})
