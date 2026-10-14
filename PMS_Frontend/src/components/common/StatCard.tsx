import type { ReactNode } from 'react'
import { cardClasses } from './styles'

interface StatCardProps {
        label: string
        value: ReactNode
        hint?: ReactNode
        tone?: 'default' | 'warning'
}

/** A single figure taken directly from an API response. */
export function StatCard({ label, value, hint, tone = 'default' }: StatCardProps) {
        const border = tone === 'warning' ? 'border-amber-300 bg-amber-50' : ''
        return (
                <div className={`${cardClasses} ${border} px-4 py-3`}>
                        <dt className="text-sm font-medium text-slate-600">{label}</dt>
                        <dd className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
                                {value}
                        </dd>
                        {hint && <dd className="mt-1 text-xs text-slate-600">{hint}</dd>}
                </div>
        )
}
