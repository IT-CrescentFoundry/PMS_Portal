import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'

export interface Crumb {
        label: string
        to?: string
}

interface PageHeaderProps {
        title: string
        description?: ReactNode
        breadcrumbs?: Crumb[]
        /** Badges or short facts shown under the title. */
        meta?: ReactNode
        actions?: ReactNode
}

/** Page heading (the page's only <h1>), breadcrumbs and document title. */
export function PageHeader({ title, description, breadcrumbs, meta, actions }: PageHeaderProps) {
        useDocumentTitle(title)
        return (
                <header className="mb-6 space-y-3">
                        {breadcrumbs && breadcrumbs.length > 0 && (
                                <nav aria-label="Breadcrumb">
                                        <ol className="flex flex-wrap items-center gap-1 text-sm text-slate-600">
                                                {breadcrumbs.map((crumb, index) => {
                                                        const isLast = index === breadcrumbs.length - 1
                                                        return (
                                                                <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                                                                        {crumb.to && !isLast ? (
                                                                                <Link to={crumb.to} className="hover:text-brand-700 hover:underline">
                                                                                        {crumb.label}
                                                                                </Link>
                                                                        ) : (
                                                                                <span aria-current={isLast ? 'page' : undefined}>{crumb.label}</span>
                                                                        )}
                                                                        {!isLast && <ChevronRight aria-hidden="true" className="size-4 text-slate-400" />}
                                                                </li>
                                                        )
                                                })}
                                        </ol>
                                </nav>
                        )}
                        <div className="flex flex-wrap items-start justify-between gap-4">
                                <div className="min-w-0 space-y-1">
                                        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
                                        {description && <div className="max-w-3xl text-sm text-slate-600">{description}</div>}
                                        {meta && <div className="flex flex-wrap items-center gap-2 pt-1">{meta}</div>}
                                </div>
                                {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
                        </div>
                </header>
        )
}