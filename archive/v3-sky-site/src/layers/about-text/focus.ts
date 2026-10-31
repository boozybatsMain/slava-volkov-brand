/**
 * Focus helpers of the ABOUT notes — the same two as the projects block's (layers/projects/input.ts),
 * duplicated here so the two screens stay independent (a later move to core can merge them).
 */

/**
 * Put the focus on `el` from script, without the browser scrolling it into view: where the document
 * is stays the visitor's business (the nav's #about link glides the page itself).
 */
export function quietFocus(el: HTMLElement) {
  el.focus({ preventScroll: true })
}

/**
 * The block has left the stage with the focus still inside it: let go of it. blur() alone leaves the
 * tab order's starting point on the blurred element (Chrome): a moment on <body> takes it back to the
 * top of the page, so the next Tab starts from the nav again.
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
