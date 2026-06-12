import type { RepoSetup } from '../types.ts'

// Onboarding progress as a braille-like cell: four dots (registered, webhook,
// pipeline, first run), filled as each step lands. Reads as "steps till ready"
// at a glance — shown while a repo isn't live yet, in place of PR pips.
const LABELS = ['registered', 'webhook', 'pipeline', 'first run'] as const

export function SetupDots({ setup }: { setup: RepoSetup }) {
  const done = [true, setup.webhook, setup.pipeline, setup.first_run]
  const count = done.filter(Boolean).length
  const remaining = LABELS.filter((_, i) => !done[i])
  const title = `Setting up · ${count}/4 done` + (remaining.length ? ` · next: ${remaining[0]}` : '')

  return (
    <span class='inline-flex items-center gap-2' title={title}>
      <span class='inline-grid grid-cols-2 gap-[3px]'>
        {done.map((d, i) => (
          <span
            key={i}
            class={`w-[5px] h-[5px] rounded-full ${d ? 'bg-ink' : 'border border-faint'}`}
          />
        ))}
      </span>
      <span class='font-mono text-3xs text-faint'>setting up</span>
    </span>
  )
}
