/**
 * Theme preference. Kept out of the i18n provider because it is a display concern that
 * also has to be applied before first paint (see the inline script in `main.tsx`).
 */
import { useCallback, useEffect, useState } from 'react'

export const THEMES = ['light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

export const ACCENTS = ['teal', 'blue', 'amber'] as const
export type Accent = (typeof ACCENTS)[number]

const THEME_KEY = 'mdd.theme'
const ACCENT_KEY = 'mdd.accent'

function readTheme(): Theme {
  const stored = window.localStorage.getItem(THEME_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readAccent(): Accent {
  const stored = window.localStorage.getItem(ACCENT_KEY)
  if (stored === 'teal' || stored === 'blue' || stored === 'amber') return stored
  return 'teal'
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readTheme)
  const [accent, setAccentState] = useState<Accent>(readAccent)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset.accent = accent
  }, [accent])

  const setTheme = useCallback((next: Theme) => {
    window.localStorage.setItem(THEME_KEY, next)
    setThemeState(next)
  }, [])

  const setAccent = useCallback((next: Accent) => {
    window.localStorage.setItem(ACCENT_KEY, next)
    setAccentState(next)
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme(readTheme() === 'dark' ? 'light' : 'dark')
  }, [setTheme])

  return { theme, accent, setTheme, setAccent, toggleTheme }
}
