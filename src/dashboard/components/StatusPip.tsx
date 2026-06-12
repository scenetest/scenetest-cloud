interface Props {
  status: string
  className?: string
}

export function StatusPip({ status, className = '' }: Props) {
  const label =
    status === 'passed' || status === 'pass' ? 'passing'
    : status === 'failed' || status === 'fail' ? 'failing'
    : status === 'running' ? 'running'
    : status === 'queued' ? 'queued'
    : status

  const tone =
    status === 'passed' || status === 'pass' ? 'pass'
    : status === 'failed' || status === 'fail' ? 'fail'
    : status === 'running' ? 'running'
    : 'queued'

  return (
    <span className={`status-pip ${tone} ${className}`}>
      <span className='dot' />
      {label}
    </span>
  )
}
