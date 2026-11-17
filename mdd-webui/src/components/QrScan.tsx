/**
 * QR scan / decode for eSIM activation codes.
 *
 * Three input paths, because in practice the code arrives in three different shapes:
 *
 *   1. Camera — a printed or on-screen QR the operator points at the laptop.
 *   2. Image file — a saved QR (screenshot from a shop's email or web page).
 *   3. Clipboard — Ctrl+V right after taking a screenshot; the most common case by far,
 *      and the one that costs nothing to support because the image is already on the
 *      clipboard.
 *
 * Decoding is done locally with jsQR on a canvas: the activation code never leaves the
 * browser, and no camera permission is needed for paths 2 and 3. The camera stream is
 * released as soon as a code is found, on unmount, and on any decode error — a preview
 * that keeps the light on after success is a battery bug people notice immediately.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { useI18n } from '../lib/i18n.tsx'

/** ~4.5 attempts/second: enough to feel instant, cheap enough to keep the CPU cool. */
const CAMERA_INTERVAL_MS = 220

async function decodeBlob(blob: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(bitmap, 0, 0)
    const frame = context.getImageData(0, 0, canvas.width, canvas.height)
    // attemptBoth: shops sometimes invert the code on a dark card.
    const found = jsQR(frame.data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' })
    return found?.data ?? null
  } finally {
    bitmap.close?.()
  }
}

export function QrScan({ onDetect }: { onDetect: (text: string) => void }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<number | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  // Kept in a ref so the paste listener (bound once per mount) sees the latest callback.
  const detectRef = useRef(onDetect)
  detectRef.current = onDetect

  const accept = useCallback((text: string) => {
    const clean = text.trim()
    if (!clean) {
      setError(t('esim.scanEmpty'))
      return
    }
    detectRef.current(clean)
  }, [t])

  const stopCamera = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    const stream = streamRef.current
    streamRef.current = null
    stream?.getTracks().forEach((track) => track.stop())
    if (videoRef.current) videoRef.current.srcObject = null
    setScanning(false)
  }, [])

  useEffect(() => stopCamera, [stopCamera])

  /** Path 3: an image that is already on the clipboard. */
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items
      if (!items) return
      const image = Array.from(items).find((item) => item.type.startsWith('image/'))
      if (!image) return
      const blob = image.getAsFile()
      if (!blob) return
      event.preventDefault()
      setBusy(true)
      setError(null)
      decodeBlob(blob)
        .then((text) => {
          if (text) accept(text)
          else setError(t('esim.scanNotFound'))
        })
        .catch(() => setError(t('esim.scanNotFound')))
        .finally(() => setBusy(false))
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [accept, t])

  const pickFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const text = await decodeBlob(file)
      if (text) accept(text)
      else setError(t('esim.scanNotFound'))
    } catch {
      setError(t('esim.scanNotFound'))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  /** Path 1: camera. Needs a user gesture (this click) for the permission prompt. */
  const startCamera = async () => {
    setError(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(t('esim.scanUnsupported'))
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      streamRef.current = stream
      setScanning(true)
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => undefined)
      }
      timerRef.current = window.setInterval(async () => {
        const video = videoRef.current
        if (!video || video.readyState < 2) return
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        if (!canvas.width || !canvas.height) return
        const context = canvas.getContext('2d')
        if (!context) return
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const frame = context.getImageData(0, 0, canvas.width, canvas.height)
        const found = jsQR(frame.data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' })
        if (found?.data) {
          stopCamera()
          accept(found.data)
        }
      }, CAMERA_INTERVAL_MS)
    } catch {
      // Denied permission, no camera, or a camera already held by another app.
      stopCamera()
      setError(t('esim.scanCameraFailed'))
    }
  }

  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }}>
      <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void startCamera()}>
          {t('esim.scanCamera')}
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? `${t('esim.scanning')}…` : t('esim.scanFile')}
        </button>
        <span className="small muted">{t('esim.scanPaste')}</span>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(event) => void pickFile(event.target.files?.[0])}
      />

      {scanning ? (
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <button type="button" className="btn btn-sm" onClick={stopCamera}>
            {t('esim.scanStop')}
          </button>
          <span className="small muted">{t('esim.scanPoint')}</span>
        </div>
      ) : null}

      {/* One element only: swapping two <video> nodes on the state change would drop the
          MediaStream that was just attached to the first one. */}
      <video
        ref={videoRef}
        muted
        playsInline
        style={{
          display: scanning ? 'block' : 'none',
          width: '100%',
          maxHeight: 240,
          borderRadius: 8,
          background: '#000',
        }}
      />

      {error ? <span className="small" style={{ color: 'var(--danger, #c0392b)' }}>{error}</span> : null}
    </div>
  )
}
