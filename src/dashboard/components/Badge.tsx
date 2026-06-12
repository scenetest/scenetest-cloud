import type { ComponentChildren } from 'preact'

type Tone = 'pass' | 'fail' | 'warn' | 'accent' | 'neutral'

const toneClass: Record<Tone, string> = {
  pass:    'bg-pass-bg text-pass',
  fail:    'bg-fail-bg text-fail',
  warn:    'bg-warn-bg text-warn',
  accent:  'bg-indigo-600/10 text-indigo-600',
  neutral: 'bg-code text-muted',
}

interface Props {
  tone?: Tone
  children: ComponentChildren
  class?: string
}

export function Badge({ tone = 'neutral', children, class: cls = '' }: Props) {
  return (
    <span class={`inline-flex items-center gap-1 font-mono text-[0.7rem] font-medium px-2 rounded-sm leading-snug whitespace-nowrap ${toneClass[tone]} ${cls}`}>
      {children}
    </span>
  )
}
