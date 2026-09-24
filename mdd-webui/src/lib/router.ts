/**
 * Minimal hash router.
 *
 * Hash routing is a deliberate choice over history routing: the same `dist/` has to work
 * three ways — served by the FastAPI control plane (which already has an SPA fallback),
 * served by Cloudflare Pages, and served from a Worker with a static-assets binding. Hash
 * routes need no server-side rewrite rule in any of them, so a deep link can never 404.
 */
import { useCallback, useEffect, useState } from 'react'

export interface Route {
  /** First path segment, e.g. `devices`. Empty string means the default view. */
  name: string
  /** Remaining segments, already decoded. */
  params: string[]
  /** Raw query string without the leading `?`. */
  query: string
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const [pathPart = '', query = ''] = raw.split('?')
  const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent)
  return { name: segments[0] ?? '', params: segments.slice(1), query }
}

export function useRoute(): Route & { navigate: (to: string, replace?: boolean) => void } {
  const [route, setRoute] = useState<Route>(parseHash)

  useEffect(() => {
    const onChange = () => setRoute(parseHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = useCallback((to: string, replace = false) => {
    const target = to.startsWith('#') ? to : `#/${to.replace(/^\/+/, '')}`
    if (window.location.hash === target) {
      // Same hash produces no event; re-parse so a caller can force a re-render.
      setRoute(parseHash())
      return
    }
    if (replace) {
      window.history.replaceState(null, '', target)
      setRoute(parseHash())
    } else {
      window.location.hash = target
    }
  }, [])

  return { ...route, navigate }
}

/** Read one key out of a route's query string. */
export function queryParam(query: string, key: string): string | null {
  return new URLSearchParams(query).get(key)
}
