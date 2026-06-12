import { useState } from 'preact/hooks'
import { useMe, type Me } from './hooks/useMe.ts'
import { NavBar } from './components/NavBar.tsx'
import { Overview } from './components/Overview.tsx'
import { ProjectsView } from './components/ProjectsView.tsx'
import { RepoDetail } from './components/RepoDetail.tsx'
import { Button } from './components/Button.tsx'

type View =
  | { name: 'overview' }
  | { name: 'projects' }
  | { name: 'repo'; owner: string; repoName: string }

export function App() {
  const path = window.location.pathname
  if (path !== '/') return <NotFound path={path} />
  return <Home />
}

function Home() {
  const me = useMe()
  if (me.kind === 'loading') return <LoadingScreen />
  if (me.kind === 'signed-out') return <SignedOut />
  if (me.kind === 'error') return <ErrorPanel message={me.message} />
  return <Dashboard me={me.me} />
}

function Dashboard({ me }: { me: Me }) {
  const [view, setView] = useState<View>({ name: 'overview' })

  const handleNavigate = (v: string) => {
    if (v === 'overview') setView({ name: 'overview' })
    else if (v === 'projects') setView({ name: 'projects' })
  }

  return (
    <div class='min-h-screen bg-paper'>
      <NavBar me={me} currentView={view.name} onNavigate={handleNavigate} />
      {view.name === 'overview' && (
        <Overview onOpenRepo={(owner, repoName) => setView({ name: 'repo', owner, repoName })} />
      )}
      {view.name === 'projects' && (
        <ProjectsView onOpenRepo={(owner, repoName) => setView({ name: 'repo', owner, repoName })} />
      )}
      {view.name === 'repo' && (
        <RepoDetail owner={view.owner} name={view.repoName} onBack={() => setView({ name: 'overview' })} />
      )}
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

function NotFound({ path }: { path: string }) {
  return (
    <div class='min-h-screen bg-paper flex items-center justify-center'>
      <div class='card p-8 max-w-md'>
        <h2 class='font-mono text-xl font-medium text-ink mt-0'>404 — page not found</h2>
        <p class='font-serif text-base text-muted'>No route matches <code>{path}</code>.</p>
        <a href='/' class='font-mono text-sm text-accent'>← Back to dashboard</a>
      </div>
    </div>
  )
}
