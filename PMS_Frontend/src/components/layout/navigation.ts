import {
        Building2,
        ChartColumn,
        Factory,
        LayoutDashboard,
        UserRound,
        Users,
        type LucideIcon,
} from 'lucide-react'
import { canReadOrganization, canReadOwnRecord } from '../../features/auth/permissions'
import type { CurrentUser } from '../../types/api'

export interface NavItem {
        label: string
        to: string
        icon: LucideIcon
        /** Match only the exact path (for "/"). */
        end?: boolean
}

export interface NavGroup {
        label: string
        items: NavItem[]
}

/** Navigation for this user. Visibility is a convenience; the API enforces access. */
export function buildNavigation(user: CurrentUser): NavGroup[] {
        const groups: NavGroup[] = [
                {
                        label: 'Overview',
                        items: [{ label: 'Dashboard', to: '/', icon: LayoutDashboard, end: true }],
                },
        ]
        if (canReadOrganization(user)) {
                groups.push(
                        {
                                label: 'Organization',
                                items: [
                                        { label: 'Plants', to: '/plants', icon: Factory },
                                        {
                                                label: 'Departments',
                                                to: '/departments',
                                                icon: Building2,
                                        },
                                        { label: 'Employees', to: '/employees', icon: Users },
                                ],
                        },
                        {
                                label: 'Reports',
                                items: [
                                        {
                                                label: 'Headcount',
                                                to: '/reports/headcount',
                                                icon: ChartColumn,
                                        },
                                ],
                        },
                )
        }
        const account: NavItem[] = [
                { label: 'My profile', to: '/profile', icon: UserRound, end: true },
        ]
        if (user.employee && canReadOwnRecord(user) && !canReadOrganization(user)) {
                account.push({
                        label: 'My employee record',
                        to: `/employees/${user.employee.id}`,
                        icon: Users,
                })
        }
        groups.push({ label: 'Account', items: account })
        return groups
}

const SECTION_TITLES: [prefix: string, title: string][] = [
        ['/plants', 'Organization · Plants'],
        ['/departments', 'Organization · Departments'],
        ['/employees', 'Organization · Employees'],
        ['/reports/headcount', 'Reports · Headcount'],
        ['/profile', 'Account · My profile'],
]

/** Section shown in the top header, derived from the current path. */
export function sectionTitle(pathname: string): string {
        if (pathname === '/') return 'Dashboard'
        return SECTION_TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? 'PMS Portal'
}
