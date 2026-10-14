import { LoaderCircle } from 'lucide-react'

/** Decorative spinner; pair it with visible or screen-reader text. */
export function Spinner({ className = 'size-5' }: { className?: string }) {
        return (
                <LoaderCircle
                        aria-hidden="true"
                        className={`motion-safe:animate-spin ${className}`}
                />
        )
}
