/**
 * Minimal fetch mock for isolated frontend tests. Routes are keyed by
 * "METHOD /path"; every call is recorded so tests can assert exactly what the
 * app sent (credentials, headers, query parameters, body).
 */
import { vi } from 'vitest'

export interface RecordedCall {
  method: string
  path: string
  query: URLSearchParams
  init: RequestInit
}

export type Handler = (call: RecordedCall) => Response | Promise<Response>

export function json(status: number, body?: unknown): Response {
  if (status === 204) return new Response(null, { status })
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** A handler that always returns the same JSON. */
export const reply =
  (status: number, body?: unknown): Handler =>
  () =>
    json(status, body)

/** A handler that fails like an unreachable server. */
export const networkFailure: Handler = () => Promise.reject(new TypeError('Failed to fetch'))

/** A response that resolves only when release() is called (for race tests). */
export function deferred(status: number, body: unknown) {
  let release: () => void = () => {}
  const handler: Handler = ({ init }) =>
    new Promise<Response>((resolve, reject) => {
      release = () => resolve(json(status, body))
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')),
      )
    })
  return { handler, release: () => release() }
}

export function installMockApi(routes: Record<string, Handler | Handler[]>) {
  const calls: RecordedCall[] = []
  const queues = new Map<string, Handler[]>()
  for (const [key, value] of Object.entries(routes)) {
    queues.set(key, Array.isArray(value) ? [...value] : [value])
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const call: RecordedCall = {
      method: init.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      init,
    }
    calls.push(call)
    if (init.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const queue = queues.get(`${call.method} ${call.path}`)
    if (!queue || queue.length === 0) return json(404, { detail: `No mock for ${call.method} ${call.path}` })
    // Sequential handlers are consumed in order; the last one repeats.
    const handler = queue.length > 1 ? queue.shift()! : queue[0]
    return handler(call)
  })
  vi.stubGlobal('fetch', fetchMock)

  return {
    calls,
    fetchMock,
    callsTo: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path),
    /** Replace a route mid-test. */
    set: (key: string, handler: Handler | Handler[]) =>
      queues.set(key, Array.isArray(handler) ? [...handler] : [handler]),
  }
}
