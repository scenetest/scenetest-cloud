'use strict'

// The two worker checks this repo already had, carried over from the old
// single-job CI and rendered into the same comment as everything else.
//
//   node -e "require('./.github/ci/render-worker.cjs')({
//     dir: '/tmp/out', out: '/tmp/out/fragments'
//   })"
//
// Both are head-only: they answer "does this tree's worker boot and bundle?",
// and there is nothing on the base branch to diff that against.
//
//   e2e     `pnpm e2e` — scripts/e2e.mjs boots wrangler dev + workerd against a
//           throwaway D1 and exercises auth, webhooks, and the event log.
//   deploy  `wrangler deploy --dry-run` — the only thing that validates
//           wrangler.toml and the D1, R2, and Durable Object bindings. It
//           bundles exactly as a deploy would, without deploying.
//
// Each runs in the head job under `continue-on-error`, writes its outcome to
// `<check>.outcome` and its log to `<check>.log`, and this turns the pair into
// fragments plus gate sidecars.

const fs = require('fs')
const path = require('path')

// Enough lines to carry one failure plus the context above it.
const EXCERPT = 40

const CHECKS = [
	{
		check: 'deploy',
		fragment: '45-deploy',
		title: 'Worker bundle (`wrangler deploy --dry-run`)',
		ok: 'The worker bundles and its bindings validate.',
		bad: 'The worker does not bundle, or a binding in `wrangler.toml` is invalid.',
	},
	{
		check: 'e2e',
		fragment: '55-e2e',
		title: 'End-to-end (`pnpm e2e`)',
		ok: 'The worker boots under workerd and answers every checked seam.',
		bad: 'The end-to-end run failed.',
	},
]

const read = (p) => {
	try {
		return fs.readFileSync(p, 'utf8')
	} catch {
		return ''
	}
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

/** The tail of the log. Both of these report their failure last, not first. */
function excerpt(log) {
	const lines = stripAnsi(log)
		.split('\n')
		.filter((l) => l.trim() !== '')
	if (!lines.length) return '_The step produced no output._'
	const shown = lines.slice(-EXCERPT)
	const dropped = lines.length - shown.length
	return (
		'```\n' +
		(dropped > 0 ? `… ${dropped} earlier line(s) in the job log\n` : '') +
		shown.join('\n') +
		'\n```'
	)
}

module.exports = function render({ dir, out }) {
	fs.mkdirSync(out, { recursive: true })

	for (const c of CHECKS) {
		// An absent outcome file means the step never reached the recording step.
		// That is a crashed job, not a pass, so say so and let the gate fail.
		const outcome = read(path.join(dir, `${c.check}.outcome`)).trim()
		const ok = outcome === 'success'

		const markdown = [
			`#### ${c.title}`,
			'',
			ok ? `✅ ${c.ok}`
			: outcome ? `❌ **${c.bad}** (\`${outcome}\`)`
			: `⚠️ **No result was recorded.** The job died before this step ran.`,
			...(ok || !outcome ? [] : ['', excerpt(read(path.join(dir, `${c.check}.log`)))]),
		].join('\n')

		fs.writeFileSync(path.join(out, `${c.fragment}.md`), markdown)
		fs.writeFileSync(
			path.join(out, `${c.fragment}.json`),
			JSON.stringify({ check: c.check, ok, outcome, missing: !outcome, label: c.title }, null, 2)
		)
	}
}

module.exports.CHECKS = CHECKS
module.exports.excerpt = excerpt
