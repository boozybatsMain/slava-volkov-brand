// Generates the paper pixels off the main thread (≈150 ms at 1440×900@2 — no jank).
import { deviceSize, paperPixels, type TextureSpec } from './texture'

interface Job {
  id: number
  spec: TextureSpec
}

// Minimal typing for the worker global (keeps the project on the DOM lib only).
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Job>) => void) | null
  postMessage(message: unknown, transfer: Transferable[]): void
}

scope.onmessage = (e) => {
  const { id, spec } = e.data
  const { W, H } = deviceSize(spec)
  const data = paperPixels(spec)
  scope.postMessage({ id, W, H, buf: data.buffer }, [data.buffer])
}
