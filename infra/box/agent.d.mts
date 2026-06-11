// Type companion for agent.mjs when imported by the worker: wrangler's
// [[rules]] Text module turns it into a string at build time (the agent
// source is an input to the image stage and gets baked into the snapshot
// via cloud-init). At runtime on a box it executes as plain node — this
// declaration only describes the worker's view.
declare const text: string
export default text
