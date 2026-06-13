// Test-only shim for the `cloudflare:workers` runtime module. partyserver
// (pulled in by the Pr coordinator spike) does `import { DurableObject } from
// "cloudflare:workers"` at module load; node's ESM loader can't resolve that
// scheme, so the node-based unit tests that transitively import the DO blow up
// before any test runs. This provides just enough of the base class for those
// import chains to load. Workerd supplies the real module at runtime; the e2e
// harness (real worker) exercises the actual behavior.
export class DurableObject<Env = unknown> {
  constructor(
    public ctx: DurableObjectState,
    public env: Env,
  ) {}
}
