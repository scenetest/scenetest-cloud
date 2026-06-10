import { useEffect, useState } from 'preact/hooks'

interface Me {
  github_id: number
  github_login: string
}

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/me')
      .then((r) => (r.ok ? (r.json() as Promise<Me>) : null))
      .then((data) => setMe(data))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p>Loading…</p>
  if (!me) {
    return (
      <p>
        Not signed in. <a href="/auth/github/login">Sign in with GitHub</a>.
      </p>
    )
  }
  return (
    <div>
      <h1>scenetest-cloud</h1>
      <p>
        Signed in as <strong>{me.github_login}</strong>.
      </p>
      <form method="POST" action="/auth/logout">
        <button type="submit">Sign out</button>
      </form>
    </div>
  )
}
