// The SPA's URL surface, defined once. Every in-app link and route() call
// builds its target through here, so the scheme lives in a single place that
// the <Router> table in App.tsx, the spaScope regex, and the worker's shell
// fall-through (src/worker/index.ts) all mirror. Change a path here and the
// links follow.
export const paths = {
  overview: () => '/',
  projects: () => '/projects',
  repo: (owner: string, name: string) => `/repo/${owner}/${name}`,
}
