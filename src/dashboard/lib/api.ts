export interface ApiError extends Error {
  status: number
  body: unknown
}

// Small fetch wrapper that throws a typed ApiError instead of leaving the
// caller to remember to check r.ok, and logs failures with a tidy prefix so
// they're scannable in the browser console.
export async function api<T>(input: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(input, init)
  } catch (cause) {
    console.error(`[api] network error: ${input}`, cause)
    throw cause
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const err = new Error(
      `[api] ${init?.method ?? 'GET'} ${input} -> ${res.status}`,
    ) as ApiError
    err.status = res.status
    err.body = body
    if (res.status >= 500) console.error(err.message, body)
    throw err
  }
  return res.json() as Promise<T>
}
