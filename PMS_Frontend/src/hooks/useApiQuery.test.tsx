import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useApiQuery } from './useApiQuery'

function controllable<T>() {
        const pending = new Map<
                string,
                { resolve: (value: T) => void; reject: (e: unknown) => void; signal: AbortSignal }
        >()
        const fetcher = (key: string) => (signal: AbortSignal) =>
                new Promise<T>((resolve, reject) => {
                        pending.set(key, { resolve, reject, signal })
                })
        return { pending, fetcher }
}

describe('useApiQuery', () => {
        it('ignores an older response that arrives after a newer one', async () => {
                const { pending, fetcher } = controllable<string>()
                const { result, rerender } = renderHook(({ k }) => useApiQuery(k, fetcher(k)), {
                        initialProps: { k: 'A' },
                })
                rerender({ k: 'B' })
                expect(pending.get('A')?.signal.aborted).toBe(true) // superseded request cancelled

                await act(async () => pending.get('B')!.resolve('data-B'))
                await act(async () => pending.get('A')!.resolve('data-A')) // late, stale response
                expect(result.current.data).toBe('data-B')
        })

        it('keeps previous data flagged as stale while a new key loads', async () => {
                const { pending, fetcher } = controllable<string>()
                const { result, rerender } = renderHook(
                        ({ k }) => useApiQuery(k, fetcher(k), { keepPreviousData: true }),
                        { initialProps: { k: 'A' } },
                )
                await act(async () => pending.get('A')!.resolve('data-A'))
                rerender({ k: 'B' })
                expect(result.current.data).toBe('data-A')
                expect(result.current.isStale).toBe(true)
                expect(result.current.isFetching).toBe(true)
                await act(async () => pending.get('B')!.resolve('data-B'))
                expect(result.current).toMatchObject({
                        data: 'data-B',
                        isStale: false,
                        isFetching: false,
                })
        })

        it('does not show the previous key data by default', async () => {
                const { pending, fetcher } = controllable<string>()
                const { result, rerender } = renderHook(({ k }) => useApiQuery(k, fetcher(k)), {
                        initialProps: { k: 'A' },
                })
                await act(async () => pending.get('A')!.resolve('data-A'))
                rerender({ k: 'B' })
                expect(result.current.data).toBeUndefined()
                expect(result.current.isLoading).toBe(true)
        })

        it('exposes errors and recovers on reload', async () => {
                const fetcher = vi
                        .fn<(signal: AbortSignal) => Promise<string>>()
                        .mockRejectedValueOnce(new Error('boom'))
                        .mockResolvedValueOnce('ok')
                const { result } = renderHook(() => useApiQuery('k', fetcher))
                await waitFor(() => expect(result.current.error).toBeInstanceOf(Error))
                act(() => result.current.reload())
                expect(result.current.error).toBeUndefined()
                await waitFor(() => expect(result.current.data).toBe('ok'))
        })

        it('does nothing for a null key', () => {
                const fetcher = vi.fn()
                const { result } = renderHook(() => useApiQuery(null, fetcher))
                expect(fetcher).not.toHaveBeenCalled()
                expect(result.current).toMatchObject({
                        data: undefined,
                        isLoading: false,
                        isFetching: false,
                })
        })
})
