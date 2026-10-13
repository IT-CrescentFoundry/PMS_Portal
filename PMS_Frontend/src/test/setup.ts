import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'

// The first render of the full app can be slow on a cold start (notably on
// synced/network drives); allow async queries more than the 1 s default.
configure({ asyncUtilTimeout: 5000 })

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
})
