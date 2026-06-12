// One SHA-256-to-hex for the worker. Everything that hashes here — bearer
// tokens, the image stage, pipeline stage vectors — is this digest with at
// most a length cut on top.
const enc = new TextEncoder()

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
