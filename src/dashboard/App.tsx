import { useState } from 'preact/hooks'
import { useMe, type Me } from './hooks/useMe.ts'
import { NavBar } from './components/NavBar.tsx'
import { Overview } from './components/Overview.tsx'
import { ProjectsView } from './components/ProjectsView.tsx'
import { RepoDetail } from './components/RepoDetail.tsx'

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

  const handleOpenRepo = (owner: string, repoName: string) => {
    setView({ name: 'repo', owner, repoName })
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--paper-bg)' }}>
      <NavBar me={me} currentView={view.name} onNavigate={handleNavigate} />
      {view.name === 'overview' && <Overview onOpenRepo={handleOpenRepo} />}
      {view.name === 'projects' && <ProjectsView onOpenRepo={handleOpenRepo} />}
      {view.name === 'repo' && (
        <RepoDetail
          owner={view.owner}
          name={view.repoName}
          onBack={() => setView({ name: 'overview' })}
        />
      )}
    </div>
  )
}

function LoadingScreen() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span className='font-mono text-muted'>Loading…</span>
    </div>
  )
}

function SignedOut() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <div className='font-mono text-2xl font-medium tracking-hero text-ink' style={{ marginBottom: 8 }}>
          scenetest <span className='cloud-tag' style={{ verticalAlign: 'middle' }}>cloud</span>
        </div>
        <p className='font-serif text-lg text-muted' style={{ marginBottom: 24 }}>Sign in to view your CI dashboard.</p>
        <a href='/auth/github/login' className='btn btn-primary btn-lg'>Sign in with GitHub</a>
      </div>
    </div>
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className='card' style={{ padding: '2rem', maxWidth: '28rem' }}>
        <h2 className='font-mono text-xl font-medium text-fail' style={{ marginTop: 0 }}>Something went wrong</h2>
        <p className='font-serif text-base text-muted'>The dashboard couldn't load. Try refreshing.</p>
        <details>
          <summary className='font-mono text-sm text-muted cursor-pointer'>Details</summary>
          <pre className='font-mono text-xs text-muted' style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{message}</pre>
        </details>
      </div>
    </div>
  )
}

function NotFound({ path }: { path: string }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className='card' style={{ padding: '2rem', maxWidth: '28rem' }}>
        <h2 className='font-mono text-xl font-medium text-ink' style={{ marginTop: 0 }}>404 — page not found</h2>
        <p className='font-serif text-base text-muted'>No route matches <code>{path}</code>.</p>
        <a href='/' className='font-mono text-sm text-accent'>← Back to dashboard</a>
      </div>
    </div>
  )
}
