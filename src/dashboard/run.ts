// Entry for the per-run dashboard page (served by the worker at
// /r/:runId/dashboard). Built by vite as a stable-named ESM file
// (/run-dashboard.js) that the worker's HTML shell references; everything on
// the page besides this mount is the shell's docs-style chrome.
import { h, render } from 'preact'
import { mountDashboard } from '@scenetest/dashboard'
import { createCloudTransport } from './lib/cloudTransport.ts'
import { ScenesPanel } from './components/ScenesPanel.tsx'

const match = /^\/r\/([^/]+)\/dashboard\/?$/.exec(window.location.pathname)
const root = document.getElementById('run-dashboard')

if (match?.[1] && root) {
  mountDashboard(root, { transport: createCloudTransport(match[1]) })
  // POC: the TanStack DB scenes panel reads the same run WS (via
  // runShapeSource) and renders it through useLiveQuery — beside the widget.
  const scenesRoot = document.getElementById('ws-scenes')
  if (scenesRoot) render(h(ScenesPanel, { runId: match[1] }), scenesRoot)
} else if (root) {
  root.textContent = 'No run id in URL.'
}
