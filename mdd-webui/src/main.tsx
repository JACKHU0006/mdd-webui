import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './styles/theme.css'

// Apply the stored theme before React mounts. Without this the first paint is always light
// and a dark-theme user gets a white flash on every navigation.
try {
  const stored = window.localStorage.getItem('mdd.theme')
  const theme =
    stored === 'light' || stored === 'dark'
      ? stored
      : window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
  document.documentElement.dataset.theme = theme
  const accent = window.localStorage.getItem('mdd.accent')
  if (accent === 'teal' || accent === 'blue' || accent === 'amber') {
    document.documentElement.dataset.accent = accent
  }
} catch {
  /* private mode: fall back to the CSS defaults */
}

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
