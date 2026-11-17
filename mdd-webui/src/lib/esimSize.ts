/**
 * Per-profile storage measurement.
 *
 * SGP.22 has no per-profile size field: ES10b's `EUICCInfo2.extCardResource` gives only
 * `freeNonVolatileMemory`, and ES10c's profile metadata carries iccid/state/nickname/class
 * but no size. So "how much does this profile occupy" cannot be *read* from the card.
 *
 * What can be measured is the drop in free space across an install, which is the honest
 * definition of what it occupies (profile package + its ISD-P metadata). Free space is sampled
 * on every card load; a load that shows both a smaller `freeSpace` and a new ICCID is an
 * install, and the difference is attributed to the new ICCID.
 *
 * Two consequences, stated here because the UI states them too:
 *   - a profile installed before the first sample has no measurement (shown as "—" rather
 *     than a fabricated average);
 *   - an install that happens while the browser is closed is missed. The snapshot is written
 *     on load, so the next load after the install still catches it.
 */
import { useEffect, useState } from 'react'
import type { EsimCardView, EsimSecureElement } from './types.ts'

export interface SizeRecord {
  bytes: number
  at: number
}

const SIZES_KEY = 'mdd.esim.sizes'
const SNAP_KEY = 'mdd.esim.snap'

interface Snapshot {
  free: number
  iccids: string[]
  at: number
}

type Snapshots = Record<string, Snapshot>

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    // Private mode / corrupted value: behave as if nothing was measured yet.
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota or private mode: measurements are a convenience, never a requirement */
  }
}

export function readSizes(): Record<string, SizeRecord> {
  return readJson<Record<string, SizeRecord>>(SIZES_KEY, {})
}

/** `${eid}:${iccid}` — EID is part of the key so a swapped card never inherits old sizes. */
export function sizeKey(eid: string | null | undefined, iccid: string): string {
  return `${eid || 'no-eid'}:${iccid}`
}

export interface ObserveResult {
  sizes: Record<string, SizeRecord>
  measuredNow: string[]
}

export function observeStorage(ses: EsimSecureElement[]): ObserveResult {
  const sizes = readSizes()
  const snaps = readJson<Snapshots>(SNAP_KEY, {})
  const measuredNow: string[] = []

  for (const se of ses) {
    const eid = se.eid
    const free = se.freeSpace
    const iccids = (se.profiles ?? []).map((profile) => String(profile.iccid ?? '')).filter(Boolean)
    if (!eid || free === null || free === undefined || iccids.length === 0) continue

    const previous = snaps[eid]
    if (previous && previous.free > free) {
      const added = iccids.filter((iccid) => !previous.iccids.includes(iccid))
      if (added.length > 0) {
        const per = Math.round((previous.free - free) / added.length)
        for (const iccid of added) {
          const key = sizeKey(eid, iccid)
          // Never let a later, coarser sample overwrite an earlier measurement.
          if (!sizes[key]) {
            sizes[key] = { bytes: per, at: Date.now() }
            measuredNow.push(iccid)
          }
        }
      }
    }

    snaps[eid] = { free, iccids, at: Date.now() }
  }

  writeJson(SIZES_KEY, sizes)
  writeJson(SNAP_KEY, snaps)
  return { sizes, measuredNow }
}

/** Total measured occupancy, for the header line. */
export function sumMeasured(
  eid: string | null | undefined,
  iccids: string[],
  sizes: Record<string, SizeRecord>,
): { total: number; count: number } {
  let total = 0
  let count = 0
  for (const iccid of iccids) {
    const record = sizes[sizeKey(eid, iccid)]
    if (record) {
      total += record.bytes
      count += 1
    }
  }
  return { total, count }
}

/** Keeps the size map in sync with every card load. */
export function useProfileSizes(card: EsimCardView | null): Record<string, SizeRecord> {
  const [sizes, setSizes] = useState<Record<string, SizeRecord>>(() => readSizes())
  useEffect(() => {
    if (!card) return
    const result = observeStorage(card.ses ?? [])
    setSizes({ ...result.sizes })
  }, [card])
  return sizes
}
