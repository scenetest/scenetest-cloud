import type { Me } from '../hooks/useMe.ts'

interface Props {
  me: Me
  currentView: string
  onNavigate: (view: string) => void
}

export function NavBar({ me, currentView, onNavigate }: Props) {
  return (
    <header className='nav-bar'>
      <span
        onClick={() => onNavigate('overview')}
        className='cursor-pointer'
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: '1rem', letterSpacing: '-0.02em', color: 'var(--ink-900)' }}>
          scenetest
        </span>
      </span>
      <span className='cloud-tag'>cloud</span>
      <nav className='flex gap-6' style={{ marginLeft: 8 }}>
        {(['overview', 'projects'] as const).map((view) => (
          <a
            key={view}
            href='#'
            onClick={(e) => { e.preventDefault(); onNavigate(view) }}
            className={currentView === view ? 'active' : ''}
          >
            {view === 'overview' ? 'Overview' : 'Projects'}
          </a>
        ))}
      </nav>
      <div className='flex items-center gap-4 ml-auto'>
        <span className='font-mono text-sm text-muted'>{me.github_login}</span>
        <form method='POST' action='/auth/logout' style={{ margin: 0 }}>
          <button type='submit' className='btn btn-sm btn-secondary'>Sign out</button>
        </form>
      </div>
    </header>
  )
}
