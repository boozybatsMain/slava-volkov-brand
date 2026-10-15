/**
 * Per-channel compositing of a transparent WebGL canvas over the rest of the hero — what the
 * chromatic aberration (core/aberration.ts) needs from every layer that is not opaque.
 *
 * An aberrated edge is a pixel where the three channels have DIFFERENT coverage (red already on the
 * letter or the cloud, blue still on what is below). A canvas has one alpha, so it cannot say that.
 * While the split is on, the layer is shown as two elements that the browser composites per channel:
 *   mask  — a 2D canvas, mix-blend-mode multiply: (1 − alpha_r, 1 − alpha_g, 1 − alpha_b), opaque;
 *   light — the WebGL canvas itself, mix-blend-mode plus-lighter: each channel's premultiplied colour.
 * below_c · (1 − alpha_c) + colour_c is plain source-over, per channel. The layer renders the mask,
 * copy() takes it into the 2D canvas, then the layer renders the light (the canvas keeps that).
 *
 * Blend modes reach the layers below only from the hero's own stacking context, so while on, the
 * layer's mount must not be one: its z-index goes to both canvases, and its CSS containment is
 * lifted (layout or paint containment makes a stacking context too — the canvases would blend
 * inside it and sink under every positive z-index, the sky included). Opacity / visibility of the
 * canvas are mirrored onto the mask (sync()): faded together, multiply + plus-lighter still add up
 * to source-over.
 * Off → the mask is gone and every style is back: plain compositing, as without the aberration.
 */
export function createChannelSplit(mount: HTMLElement, canvas: HTMLCanvasElement) {
  const mask = document.createElement('canvas')
  mask.setAttribute('aria-hidden', 'true')
  Object.assign(mask.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    pointerEvents: 'none',
    mixBlendMode: 'multiply',
  })
  const ctx = mask.getContext('2d', { alpha: false })
  let on = false
  let saved = { zIndex: '', contain: '' }

  /** White = multiply by 1: the mask lets everything through until the next real frame. */
  const clear = () => {
    if (!ctx) return
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, mask.width, mask.height)
  }

  const sync = () => {
    if (!on) return
    const s = canvas.style
    mask.style.imageRendering = s.imageRendering
    mask.style.visibility = s.visibility
    mask.style.transition = s.transition
    mask.style.opacity = s.opacity
  }

  return {
    get on() {
      return on
    },

    /** Switch on / off (no-op when unchanged). Without a 2D context it stays off. */
    set(next: boolean) {
      next = next && !!ctx
      if (next === on) return
      on = next
      if (on) {
        const z = getComputedStyle(mount).zIndex
        saved = { zIndex: mount.style.zIndex, contain: mount.style.contain }
        mount.style.zIndex = 'auto'
        if (mount.style.contain) mount.style.contain = 'none'
        mask.style.zIndex = z
        canvas.style.zIndex = z
        canvas.style.mixBlendMode = 'plus-lighter'
        mask.width = canvas.width
        mask.height = canvas.height
        clear()
        sync()
        mount.insertBefore(mask, canvas)
      } else {
        mask.remove()
        canvas.style.mixBlendMode = ''
        canvas.style.zIndex = ''
        mount.style.zIndex = saved.zIndex
        mount.style.contain = saved.contain
      }
    },

    /** The canvas now holds the mask: take it (resizing the mask to the canvas first). */
    copy() {
      if (!on || !ctx) return
      if (mask.width !== canvas.width || mask.height !== canvas.height) {
        mask.width = canvas.width
        mask.height = canvas.height
      }
      ctx.drawImage(canvas, 0, 0)
    },

    /** No mask this frame (context lost, nothing drawn): let everything through. */
    clear,

    /** Mirror the canvas's opacity / visibility / transition (call after changing them). */
    sync,

    dispose() {
      this.set(false)
    },
  }
}

export type ChannelSplit = ReturnType<typeof createChannelSplit>
