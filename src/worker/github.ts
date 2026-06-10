// Shared bits for talking to api.github.com (OAuth user fetch, admin lookups,
// and eventually webhook verification).
export const GH_API_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'scenetest-cloud',
} as const
