import { projects } from '../../core/projects'
import { scrollControl } from '../../core/scroll'

/**
 * PROJECTS INPUT — everything that flips the project or brings the page to this screen.
 *
 *   arrows (real buttons)        → projects.request(∓1); so do their stand-in hit zones, which
 *                                  hold still while the slab swings (index.ts)
 *   ← / → on the keyboard        → the same, only while this screen is the one on stage
 *   horizontal swipe on the face → next / previous; a vertical one is left to the browser (it scrolls)
 *   the VISITOR moving the focus → the page scrolls here (the texts are in the accessibility tree
 *   into the block                 from the start, so Tab reaches them from the hero)
 *   #projects in the address     → the section heading takes the focus: the next Tab goes to its controls
 *
 * The page never scrolls by itself: only the visitor's own move of the focus (Tab, assistive tech)
 * or their press on a control of the block brings it here — never the window coming back to the
 * front, never a focus this layer has set from script.
 * And the block never acts unseen: while its texts are not in, a press on one of its controls does
 * nothing but bring the page to it (that is the one place here that calls preventDefault — on a
 * click inside a block nobody can see; the page's own scroll, keys and history stay the browser's).
 */

/** The id of this screen's scroll stop (index.html) = the nav link's #hash. */
export const STOP = 'projects'

/** A swipe that starts this close to a screen edge belongs to the browser (back / forward gesture). */
const EDGE = 24
/**
 * A swipe counts as horizontal when it runs this many times further sideways than up or down.
 * 1 = the browser's own line: with touch-action: pan-y (projects.css) a drag steeper than that is
 * taken as a scroll and its pointer is cancelled, so a drag that is still arriving past the swipe
 * distance only has to be more sideways than vertical. Every drag on the picture then does exactly
 * one of the two things: above 1 leaves a band of slanted swipes that neither scroll nor flip,
 * below 1 a fast slanted flick could do both.
 */
const SLOPE = 1

export interface InputParts {
  /** The whole block: the visitor's focus anywhere inside brings the page here. */
  root: HTMLElement
  /** The swipe zone (the slab's face). */
  face: HTMLElement
  prev: HTMLElement
  next: HTMLElement
  /** Pointer-only stand-ins for the arrows' hit areas (they lie over the buttons; not focusable). */
  zonePrev: HTMLElement
  zoneNext: HTMLElement
  /** The section heading (tabindex −1): takes the focus when the address says #projects. */
  heading: HTMLElement
  /** The texts are in: keys, swipes and presses may act (the buttons and the face are inert in CSS until then). */
  live(): boolean
  /** projects.ui.swipe of the current config, px. */
  swipe(): number
}

const editable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

/** True while this layer itself is putting the focus somewhere (quietFocus): not the visitor's move. */
let scripted = false

/**
 * Put the focus on `el` from script. The page does not follow it (bindInput's focusin ignores it)
 * and the browser does not scroll it into view: where the document is stays the visitor's business.
 */
export function quietFocus(el: HTMLElement) {
  scripted = true
  try {
    el.focus({ preventScroll: true })
  } finally {
    scripted = false
  }
}

/**
 * The block has left the stage with the focus still inside it: let go of it. Otherwise Space or
 * Enter on the hero would press a button nobody can see (and Space would not page down), and the
 * next Tab would go on from in here. blur() alone leaves the tab order's starting point on the
 * blurred element (Chrome): a moment on <body> takes it back to the top of the page, so the first
 * Tab on the hero is the nav again.
 */
export function releaseFocus(root: HTMLElement) {
  const a = document.activeElement
  if (!(a instanceof HTMLElement) || !root.contains(a)) return
  a.blur()
  const body = document.body
  const had = body.getAttribute('tabindex')
  body.tabIndex = -1
  body.focus({ preventScroll: true })
  body.blur()
  if (had === null) body.removeAttribute('tabindex')
  else body.setAttribute('tabindex', had)
}

/** Wires the input up; returns the function that takes it all down again. */
export function bindInput(parts: InputParts): () => void {
  const { root, face, prev, next, zonePrev, zoneNext, heading } = parts
  const off = new AbortController()
  const on = { signal: off.signal }
  const passive = { signal: off.signal, passive: true }
  const early = { signal: off.signal, capture: true, passive: true }

  const here = () => {
    const sc = scrollControl.current
    return !sc || sc.state.section === sc.indexOf(STOP)
  }

  // ── nothing in the block acts unseen. Until the texts are in, nothing here catches the pointer
  //    (projects.css), so a click can then only come from the keyboard or from assistive tech: the
  //    focus resting on a control the page is not at (Tab in and the scroll stopped at once, a
  //    screen reader's own cursor). It flips nothing and opens nothing — the page comes to the
  //    block, and the control answers once it can be seen. On the way down (capture), so the
  //    buttons' own listeners below never hear of it ──
  root.addEventListener(
    'click',
    (e) => {
      if (parts.live()) return
      e.preventDefault()
      e.stopPropagation()
      scrollControl.current?.to(STOP)
    },
    { signal: off.signal, capture: true },
  )

  // ── arrows: the button itself (keyboard, assistive tech, a click on the arrow wherever the slab
  //    has swung it) and its stand-in zone (a click where the arrow rests). The zone lies on top, so
  //    one click is never counted twice; it passes hover and press on to the button's look ──
  const arrow = (button: HTMLElement, zone: HTMLElement, dir: 1 | -1) => {
    button.addEventListener('click', () => projects.request(dir), on)
    zone.addEventListener(
      'click',
      () => {
        // as a click on the button itself would: the keyboard goes on from here
        quietFocus(button)
        projects.request(dir)
      },
      on,
    )
    zone.addEventListener('pointerenter', (e) => button.classList.toggle('is-hover', e.pointerType === 'mouse'), passive)
    zone.addEventListener('pointerdown', () => button.classList.add('is-press'), passive)
    for (const type of ['pointerup', 'pointercancel'] as const) {
      zone.addEventListener(type, () => button.classList.remove('is-press'), passive)
    }
    zone.addEventListener('pointerleave', () => button.classList.remove('is-hover', 'is-press'), passive)
  }
  arrow(prev, zonePrev, -1)
  arrow(next, zoneNext, 1)

  // ── keys: on the window, so they work wherever the focus is — but only on this screen.
  //    With any modifier the arrows are the browser's or the system's (Shift: extend the selection,
  //    Alt / Cmd: history, Ctrl: spaces) ──
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || editable(e.target)) return
      if (!here() || !parts.live()) return
      projects.request(e.key === 'ArrowRight' ? 1 : -1)
    },
    on,
  )

  // ── swipe on the face: touch-action pan-y pinch-zoom (projects.css) leaves vertical drags and
  //    two-finger zooming to the browser, which then cancels the pointer; a sideways drag keeps
  //    arriving here ──
  let drag: { id: number; x: number; y: number } | null = null
  face.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse') return
      // a second finger: a pinch (the browser's own — touch-action), not a swipe
      if (!e.isPrimary) {
        drag = null
        return
      }
      if (e.clientX < EDGE || e.clientX > window.innerWidth - EDGE) return
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY }
    },
    passive,
  )
  face.addEventListener(
    'pointermove',
    (e) => {
      if (!drag || e.pointerId !== drag.id) return
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      if (Math.abs(dx) <= parts.swipe() || Math.abs(dx) <= SLOPE * Math.abs(dy)) return
      // one flip per gesture; the picture follows the finger's direction: drag left → next
      drag = null
      if (parts.live()) projects.request(dx < 0 ? 1 : -1)
    },
    passive,
  )
  const drop = (e: PointerEvent) => {
    if (drag && e.pointerId === drag.id) drag = null
  }
  face.addEventListener('pointerup', drop, passive)
  face.addEventListener('pointercancel', drop, passive)

  // ── focus: the block is always in the tab order; when the visitor moves the focus into it while
  //    the page is somewhere else — another screen, or stopped on the way here, before the texts are
  //    in (the scroll is an ordinary one: it rests anywhere) — the page comes along.
  //    Only the visitor's own move counts. Two things fire focusin in here without one:
  //      · the window coming back to the front (another tab, another app, a closed dialog): the
  //        browser announces the element that kept the focus all along once more. `kept` is that
  //        element, noted when the window left; any key or pointer since then makes the next
  //        focusin a real move again;
  //      · this layer's own quietFocus() (the heading on #projects, an arrow after a click on its
  //        stand-in zone, the heading again when a focused link has gone with its project) ──
  let kept: Element | null = null
  // (blur does not bubble: on the window this hears only the window's own)
  window.addEventListener(
    'blur',
    () => {
      kept = document.activeElement
    },
    on,
  )
  const acted = () => {
    kept = null
  }
  window.addEventListener('keydown', acted, early)
  window.addEventListener('pointerdown', acted, early)
  root.addEventListener(
    'focusin',
    (e) => {
      const again = e.target === kept
      kept = null
      if (again || scripted) return
      const sc = scrollControl.current
      if (sc && (sc.state.target !== sc.indexOf(STOP) || !parts.live())) sc.to(STOP)
    },
    on,
  )

  // ── #projects (the nav link — every time it is pressed, a pasted address, Back / Forward): the
  //    heading takes the focus, so a keyboard or screen-reader user continues from this section.
  //    Quietly: the document's position is the browser's business (and the nav link's own scroll) ──
  const toHeading = () => {
    if (location.hash === `#${STOP}`) quietFocus(heading)
  }
  window.addEventListener('hashchange', toHeading, on)
  // A page opened at #projects: the same — when the document really is at this screen (a reload
  // keeps the address but restores the scroll: it may say #projects with the page back on the
  // hero, and the focus would be left in a block nobody sees), and unless the visitor has already
  // put the focus somewhere.
  const sc = scrollControl.current
  const atStop = !sc || sc.state.target === sc.indexOf(STOP)
  if (atStop && (!document.activeElement || document.activeElement === document.body)) toHeading()

  return () => off.abort()
}
