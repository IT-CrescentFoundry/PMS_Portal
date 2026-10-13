import type { ButtonHTMLAttributes } from 'react'
import { Spinner } from './Spinner'
import { buttonClasses, type ButtonSize, type ButtonVariant } from './styles'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
        variant?: ButtonVariant
        size?: ButtonSize
        /** Shows a spinner and disables the button (prevents double submission). */
        isLoading?: boolean
}

export function Button({
        variant = 'secondary',
        size = 'md',
        isLoading = false,
        className = '',
        disabled,
        type = 'button',
        children,
        ...rest
}: ButtonProps) {
        return (
                <button
                        type={type}
                        className={`${buttonClasses(variant, size)} ${className}`}
                        disabled={disabled || isLoading}
                        aria-busy={isLoading || undefined}
                        {...rest}
                >
                        {isLoading && <Spinner className="size-4" />}
                        {children}
                </button>
        )
}