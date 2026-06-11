import type { Env } from '../env.ts'

// Thin DigitalOcean API client shared by the provider (droplets for boxes)
// and the image stage (builder droplets + snapshots).

const DO_API = 'https://api.digitalocean.com/v2'

export async function doApi<T = unknown>(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const resp = await fetch(`${DO_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.DO_API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!resp.ok) {
    throw new Error(`DO ${method} ${path} failed: ${resp.status} ${await resp.text()}`)
  }
  // DELETE returns 204 with no body.
  return resp.status === 204 ? (undefined as T) : ((await resp.json()) as T)
}

// 204 means destroyed; 404 means already gone — both leave us in the state
// we want, so both count as success.
export async function destroyDroplet(env: Env, dropletId: string | number): Promise<boolean> {
  const resp = await fetch(`${DO_API}/droplets/${dropletId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${env.DO_API_TOKEN}` },
  })
  return resp.status === 204 || resp.status === 404
}

export async function dropletStatus(env: Env, dropletId: string | number): Promise<string | null> {
  const resp = await fetch(`${DO_API}/droplets/${dropletId}`, {
    headers: { authorization: `Bearer ${env.DO_API_TOKEN}` },
  })
  if (resp.status === 404) return null
  if (!resp.ok) throw new Error(`DO GET /droplets/${dropletId} failed: ${resp.status}`)
  const { droplet } = (await resp.json()) as { droplet: { status: string } }
  return droplet.status
}
