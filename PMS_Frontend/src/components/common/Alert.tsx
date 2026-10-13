import { CircleAlert, Info, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

type AlertTone = 'info' | 'warning' | 'danger'

const STYLES: Record<AlertTone, { box: string; icon: string }> = {
        info: { box: 'border-sky-200 bg-sky-50 text-sky-950', icon: 'text-sky-700' },
        warning: { box: 'border-amber-300 bg-amber-50 text-amber-950', icon: 'text-amber-700' },
        danger: { box: 'border-red-200 bg-red-50 text-red-950', icon: 'text-red-700' },
}

const ICONS = { info: Info, warning: TriangleAlert, danger: CircleAlert }

interface AlertProps {
        tone?: AlertTone
        title?: string
        children?: ReactNode
        action?: ReactNode
        /** Announce immediately (errors). Informational notes use a polite status. */
        assertive?: boolean
}

export function Alert({ tone = 'info', title, children, action, assertive = false }: AlertProps) {
        const Icon = ICONS[tone]
        return (
                <div role={assertive ? 'alert' : 'status'} className={`flex gap-3 rounded-lg border px-4 py-3 text-sm ${STYLES[tone].box}`}>
                        <Icon aria-hidden="true" className={`mt-0.5 size-5 shrink-0 ${STYLES[tone].icon}`} />
                        <div className="min-w-0 flex-1 space-y-1">
                                {title && <p className="font-semibold">{title}</p>}
                                {children && <div>{children}</div>}
                                {action && <div className="pt-1">{action}</div>}
                        </div>
                </div>
        )
}