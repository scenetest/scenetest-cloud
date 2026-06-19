import { Router, Route, useLocation } from 'preact-iso'
import { useMe, type Me } from './hooks/useMe.ts'
import { NavBar } from './components/NavBar.tsx'
import { Overview } from './components/Overview.tsx'
import { ProjectsView } from './components/ProjectsView.tsx'
import { RepoDetail } from './components/RepoDetail.tsx'
import { PrDetail } from './components/PrDetail.tsx'
import { Button } from './components/Button.tsx'

// The SPA owns exactly these paths. preact-iso intercepts in-app link clicks
// only within this scope; worker-served routes (/auth/*, /api/*) fall outside
// it and reach the worker normally. This set must agree with the worker's shell
// fall-through in src/worker/index.ts. The concrete URLs are built in
// ./lib/paths.ts — the PR page (/repo/:owner/:name/pr/:number) is in scope.
export const spaScope = /^\/($|projects|repo\/)/

export function App() {
  const me = useMe()
  if (me.kind === 'loading') return <LoadingScreen />
  if (me.kind === 'signed-out') return <SignedOut />
  if (me.kind === 'error') return <ErrorPanel message={me.message} />
  return <Dashboard me={me.me} />
}

function Dashboard({ me }: { me: Me }) {
  // The chrome (nav bar) lives above the <Router>, so it persists across route
  // changes. The views below own their own navigation as links — see paths.ts.
  return (
    <div class='min-h-screen bg-paper'>
      <NavBar me={me} />
      <Router>
        <Route path='/' component={Overview} />
        <Route path='/projects' component={ProjectsView} />
        <Route path='/repo/:owner/:name/pr/:number/:view?' component={PrDetail} />
        <Route path='/repo/:owner/:name' component={RepoDetail} />
        <Route default component={NotFound} />
      </Router>
    </div>
  )
}

function LoadingScreen() {
  return (
    <div class='min-h-screen bg-paper flex items-center justify-center'>
      <span class='font-mono text-muted'>Loading…</span>
    </div>
  )
}

function SignedOut() {
  return (
    <div class='min-h-screen bg-paper flex items-center justify-center'>
      <div class='text-center'>
        <div class='font-mono text-2xl font-medium tracking-hero text-ink mb-2'>
          scenetest <span class='cloud-tag' style={{ verticalAlign: 'middle' }}>cloud</span>
        </div>
        <p class='font-serif text-lg text-muted mb-6'>Sign in to view your CI dashboard.</p>
        <Button variant='primary' size='lg' href='/auth/github/login'>Sign in with GitHub</Button>
      </div>
    </div>
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div class='min-h-screen bg-paper flex items-center justify-center'>
      <div class='card p-8 max-w-md'>
        <h2 class='font-mono text-xl font-medium text-fail mt-0'>Something went wrong</h2>
        <p class='font-serif text-base text-muted'>The dashboard couldn't load. Try refreshing.</p>
        <details>
          <summary class='font-mono text-sm text-muted cursor-pointer'>Details</summary>
          <pre class='font-mono text-xs text-muted whitespace-pre-wrap mt-2'>{message}</pre>
        </details>
      </div>
    </div>
  )
}

function NotFound() {
  const { path } = useLocation()
  return (
    <div class='page-shell'>
      <div class='card p-8 max-w-md'>
        <h2 class='font-mono text-xl font-medium text-ink mt-0'>404 — page not found</h2>
        <p class='font-serif text-base text-muted'>No route matches <code>{path}</code>.</p>
        <a href='/' class='font-mono text-sm text-accent'>← Back to dashboard</a>
      </div>
    </div>
  )
}
