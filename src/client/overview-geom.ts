/**
 * The overview's layout, as pure arithmetic: no DOM, no React, no clock of its own.
 *
 * The reading says which windows there are and how many rows each one holds; this module says where
 * each window stands and how tall it is, for a stage of a given size. The sheet draws boxes from
 * these numbers and states none of them itself — like the map's card box, they are stated once,
 * here. Same reading, same size, same picture: a reader comparing two moments is not comparing two
 * layouts.
 *
 * The ground rules this arithmetic holds by, whatever the stage does:
 *
 * - The node rail keeps a lane on the left, and nothing drawn probes into it. The main window's
 *   nameplate is the one thing that crosses its own window's left edge, and how far it may probe is
 *   exactly the ground between the window and the rail's lane — one pixel of the rail is never
 *   covered.
 * - The children stand in one column to the right of the main window, each narrower than it. Equal
 *   share first, content need second: a child never grows past the rows it actually has.
 * - The main window hugs its content. Only the stage itself cuts it, and the cut is the feed's
 *   fade, not a scrollbar.
 * - Past the width where two windows can no longer both keep their smallest sizes, the children
 *   column does not squeeze — it leaves, and the main window stands alone.
 */

/** One feed row's height; the feed's room is counted in these. */
export const ROW_H = 24

/** The lane the node rail keeps on the left; windows and nameplates stay right of it. */
export const RAIL_LANE = 56

/** Where the rail's own marks start, inside the lane. */
export const RAIL_LEFT = 16

/** The main window's widest and smallest; a child is always the narrower one. */
export const MAIN_MAX_W = 440
export const CHILD_MAX_W = 420
export const MAIN_MIN_W = 340
export const CHILD_MIN_W = 330

/** The ground between the two windows: it breathes with the stage inside these ends. */
export const GAP_X_MIN = 96
export const GAP_X_MAX = 150

/** The ground between two children of the column. */
export const GAP_Y = 12

/** Main window: top to the first feed row (the probing nameplate and a breath), and under the last one. */
export const MAIN_HEAD = 96
export const MAIN_FOOT = 20

/** Child window: its one title line at the top, and under the feed. */
export const CHILD_HEAD = 32
export const CHILD_FOOT = 12

/** The field's height ends, and the blank kept at the stage's edges. */
export const FIELD_MAX_H = 760
export const FIELD_MIN_H = 260
export const FIELD_PAD = 8

/** The window frame's hairline on both ends; without it the last row would be counted as fitting when it does not. */
export const BOX_BORDER = 2

/** How far the nameplate probes out of the main window's left edge at most. */
export const PLATE_OUT = 32

/** The rail exists from this many live children up; one window alone has no node rail. */
export const RAIL_FROM = 2

/**
 * The rail bar's width for one child: a ruler over the rows it holds, the lit child's a step
 * longer. The lane is the bar's whole home, so the arithmetic stops at the lane's own room — no
 * bar, at any row count the reading can hold, ever reaches past the lane into the field.
 */
export function railBarWidth(rows: number, lit: boolean): number {
  return Math.min(10 + Math.max(0, rows) * 2 + (lit ? 8 : 0), RAIL_LANE - RAIL_LEFT)
}

/** One window's box, in stage pixels, with the rows its feed has room for. */
export interface OverviewBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  readonly rowsRoom: number
}

/** The stage the pane measures itself against, in pixels. */
export interface StageSize {
  readonly width: number
  readonly height: number
}

/** Where everything stands for one stage and one reading's row counts. */
export interface OverviewPlacement {
  /** The field's own box: the two windows stand inside it. */
  readonly fieldLeft: number
  readonly fieldTop: number
  readonly fieldWidth: number
  readonly fieldHeight: number
  readonly main: OverviewBox
  /** The children column, top first; empty when the stage is too narrow to draw it. */
  readonly children: readonly OverviewBox[]
  /** How far the nameplate probes left of the main window's edge; the rail keeps every pixel left of that. */
  readonly plateOut: number
  /** Whether the node rail exists: it takes two live children, shown or not. */
  readonly railVisible: boolean
}

/** The room one window's feed has: the pane's height less its head, its foot and its frame, in rows. */
function roomOf(height: number, head: number, foot: number): number {
  return Math.floor((height - BOX_BORDER - head - foot) / ROW_H)
}

/** The tallest a feed could ever stand, in rows: the bound the caller gives the reading's cut. */
export const READING_CAPACITY = Math.max(
  roomOf(FIELD_MAX_H, MAIN_HEAD, MAIN_FOOT),
  roomOf(FIELD_MAX_H, CHILD_HEAD, CHILD_FOOT),
)

/**
 * The layout for one stage and one reading: the main window's box, the children column's boxes in
 * the reading's order, and where the field stands. Every number is arithmetic over the inputs —
 * the same stage and the same row counts give the same boxes.
 */
export function layoutOverview(input: {
  readonly stage: StageSize
  /** The main window's row count at this moment. */
  readonly mainRows: number
  /** Each child's row count, in the reading's order. */
  readonly childRows: readonly number[]
}): OverviewPlacement {
  const { stage, mainRows, childRows } = input
  const availW = Math.max(200, stage.width - RAIL_LANE - FIELD_PAD)
  const fieldHeight = Math.min(FIELD_MAX_H, Math.max(FIELD_MIN_H, stage.height - FIELD_PAD * 2))

  const gapX = Math.max(GAP_X_MIN, Math.min(GAP_X_MAX, Math.round(availW * 0.1)))
  const rest = availW - gapX
  let mainW: number
  let childW: number
  let shownGapX: number
  if (rest >= MAIN_MAX_W + CHILD_MAX_W) {
    mainW = MAIN_MAX_W
    childW = CHILD_MAX_W
    shownGapX = gapX
  } else {
    const k = rest / (MAIN_MAX_W + CHILD_MAX_W)
    mainW = Math.round(MAIN_MAX_W * k)
    childW = Math.round(CHILD_MAX_W * k)
    shownGapX = gapX
  }
  const childrenShown = mainW >= MAIN_MIN_W && childW >= CHILD_MIN_W
  if (!childrenShown) {
    /* The column leaves whole; the main window takes what the stage next to the rail can give. */
    mainW = Math.min(MAIN_MAX_W, availW)
    childW = 0
    shownGapX = 0
  }

  const fieldWidth = mainW + shownGapX + childW
  const fieldLeft = RAIL_LANE + Math.max(0, Math.floor((availW - fieldWidth) / 2))
  const fieldTop = Math.max(0, Math.floor((stage.height - fieldHeight) / 2))
  /* The nameplate probes left only as far as the ground between the window and the rail's lane —
     the probe stops at the lane, never inside it. */
  const plateOut = Math.max(0, Math.min(PLATE_OUT, fieldLeft - RAIL_LANE))

  const mainH = Math.min(fieldHeight, MAIN_HEAD + Math.max(0, mainRows) * ROW_H + MAIN_FOOT + BOX_BORDER)
  const main: OverviewBox = {
    left: fieldLeft,
    top: fieldTop + Math.round((fieldHeight - mainH) / 2),
    width: mainW,
    height: mainH,
    rowsRoom: roomOf(mainH, MAIN_HEAD, MAIN_FOOT),
  }

  const children: OverviewBox[] = []
  const n = childrenShown ? childRows.length : 0
  if (n > 0) {
    const share = Math.floor((fieldHeight - GAP_Y * (n - 1)) / n)
    const heights = childRows.map((rows) => Math.min(share, CHILD_HEAD + Math.max(0, rows) * ROW_H + CHILD_FOOT + BOX_BORDER))
    const total = heights.reduce((a, b) => a + b, 0) + GAP_Y * (n - 1)
    let y = fieldTop + Math.round((fieldHeight - total) / 2)
    const childLeft = fieldLeft + mainW + shownGapX
    for (const h of heights) {
      children.push({ left: childLeft, top: y, width: childW, height: h, rowsRoom: roomOf(h, CHILD_HEAD, CHILD_FOOT) })
      y += h + GAP_Y
    }
  }

  return {
    fieldLeft,
    fieldTop,
    fieldWidth,
    fieldHeight,
    main,
    children,
    plateOut,
    railVisible: childRows.length >= RAIL_FROM,
  }
}
