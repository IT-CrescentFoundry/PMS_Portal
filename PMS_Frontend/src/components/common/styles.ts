/** Shared class names, so links styled as buttons look identical to buttons. */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

const BASE =
        'inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap ' +
        'transition-colors disabled:cursor-not-allowed disabled:opacity-60'

const VARIANTS: Record<ButtonVariant, string> = {
        primary: 'bg-brand-700 text-white hover:bg-brand-800 shadow-sm',
        secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 shadow-sm',
        ghost: 'text-slate-700 hover:bg-slate-100',
        danger: 'bg-red-700 text-white hover:bg-red-800 shadow-sm',
}

const SIZES: Record<ButtonSize, string> = {
        sm: 'h-8 px-3 text-sm',
        md: 'h-10 px-4 text-sm',
}

export function buttonClasses(
        variant: ButtonVariant = 'secondary',
        size: ButtonSize = 'md',
): string {
        return `${BASE} ${VARIANTS[variant]} ${SIZES[size]}`
}

export const linkClasses =
        'font-medium text-brand-700 underline-offset-2 hover:underline hover:text-brand-800'

export const inputClasses =
        'block w-full rounded-md border border-slate-300 bg-white px-3 h-10 text-sm text-slate-900 ' +
        'shadow-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none ' +
        'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand-500 ' +
        'disabled:bg-slate-100 disabled:text-slate-500 aria-invalid:border-red-600'

export const cardClasses = 'rounded-lg border border-slate-200 bg-white shadow-sm'
