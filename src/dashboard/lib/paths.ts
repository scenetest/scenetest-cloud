// The SPA's URL surface, defined once. Every in-app link and route() call
// builds its target through here, so the scheme lives in a single place that
// the <Router> table in App.tsx, the spaScope regex, and the worker's shell
// fall-through (src/worker/index.ts) all mirror. Change a path here and the
// links follow.
export const paths = {
  overview: () => '/',
  projects: () => '/projects',
  repo: (owner: string, name: string) => `/repo/${owner}/${name}`,
  // The PR is the unit of work. A run is selected in-page via ?run=<id>
  // (deep-linkable UI state), defaulting to the latest run — it is not a route.
  pr: (owner: string, name: string, number: number, runId?: string) =>
    `/repo/${owner}/${name}/pr/${number}${runId ? `?run=${runId}` : ''}`,
}
