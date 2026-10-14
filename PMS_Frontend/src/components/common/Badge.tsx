import type { ReactNode } from 'react'

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info'

const TONES: Record<BadgeTone, string> = {
        neutral: 'bg-slate-100 text-slate-700 ring-slate-300',
        brand: 'bg-brand-50 text-brand-800 ring-brand-200',
        success: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
        warning: 'bg-amber-50 text-amber-900 ring-amber-300',
        danger: 'bg-red-50 text-red-800 ring-red-200',
        info: 'bg-sky-50 text-sky-900 ring-sky-200',
}

interface BadgeProps {
        tone?: BadgeTone
        className?: string
        children: ReactNode
}

export function Badge({ tone = 'neutral', className = '', children }: BadgeProps) {
        return (
                <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${TONES[tone]} ${className}`}
                >
                        {children}
                </span>
        )
}

export function ActiveBadge({ active }: { active: boolean }) {
        return <Badge tone={active ? 'success' : 'neutral'}>{active ? 'Active' : 'Inactive'}</Badge>
}

/** Primary = where the person is counted; Supporting = additional assignment.
 *  Fixed width so stacked assignment labels line up. */
export function AssignmentTypeBadge({ primary }: { primary: boolean }) {
        return (
                <Badge tone={primary ? 'brand' : 'info'} className="w-20 justify-center">
                        {primary ? 'Primary' : 'Supporting'}
                </Badge>
        )
}
