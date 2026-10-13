import { NavLink } from 'react-router'
import { APP_NAME } from '../../config'
import type { NavGroup } from './navigation'

interface SidebarProps {
        groups: NavGroup[]
        /** Called after a link is chosen (closes the mobile drawer). */
        onNavigate?: () => void
}

export function Sidebar({ groups, onNavigate }: SidebarProps) {
        return (
                <div className="flex h-full flex-col">
                        <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-4">
                                <span
                                        aria-hidden="true"
                                        className="flex size-8 items-center justify-center rounded-md bg-brand-700 text-sm font-bold text-white"
                                >
                                        P
                                </span>
                                <span className="font-semibold text-slate-900">{APP_NAME}</span>
                        </div>
                        <nav aria-label="Main" className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
                                {groups.map((group) => (
                                        <div key={group.label}>
                                                <p className="px-2 pb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                                                        {group.label}
                                                </p>
                                                <ul className="space-y-0.5">
                                                        {group.items.map(({ label, to, icon: Icon, end }) => (
                                                                <li key={to}>
                                                                        <NavLink
                                                                                to={to}
                                                                                end={end}
                                                                                onClick={onNavigate}
                                                                                className={({ isActive }) =>
                                                                                        `flex items-center gap-3 rounded-md px-2 py-2 text-sm font-medium transition-colors ${isActive
                                                                                                ? 'bg-brand-50 text-brand-800'
                                                                                                : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                                                                                        }`
                                                                                }
                                                                        >
                                                                                <Icon aria-hidden="true" className="size-4 shrink-0" />
                                                                                {label}
                                                                        </NavLink>
                                                                </li>
                                                        ))}
                                                </ul>
                                        </div>
                                ))}
                        </nav>
                </div>
        )
}
