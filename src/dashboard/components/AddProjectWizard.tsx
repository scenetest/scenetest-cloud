import { useState } from 'preact/hooks'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import { paths } from '../lib/paths.ts'
import { useRepoStatus } from '../hooks/useRepoStatus.ts'
import { Button } from './Button.tsx'

// Add-a-project wizard: register the repo, then a live checklist for the
// steps that happen outside this system (GitHub webhook, pipeline file,
// first PR). Each step verifies itself from evidence the worker already
// has — the copy mirrors docs/add-a-project.md, which is the long-form
// version of this flow.

interface Props {
  onClose: () => void
}

export function AddProjectWizard({ onClose }: Props) {
  const [repo, setRepo] = useState<{ owner: string; name: string } | null>(null)

  return (
    <div onClick={onClose} class='modal-overlay'>
      <div onClick={(e) => e.stopPropagation()} class='modal-box max-h-[85vh] overflow-y-auto'>
        <div class='flex items-center gap-3 px-6 py-5 border-b border-border'>
          <div class='flex-1'>
            <div class='font-mono text-lg font-medium text-ink'>Add a project</div>
            <div class='font-serif text-base text-muted mt-1'>
              {repo
                ? <>Setting up <span class='font-mono text-sm'>{repo.owner}/{repo.name}</span> — these checks update live as each step lands.</>
                : 'Watch a GitHub repository and run its scenes on every pull request.'}
            </div>
          </div>
          <button onClick={onClose} class='bg-transparent border-0 text-faint cursor-pointer font-mono text-lg leading-none'>✕</button>
        </div>

        {repo
          ? <Checklist owner={repo.owner} name={repo.name} />
          : <RegisterForm onRegistered={(owner, name) => setRepo({ owner, name })} />}

        <div class='flex justify-end px-6 py-4 border-t border-border'>
          <Button variant='secondary' size='md' onClick={onClose}>{repo ? 'Finish later' : 'Cancel'}</Button>
        </div>
      </div>
    </div>
  )
}

function RegisterForm({ onRegistered }: { onRegistered: (owner: string, name: string) => void }) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: Event) => {
    e.preventDefault()
    const m = /^\s*([^/\s]+)\/([^/\s]+)\s*$/.exec(value)
    if (!m) {
      setError('Use the owner/name form, e.g. acme/my-app')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const added = await api<{ owner: string; name: string }>('/api/admin/repos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: m[1], name: m[2] }),
      })
      void queryClient.invalidateQueries({ queryKey: ['cloud'] })
      onRegistered(added.owner, added.name)
    } catch {
      setError('Registration failed — check the worker logs.')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} class='p-6'>
      <label class='font-mono text-sm text-muted block mb-2' for='wizard-repo'>
        GitHub repository (public, for now)
      </label>
      <div class='flex gap-2'>
        <input
          id='wizard-repo'
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          placeholder='owner/name'
          class='flex-1 font-mono text-md text-ink bg-card border border-border rounded-sm px-3 py-2'
        />
        <Button variant='primary' size='md' type='submit'>{busy ? 'Adding…' : 'Add'}</Button>
      </div>
      {error && <p class='font-mono text-sm text-fail mt-2 mb-0'>{error}</p>}
      <p class='font-serif text-base text-muted mt-4 mb-0'>
        Before this is useful, the repo's scenes should pass locally at{' '}
        <code class='font-mono text-sm'>localhost/__scenetest</code> — the cloud runs the same
        scenes on a rented machine.
      </p>
    </form>
  )
}

function Checklist({ owner, name }: { owner: string; name: string }) {
  const status = useRepoStatus(owner, name, true)
  const s = status.data
  const origin = window.location.origin

  return (
    <div class='p-6 flex flex-col gap-5'>
      <Step
        done={s?.registered === true}
        title='1 · Repository registered'
        doneNote='Watching this repo.'
      >
        Waiting on registration — this should have happened already; try re-adding.
      </Step>

      <Step
        done={s?.webhook.seen === true}
        title='2 · GitHub webhook'
        doneNote={`Receiving deliveries (last: ${s?.webhook.last_event ?? '—'}).`}
      >
        <p class='m-0'>
          On GitHub: <span class='font-mono text-sm'>Settings → Webhooks → Add webhook</span>, events:{' '}
          <strong>Pull requests</strong> only, content type <span class='font-mono text-sm'>application/json</span>,
          secret: the deployment's <span class='font-mono text-sm'>GITHUB_WEBHOOK_SECRET</span>.
        </p>
        <CopyBlock label='Payload URL' text={`${origin}/webhook/github`} />
        <p class='m-0 text-muted'>
          GitHub sends a ping the moment you save — this check turns green when it arrives.
        </p>
      </Step>

      <Step
        done={s?.pipeline.state === 'active' || s?.pipeline.state === 'present'}
        title='3 · Pipeline file'
        doneNote={s?.pipeline.state === 'active'
          ? 'Pipeline stages are running on this project.'
          : 'scenetest/pipeline.json found in the repo.'}
      >
        <p class='m-0'>
          Commit <span class='font-mono text-sm'>scenetest/pipeline.json</span>: its stages take a bare
          machine to your running app, and its top-level <span class='font-mono text-sm'>scenes</span> command
          runs one batch against it. Easiest path: paste this into your coding assistant, in your repo —
        </p>
        <CopyBlock label='Prompt for your LLM' text={llmPrompt} />
        {s?.pipeline.state === 'unknown' && (
          <p class='m-0 text-muted'>Can't check GitHub right now — this verifies after the first run instead.</p>
        )}
      </Step>

      <Step
        done={s?.first_run != null}
        title='4 · First run'
        doneNote={s?.first_run ? `Run ${s.first_run.status}.` : undefined}
      >
        <p class='m-0'>
          Open (or push to) a pull request on the repo. The very first run waits ~10–15 minutes
          while the runner image builds itself; every run after boots in about a minute.
        </p>
      </Step>

      {s?.first_run && (
        <div class='flex gap-2'>
          <Button variant='primary' size='md' href={`/r/${s.first_run.id}/dashboard/`}>Open run dashboard</Button>
          <Button variant='secondary' size='md' href={paths.repo(owner, name)}>Project page</Button>
        </div>
      )}
    </div>
  )
}

function Step({ done, title, doneNote, children }: {
  done: boolean
  title: string
  doneNote?: string
  children: preact.ComponentChildren
}) {
  return (
    <div class='flex gap-3'>
      <span
        class={`mt-0.5 w-5 h-5 shrink-0 rounded-full inline-flex items-center justify-center font-mono text-xs ${
          done ? 'bg-pass text-white' : 'border border-border text-faint'
        }`}
      >
        {done ? '✓' : ''}
      </span>
      <div class='flex-1 min-w-0'>
        <div class='font-mono text-md font-medium text-ink'>{title}</div>
        <div class='font-serif text-base text-muted mt-1 flex flex-col gap-2'>
          {done ? <p class='m-0'>{doneNote}</p> : children}
        </div>
      </div>
    </div>
  )
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div>
      <div class='flex items-center justify-between mb-1'>
        <span class='font-mono text-xs text-faint'>{label}</span>
        <button
          onClick={copy}
          class='bg-transparent border-0 cursor-pointer font-mono text-xs text-accent p-0'
        >
          {copied ? 'copied ✓' : 'copy'}
        </button>
      </div>
      <pre class='font-mono text-xs bg-code rounded-sm p-3 m-0 whitespace-pre-wrap break-all max-h-40 overflow-y-auto'>{text}</pre>
    </div>
  )
}

// Condensed from docs/pipeline.md's "For LLMs setting up a repo" — enough
// for an assistant working inside the target repo, no external links needed.
const llmPrompt = `Create scenetest/pipeline.json for this repo.

Schema: {"version":1,"stages":[{"name":"...","watch":["globs"],"run":"one shell line"}],"scenes":"one shell line"}
Stages run in order on a test VM (node, pnpm, docker, supabase CLI preinstalled); a stage re-runs only when a file matching its watch globs changes, and a changed stage re-runs everything after it. Globs: ** crosses directories, * stays in one segment, no negation.

Build it like this:
1. deps — watch the lockfile only; run the frozen-lockfile install.
2. db — watch the database dir (supabase/, prisma/, migrations/); run the reset+seed command (supabase: "supabase start && supabase db reset").
3. build — watch source + config (src/**, *.config.*, tsconfig*.json); run the build (+ typegen if any).
4. serve — watch []; start the app on a port in the background and exit (e.g. "(pnpm preview --port 4173 &) && sleep 2").
5. scenes (top-level field, NOT a stage) — run the scenes CLI: "pnpm exec scenetest" (binary is scenetest; there is no "run" subcommand). The box sets SCENETEST_REPORT_URL, so @scenetest/scenes >=0.15 streams its events to the dashboard automatically — no --report-url flag and no event file needed. Point scenes at the served app via your Playwright/scene config, not a CLI flag. Non-zero exit marks the run failed; otherwise the run:end event settles the verdict.

Rules: watch inputs never outputs (lockfile not node_modules, src/** not dist/**); stage names [a-z0-9_-]; when unsure widen the glob; strict JSON, version must be the number 1. There is no --subset flag — run a subset with positional scene paths.

Sanity-check before finishing: a lockfile change should re-run everything; a src/ change only build+serve; a docs change nothing.`
