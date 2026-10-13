import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react'

interface TableProps {
        /** Describes the table for screen readers. */
        caption: string
        children: ReactNode
        /** True while newer data is loading; dims the (stale) rows. */
        busy?: boolean
}

/** Bordered table that scrolls horizontally on narrow screens. */
export function Table({ caption, children, busy = false }: TableProps) {
        return (
                <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
                        <table
                                aria-busy={busy || undefined}
                                className={`min-w-full divide-y divide-slate-200 text-sm ${busy ? 'opacity-60' : ''}`}
                        >
                                <caption className="sr-only">{caption}</caption>
                                {children}
                        </table>
                </div>
        )
}

type Align = 'left' | 'right'

export function Th({
        align = 'left',
        className = '',
        children,
        ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { align?: Align }) {
        return (
                <th
                        scope="col"
                        className={`bg-slate-50 px-4 py-2.5 text-xs font-semibold tracking-wide text-slate-600 uppercase whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}
                        {...rest}
                >
                        {children}
                </th>
        )
}

export function Td({
        align = 'left',
        className = '',
        children,
        ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { align?: Align }) {
        return (
                <td
                        className={`px-4 py-3 align-top text-slate-800 ${align === 'right' ? 'text-right tabular-nums' : ''} ${className}`}
                        {...rest}
                >
                        {children}
                </td>
        )
}

export function TBody({ children }: { children: ReactNode }) {
        return <tbody className="divide-y divide-slate-100">{children}</tbody>
}
