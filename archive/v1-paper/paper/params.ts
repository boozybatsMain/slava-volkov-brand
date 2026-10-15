import type { ResolvedConfig } from '../../core/types'

/**
 * Everything the paper layer needs beyond the top-level knobs. Values live in
 * hero.config.ts (paper.detail, paper.edge, ui.type, ui.layout, ui.hand, ui.ink);
 * mobile overrides are already applied by resolveConfig.
 */
export function getPaperParams(config: ResolvedConfig) {
  return {
    texture: config.paper.detail,
    edge: config.paper.edge,
    type: config.ui.type,
    layout: config.ui.layout,
    hand: config.ui.hand,
    ink: config.ui.ink,
  }
}

export type PaperParams = ReturnType<typeof getPaperParams>
