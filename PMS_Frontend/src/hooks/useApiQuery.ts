import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isAbortError } from '../services/apiClient'

interface Settled<T> {
  requestId: string
  key: string
  data: T | undefined
  error: unknown
}

export interface ApiQuery<T> {
  /** Data for the current key (or, with keepPreviousData, the last key: see isStale). */
  data: T | undefined
  /** Error of the latest request for the current key. */
  error: unknown
  /** Nothing to show yet: first load for this key. */
  isLoading: boolean
  /** A request for the current key is in flight (first load or refresh). */
  isFetching: boolean
  /** `data` belongs to a previous key and is being replaced. */
  isStale: boolean
  /** Re-run the request (e.g. a Retry button). */
  reload: () => void
}

/**
 * Fetch data for `key`; pass null to skip. When the key changes, the
 * in-flight request is aborted, so a slow older response can never
 * overwrite a newer one.
 *
 * keepPreviousData: keep showing the previous key's data (flagged isStale)
 * while the new key loads, for filter changes on lists and reports.
 */
export function useApiQuery<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: { keepPreviousData?: boolean } = {},
): ApiQuery<T> {
  const [reloadCount, setReloadCount] = useState(0)
  const [settled, setSettled] = useState<Settled<T> | null>(null)
  const fetcherRef = useRef(fetcher)
  useLayoutEffect(() => {
    fetcherRef.current = fetcher
  })

  const requestId = key === null ? null : `${reloadCount}|${key}`

  useEffect(() => {
    if (key === null || requestId === null) return
    const controller = new AbortController()
    fetcherRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setSettled({ requestId, key, data, error: undefined })
      },
      (error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return
        setSettled({ requestId, key, data: undefined, error })
      },
    )
    return () => controller.abort()
  }, [key, requestId])

  const reload = useCallback(() => setReloadCount((count) => count + 1), [])

  const isFetching = requestId !== null && settled?.requestId !== requestId
  const error = requestId !== null && settled?.requestId === requestId ? settled.error : undefined

  let data: T | undefined
  let isStale = false
  if (key !== null && settled?.data !== undefined) {
    if (settled.key === key) {
      data = settled.data
    } else if (options.keepPreviousData) {
      data = settled.data
      isStale = true
    }
  }

  return { data, error, isLoading: data === undefined && isFetching, isFetching, isStale, reload }
}
