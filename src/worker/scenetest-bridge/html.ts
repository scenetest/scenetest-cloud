// Worker-served shell for the per-run dashboard. The page is docs-style
// chrome (cloud-owned pixels) around the @scenetest/dashboard widget, which
// renders into its own shadow root with the terminal aesthetic — the seam is
// deliberate. The widget code is the vite-built /run-dashboard.js (stable
// name, see vite.config.ts); it reads the run id from the URL and connects
// its own transport, so this HTML is identical for every run.
export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>scenetest run</title>
<style>
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 72rem; margin: 1.5rem auto; padding: 0 1.25rem; }
  header { margin-bottom: 1rem; }
  header a { color: inherit; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<main>
  <header><a href="/">scenetest-cloud</a></header>
  <div id="run-dashboard"></div>
</main>
<script type="module" src="/run-dashboard.js"></script>
</body>
</html>
`
}
