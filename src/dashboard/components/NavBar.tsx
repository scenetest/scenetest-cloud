import { useLocation } from 'preact-iso'
import type { Me } from '../hooks/useMe.ts'
import { paths } from '../lib/paths.ts'
import { Button } from './Button.tsx'

interface Props {
  me: Me
}

export function NavBar({ me }: Props) {
  const { path } = useLocation()

  return (
    <header class='nav-bar'>
      <a href={paths.overview()} class='cursor-pointer font-mono font-semibold text-base tracking-hero text-ink no-underline'>
        scenetest
      </a>
      <span class='cloud-tag'>cloud</span>
      <nav class='flex gap-6 ml-2'>
        <a href={paths.overview()} class={path === paths.overview() ? 'active' : ''}>Overview</a>
        <a href={paths.projects()} class={path === paths.projects() ? 'active' : ''}>Projects</a>
      </nav>
      <div class='flex items-center gap-4 ml-auto'>
        <span class='font-mono text-sm text-muted hidden sm:inline'>{me.github_login}</span>
        <form method='POST' action='/auth/logout' style={{ margin: 0 }}>
          <Button variant='secondary' size='sm' type='submit'>Sign out</Button>
        </form>
      </div>
    </header>
  )
}
