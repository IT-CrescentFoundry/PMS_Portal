import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const backendDir = fileURLToPath(new URL('../PMS_Backend/', import.meta.url))

/**
 * End-to-end tests against the REAL local stack: FastAPI (localhost:8000,
 * development database with the demo seed) and the Vite dev server
 * (localhost:5173), driven by the locally installed Google Chrome.
 *
 * Traces, videos and screenshots are disabled so that typed credentials are
 * never written to disk.
 */
export default defineConfig({
        testDir: './e2e',
        fullyParallel: false,
        workers: 1,
        retries: 0,
        reporter: 'list',
        timeout: 30_000,
        use: {
                baseURL: 'http://localhost:5173',
                channel: 'chrome',
                trace: 'off',
                video: 'off',
                screenshot: 'off',
        },
        projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
        webServer: [
                {
                        command: String.raw`PMS_venv\Scripts\python.exe -m uvicorn app.main:app --host localhost --port 8000`,
                        cwd: backendDir,
                        url: 'http://localhost:8000/api/health',
                        reuseExistingServer: true,
                        timeout: 60_000,
                },
                {
                        command: 'npm run dev',
                        url: 'http://localhost:5173',
                        reuseExistingServer: true,
                        timeout: 60_000,
                },
        ],
})
