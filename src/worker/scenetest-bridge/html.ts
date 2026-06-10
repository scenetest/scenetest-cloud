// `@scenetest/vite-plugin` upstream doesn't yet export `./dashboard`. We add it
// via a pnpm patch (patches/@scenetest__vite-plugin.patch) and import the proper
// subpath here. Drop the patch once upstream ships the export.
import { generateDashboardHtml } from '@scenetest/vite-plugin/dashboard'

// scenetest-js's dashboard hardcodes absolute paths like '/__scenetest/events'.
// Rewrite them to relative paths so all fetches/EventSource land back inside
// our per-run namespace (the page is served at /r/:runId/dashboard/). The
// output is identical for every request, so compute once per isolate.
let cached: string | null = null
export function renderDashboard(): string {
  return (cached ??= generateDashboardHtml().replaceAll("'/__scenetest/", "'./__scenetest/"))
}
