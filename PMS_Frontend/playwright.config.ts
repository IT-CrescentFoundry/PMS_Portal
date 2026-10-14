import { defineConfig, devices } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/**
 * Browser end-to-end tests against an ISOLATED stack, never the development one:
 *
 *   API       http://localhost:8001  `python -m tests.e2e_server`, bound to the
 *                                    dedicated E2E database (E2E_DB_NAME, e.g.
 *                                    pms_e2e_test), which it verifies, migrates and
 *                                    seeds with synthetic data before serving.
 *   Frontend  http://localhost:5174  Vite dev server pointed at that API.
 *
 * Servers are never reused, so a developer's backend on :8000 (database `pms`)
 * can't be picked up by accident. A random password for the synthetic accounts
 * is generated per run (shared with the API and workers via the environment).
 * Traces, videos and screenshots are off, so credentials never reach the disk.
 */
const API_PORT = 8001
const WEB_PORT = 5174
const API_ORIGIN = `http://localhost:${API_PORT}`
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`

// Generated once in the runner; worker processes inherit it.
process.env.PMS_E2E_PASSWORD ||= randomBytes(18).toString('base64url')
process.env.PMS_E2E_API_ORIGIN = API_ORIGIN

const backendDir = fileURLToPath(new URL('../PMS_Backend/', import.meta.url))

export default defineConfig({
        testDir: './e2e',
        fullyParallel: false,
        workers: 1,
        retries: 0,
        reporter: 'list',
        timeout: 30_000,
        use: {
                baseURL: WEB_ORIGIN,
                channel: 'chrome',
                trace: 'off',
                video: 'off',
                screenshot: 'off',
        },
        projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
        webServer: [
                {
                        command: String.raw`PMS_venv\Scripts\python.exe -m tests.e2e_server`,
                        cwd: backendDir,
                        url: `${API_ORIGIN}/api/health`,
                        reuseExistingServer: false,
                        timeout: 120_000,
                        env: {
                                PMS_E2E_PASSWORD: process.env.PMS_E2E_PASSWORD,
                                PMS_E2E_API_PORT: String(API_PORT),
                                PMS_E2E_FRONTEND_ORIGIN: WEB_ORIGIN,
                        },
                },
                {
                        command: `npx vite --port ${WEB_PORT} --strictPort`,
                        url: WEB_ORIGIN,
                        reuseExistingServer: false,
                        timeout: 60_000,
                        env: { VITE_API_BASE_URL: API_ORIGIN },
                },
        ],
})