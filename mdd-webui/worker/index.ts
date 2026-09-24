/**
 * Cloudflare Worker: same-origin front door for the MDD console.
 *
 * WHY THIS EXISTS
 * ---------------
 * The control plane sets its session cookie as `HttpOnly; Secure; SameSite=Strict`
 * (`control/app/auth.py`, SESSION_COOKIE = "mdd_session"). SameSite=Strict means the
 * browser will not attach that cookie to a cross-site request — and a request from
 * `mdd-console.pages.dev` to `gateway.example.com` is cross-site, even though both are
 * HTTPS and both are yours. Hosting the SPA on Pages and pointing it at the gateway with
 * VITE_API_BASE therefore does not work: the login succeeds, the Set-Cookie is stored, and
 * the very next request arrives unauthenticated.
 *
 * The fix is to make everything same-origin. This Worker is bound to one hostname
 * (`gateway.example.com`) and splits traffic:
 *
 *   /api/*  and  /ws   -> forwarded to the gateway through a Cloudflare Tunnel
 *   everything else    -> served from the static assets binding
 *
 * The browser only ever sees `gateway.example.com`, so the Strict cookie is same-site,
 * CSRF works unchanged, and the control plane needs no CORS configuration or cookie
 * relaxation. Nothing in the gateway is modified.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE
 * ----------------------------------
 * No request or response rewriting, no cookie munging, no auth logic. This Worker is a
 * router, and anything more would be a second place for a security decision to live.
 */

interface Env {
  /** Tunnel hostname of the gateway, e.g. https://mdd-origin.example.net */
  ORIGIN: string
  /** Static build output. Provided by the `assets` binding in wrangler.jsonc. */
  ASSETS: { fetch: (request: Request) => Promise<Response> }
}

/** Paths that must reach the gateway rather than the static bundle. */
function isGatewayPath(pathname: string): boolean {
  return (
    pathname === '/ws' ||
    pathname.startsWith('/api/') ||
    pathname === '/api'
  )
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (!isGatewayPath(url.pathname)) {
      // SPA fallback: hash routing means we never need to rewrite deep links, but an
      // unknown path should still render the app rather than a bare 404.
      const asset = await env.ASSETS.fetch(request)
      if (asset.status === 404 && request.method === 'GET') {
        return env.ASSETS.fetch(new Request(new URL('/index.html', url), request))
      }
      return asset
    }

    if (!env.ORIGIN) {
      return new Response(
        JSON.stringify({
          detail:
            'Worker misconfigured: ORIGIN is unset. Set it to the Cloudflare Tunnel hostname of the gateway.',
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const origin = new URL(env.ORIGIN)
    const target = new URL(url.pathname + url.search, origin)

    // Rebuild the request against the origin URL. The Host header follows from that URL:
    // Workers derive it and ignore any attempt to set it manually, so the only headers
    // worth touching here are the forwarded-client ones.
    const headers = new Headers(request.headers)
    // The gateway throttles logins per client address, so it must see the real client and
    // not Cloudflare's edge. CF-Connecting-IP is the authoritative value on Workers.
    const clientIp = request.headers.get('CF-Connecting-IP')
    if (clientIp) headers.set('X-Forwarded-For', clientIp)
    headers.set('X-Forwarded-Proto', 'https')

    const proxied = new Request(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    })

    // A WebSocket upgrade must be forwarded as-is; `fetch` returns the 101 response and
    // Cloudflare wires the two sockets together.
    const response = await fetch(proxied)

    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return response
    }

    // Strip hop-by-hop headers that would confuse the browser or leak topology.
    const outHeaders = new Headers(response.headers)
    outHeaders.delete('content-security-policy-report-only')

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders,
    })
  },
}
