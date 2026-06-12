import type { Me } from '../hooks/useMe.ts'
import { Button } from './Button.tsx'

interface Props {
  me: Me
  currentView: string
  onNavigate: (view: string) => void
}

export function NavBar({ me, currentView, onNavigate }: Props) {
  return (
    <header class='nav-bar'>
      <span onClick={() => onNavigate('overview')} class='cursor-pointer font-mono font-semibold text-base tracking-hero text-ink'>
        scenetest
      </span>
      <span class='cloud-tag'>cloud</span>
      <nav class='flex gap-6 ml-2'>
        {(['overview', 'projects'] as const).map((view) => (
          <a
            key={view}
            href='#'
            onClick={(e) => { e.preventDefault(); onNavigate(view) }}
            class={currentView === view ? 'active' : ''}
          >
            {view === 'overview' ? 'Overview' : 'Projects'}
          </a>
        ))}
      </nav>
      <div class='flex items-center gap-4 ml-auto'>
        <span class='font-mono text-sm text-muted'>{me.github_login}</span>
        <form method='POST' action='/auth/logout' style={{ margin: 0 }}>
          <Button variant='secondary' size='sm' type='submit'>Sign out</Button>
        </form>
      </div>
    </header>
  )
}
