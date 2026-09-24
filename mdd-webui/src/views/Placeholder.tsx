/**
 * Honest placeholder for screens that are not built yet.
 *
 * It lists the control-plane endpoints the screen will be wired to, so the remaining work
 * is visible in the UI rather than hidden in a TODO. Delete a route from `ROADMAP` as its
 * real view lands.
 */
import { useI18n } from '../lib/i18n.tsx'

interface RoadmapEntry {
  title: string
  summary: string
  endpoints: string[]
  /** Caveat that must be surfaced in the UI, not buried in a code comment. */
  note?: string
}

/**
 * Every screen is built. Kept as an empty table so an unknown hash still has somewhere to land
 * with a real answer instead of a blank page.
 */
const ROADMAP: Record<string, RoadmapEntry> = {}

export function Placeholder({ route }: { route: string }) {
  const { t } = useI18n()
  const entry = ROADMAP[route]

  if (!entry) {
    return (
      <div className="card">
        <div className="card-body">
          <h2>Not found</h2>
          <p className="muted small">No view is registered for this route.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="card-head">
        <strong style={{ fontWeight: 500 }}>{entry.title}</strong>
        <span className="badge badge-warn">Not implemented yet</span>
      </div>
      <div className="card-body stack">
        <p className="small" style={{ margin: 0 }}>
          {entry.summary}
        </p>

        {entry.note ? (
          <div className="alert alert-warn">
            <span>{entry.note}</span>
          </div>
        ) : null}

        <div>
          <div className="xs faint" style={{ marginBottom: 'var(--space-2)' }}>
            Control-plane endpoints this screen will use
          </div>
          <div className="stack" style={{ gap: 3 }}>
            {entry.endpoints.map((endpoint) => (
              <code key={endpoint} className="xs mono muted">
                {endpoint}
              </code>
            ))}
          </div>
        </div>

        <p className="xs faint" style={{ margin: 0 }}>
          {t('common.discDemo')}
        </p>
      </div>
    </div>
  )
}
