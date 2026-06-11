// Entry for the per-run dashboard page (served by the worker at
// /r/:runId/dashboard). Built by vite as a stable-named ESM file
// (/run-dashboard.js) that the worker's HTML shell references; everything on
// the page besides this mount is the shell's docs-style chrome.
import { mountDashboard } from '@scenetest/dashboard'
import { createCloudTransport } from './lib/cloudTransport.ts'

const match = /^\/r\/([^/]+)\/dashboard\/?$/.exec(window.location.pathname)
const root = document.getElementById('run-dashboard')

if (match?.[1] && root) {
  mountDashboard(root, { transport: createCloudTransport(match[1]) })
} else if (root) {
  root.textContent = 'No run id in URL.'
}
