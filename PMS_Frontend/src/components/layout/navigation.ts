import {
        Building2,
        Calculator,
        ChartColumn,
        Factory,
        FileSpreadsheet,
        FileText,
        GitPullRequestArrow,
        Grid3x3,
        LayoutDashboard,
        ListChecks,
        Scale,
        Target,
        Upload,
        UserRound,
        Users,
        type LucideIcon,
} from 'lucide-react'
import {
        canApproveDeviationAsHR,
        canApproveDeviationAsPlant,
        canReadMatrices,
        canReadOrganization,
        canReadOwnRecord,
        canWriteKpi,
} from '../../features/auth/permissions'
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
                        items: [
                                {
                                        label: 'Dashboard',
                                        to: '/',
                                        icon: LayoutDashboard,
                                        end: true,
                                },
                        ],
                },
        ]
        if (canReadOrganization(user)) {
                groups.push(
                        {
                                label: 'Organization',
                                items: [
                                        {
                                                label: 'Plants',
                                                to: '/plants',
                                                icon: Factory,
                                        },
                                        {
                                                label: 'Departments',
                                                to: '/departments',
                                                icon: Building2,
                                        },
                                        {
                                                label: 'Employees',
                                                to: '/employees',
                                                icon: Users,
                                        },
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
                const performance: NavItem[] = [
                        {
                                label: 'Job descriptions',
                                to: '/jds',
                                icon: FileText,
                        },
                        {
                                label: 'KPI library',
                                to: '/kpi/library',
                                icon: Target,
                        },
                        {
                                label: 'KPI sheets',
                                to: '/kpi/sheets',
                                icon: ListChecks,
                        },
                ]
                if (canWriteKpi(user)) {
                        performance.push({
                                label: 'Excel upload',
                                to: '/kpi/upload',
                                icon: FileSpreadsheet,
                        })
                }
                if (
                        canWriteKpi(user) ||
                        canApproveDeviationAsHR(user) ||
                        canApproveDeviationAsPlant(user)
                ) {
                        performance.push({
                                label: 'Deviations',
                                to: '/kpi/deviations',
                                icon: GitPullRequestArrow,
                        })
                }
                const scoring: NavItem[] = []
                if (canReadMatrices(user)) {
                        scoring.push({ label: 'Matrices', to: '/matrices', icon: Grid3x3 })
                }
                if (canWriteKpi(user)) {
                        scoring.push({
                                label: 'Monthly KPI data',
                                to: '/scores/data',
                                icon: Upload,
                        })
                }
                scoring.push({ label: 'KPI results', to: '/scores/results', icon: Calculator })
                if (
                        canWriteKpi(user) ||
                        canApproveDeviationAsHR(user) ||
                        canApproveDeviationAsPlant(user)
                ) {
                        scoring.push({
                                label: 'Score overrides',
                                to: '/scores/overrides',
                                icon: Scale,
                        })
                }
                // Before Reports, after Organization.
                groups.splice(
                        2,
                        0,
                        { label: 'JD & KPI setup', items: performance },
                        { label: 'Scoring', items: scoring },
                )
        }
        const account: NavItem[] = [
                {
                        label: 'My profile',
                        to: '/profile',
                        icon: UserRound,
                        end: true,
                },
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
        ['/jds', 'JD & KPI setup · Job descriptions'],
        ['/kpi/library', 'JD & KPI setup · KPI library'],
        ['/kpi/policies', 'JD & KPI setup · Scoring rules'],
        ['/kpi/sheets', 'JD & KPI setup · KPI sheets'],
        ['/kpi/upload', 'JD & KPI setup · Excel upload'],
        ['/kpi/deviations', 'JD & KPI setup · Deviations'],
        ['/matrices', 'Scoring · Matrices'],
        ['/scores/data', 'Scoring · Monthly KPI data'],
        ['/scores/results', 'Scoring · KPI results'],
        ['/scores/overrides', 'Scoring · Score overrides'],
        ['/profile', 'Account · My profile'],
]

/** Section shown in the top header, derived from the current path. */
export function sectionTitle(pathname: string): string {
        if (pathname === '/') return 'Dashboard'
        return SECTION_TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? 'PMS Portal'
}
