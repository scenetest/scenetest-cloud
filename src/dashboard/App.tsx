import { useMe, type Me } from './hooks/useMe.ts'

export function App() {
  const path = window.location.pathname
  if (path !== '/') return <NotFound path={path} />
  return <Home />
}

function Home() {
  const me = useMe()
  return (
    <main style={containerStyle}>
      <Header />
      {me.kind === 'loading' && <p>Loading…</p>}
      {me.kind === 'signed-out' && <SignedOut />}
      {me.kind === 'signed-in' && <SignedIn me={me.me} />}
      {me.kind === 'error' && <ErrorPanel message={me.message} />}
    </main>
  )
}

function Header() {
  return (
    <header style={{ marginBottom: '1.5rem' }}>
      <h1 style={{ margin: 0, fontSize: '1.4rem' }}>scenetest-cloud</h1>
    </header>
  )
}

function SignedOut() {
  return (
    <section>
      <p>You're not signed in.</p>
      <p>
        <a href="/auth/github/login" style={buttonLinkStyle}>
          Sign in with GitHub
        </a>
      </p>
    </section>
  )
}

function SignedIn({ me }: { me: Me }) {
  return (
    <section>
      <p>
        Signed in as <strong>{me.github_login}</strong>.
      </p>
      <form method="POST" action="/auth/logout" style={{ marginTop: '1rem' }}>
        <button type="submit">Sign out</button>
      </form>
    </section>
  )
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <section role="alert" style={errorStyle}>
      <h2 style={{ marginTop: 0 }}>Something went wrong</h2>
      <p>The dashboard couldn't load. Try refreshing.</p>
      <details>
        <summary>Details</summary>
        <pre style={preStyle}>{message}</pre>
      </details>
    </section>
  )
}

function NotFound({ path }: { path: string }) {
  return (
    <main style={containerStyle}>
      <Header />
      <section>
        <h2 style={{ marginTop: 0 }}>404 — page not found</h2>
        <p>
          No route matches <code>{path}</code>.
        </p>
        <p>
          <a href="/">← Back to dashboard</a>
        </p>
      </section>
    </main>
  )
}

const containerStyle = {
  maxWidth: '40rem',
  margin: '3rem auto',
  padding: '0 1.25rem',
  fontFamily:
    'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  lineHeight: 1.5,
} as const

const buttonLinkStyle = {
  display: 'inline-block',
  padding: '0.5rem 0.9rem',
  border: '1px solid #333',
  borderRadius: '6px',
  textDecoration: 'none',
  color: 'inherit',
} as const

const errorStyle = {
  padding: '1rem',
  border: '1px solid #c33',
  borderRadius: '6px',
  background: '#fff5f5',
} as const

const preStyle = {
  whiteSpace: 'pre-wrap',
  fontSize: '0.85rem',
} as const
