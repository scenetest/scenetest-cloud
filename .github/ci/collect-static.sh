#!/usr/bin/env bash
# Collect normalised static-check output into $1.
#
# Runs once on the head tree and once on the base tree, always from that tree's
# own root. Output is one sorted line per issue, so the diff engine can treat
# the two runs as comparable sets.
#
# This repo has no linter and no formatter, so the typecheck is the whole of
# the static pass. Add a block here if either arrives later — one file per
# check, `file:line:col: message` per line, sorted.

# Deliberately no `-e`: the typechecker exits non-zero when it finds errors,
# which is the normal case, not a script failure.
set -uo pipefail

OUT="${1:?usage: collect-static.sh <output-dir>}"
mkdir -p "$OUT"

# Byte-order sorting, so the two trees produce comparable lists even if the two
# runners ever differ in locale.
export LC_ALL=C

# Calls the TOOL, not the `typecheck` script, although package.json has one.
# This script is fetched from head and run against the BASE tree, so it must
# only use things both trees have. `tsc` is a devDependency, present on both;
# a script name is not — a PR that adds or renames one would break the base
# measurement, and a broken base measurement fails the gate with an error
# about the wrong thing.
#
# `--noEmit` is spelled out here for the same reason, and the two are trivially
# the same today: `"typecheck": "tsc --noEmit"`.
#
# No generated declarations are needed first: the worker's types come from
# @cloudflare/workers-types in devDependencies, not from `wrangler types`.
#
# Keep the grep — it drops the summary lines, which change with the error count
# and would otherwise diff as noise.
pnpm exec tsc --noEmit 2>&1 | grep ': error TS' | sort >"$OUT/typecheck.txt"
status=${PIPESTATUS[0]}

# A typechecker that failed but printed nothing the grep recognises would leave
# an empty file, which reads as zero errors and merges clean. Record the
# failure as an issue instead.
if [ "$status" -ne 0 ] && [ ! -s "$OUT/typecheck.txt" ]; then
	echo "typecheck:0:0: error TS0000: the typechecker exited $status without recognisable error lines — see the job log" \
		>"$OUT/typecheck.txt"
fi

# Never let a missing file break the render step.
[ -f "$OUT/typecheck.txt" ] || : >"$OUT/typecheck.txt"

wc -l "$OUT"/*.txt
