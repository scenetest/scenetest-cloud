import type { ComponentChildren } from 'preact'

type Variant = 'primary' | 'secondary' | 'ghost'
type Size = 'sm' | 'md' | 'lg'

const variantClass: Record<Variant, string> = {
  primary:   'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700',
  secondary: 'bg-card text-ink border-border hover:border-indigo-600',
  ghost:     'bg-transparent text-term-quiet border-term-border hover:bg-term-border hover:text-white',
}

const sizeClass: Record<Size, string> = {
  sm: 'px-2.5 py-1 text-[0.75rem]',
  md: 'px-4 py-2 text-[0.85rem]',
  lg: 'px-4.5 py-2.5 text-[0.85rem]',
}

interface Props {
  variant?: Variant
  size?: Size
  type?: 'button' | 'submit'
  onClick?: () => void
  href?: string
  children: ComponentChildren
  class?: string
}

export function Button({ variant = 'secondary', size = 'md', type = 'button', onClick, href, children, class: cls = '' }: Props) {
  const base = `inline-flex items-center gap-1.5 font-mono font-medium rounded-sm border cursor-pointer transition-all duration-[120ms] whitespace-nowrap leading-none no-underline ${variantClass[variant]} ${sizeClass[size]} ${cls}`
  if (href) return <a href={href} class={base}>{children}</a>
  return <button type={type} onClick={onClick} class={base}>{children}</button>
}
