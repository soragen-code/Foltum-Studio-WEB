'use client'

/**
 * Stage 234i — SSR-safe localStorage-backed state for /manual form drafts.
 *
 * Persists the field VALUES a user typed/selected/attached so they survive a browser refresh. Reads lazily
 * (never during SSR / initial hydration) and writes on every change. Storage access is guarded with
 * `typeof window` checks and all JSON parsing is wrapped in try/catch (falls back to the default on any error).
 *
 * NOTE: to avoid a hydration mismatch the initial render always uses `initial`; the persisted value is
 * applied in a mount effect. This is intentional — transient job flags/spinners are NOT persisted here.
 */
import { useEffect, useRef, useState } from 'react'

export function usePersistentState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial)
  const loaded = useRef(false)

  // Load once on mount (client only) — after hydration, so server & first client render agree.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(key)
      if (raw != null) setValue(JSON.parse(raw) as T)
    } catch {
      /* ignore malformed / unavailable storage */
    } finally {
      loaded.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Persist on change — but only after the initial load, so we never clobber the stored value with `initial`.
  useEffect(() => {
    if (typeof window === 'undefined' || !loaded.current) return
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* quota / unavailable — ignore */
    }
  }, [key, value])

  return [value, setValue]
}
