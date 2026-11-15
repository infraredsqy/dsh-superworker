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
 * - The node rail keeps a lane on the left while it stands, and nothing drawn probes into it. One
 *   window alone, or one child, draws no rail and keeps only the stage's own blank. The main
 *   window's nameplate is the one thing that crosses its own window's left edge, and how far it may
 *   probe is exactly the ground between the group and that lane — one pixel of the rail is never
 *   covered.
 * - The group is centred on the stage itself, not on the room the rail leaves over: the lane is
 *   kept on both sides while it stands, so the picture stays on the stage's middle and its two
 *   gutters stay equal.
 * - The field is the stage's own frame: its box is the group's extent, in stage coordinates, and it
 *   never stands taller than the stage. The shelf that draws the panes lays the field over the whole
 *   stage and writes a pane's coordinate once — never once for the field and again for the pane.
 * - The children stand in one column to the right of the main window, each narrower than it. Equal
 *   share first, content need second: a child never grows past the rows it actually has. With no
 *   live child the column is not drawn and the field is exactly the main window's width.
 * - The main window hugs its content. Only the stage itself cuts it, and the cut is the feed's
 *   fade, not a scrollbar.
 * - Past the width where two windows can no longer both keep their smallest sizes, the children
 *   column does not squeeze — it leaves, and the main window stands alone.
 * - A child's window is tied to the dispatch row that opened it by one line: out of the main
 *   window's right edge on that row's middle, across the ground between the two windows, into the
 *   child's left edge on its own middle. The tie is an identity — the row's own call id — so a row
 *   that is no longer on the screen leaves the child unlinked rather than pointed at a neighbour.
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

/** The field's height ends, and the blank kept at the stage's edges — the field is never taller than the stage. */
export const FIELD_MAX_H = 760
export const FIELD_PAD = 8

/** The window frame's hairline on both ends; without it the last row would be counted as fitting when it does not. */
export const BOX_BORDER = 2

/** The hairline on one end, as the sheet draws it (`0.5px`): a pane's padding box — what its absolutely
 * placed feed hangs off — ends this far above the pane's own bottom edge. */
const FRAME_SIDE = 0.5

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
  /** The field's own box — the group's extent, in stage coordinates; the shelf lays this frame over
   * the whole stage and stands the windows at their own coordinates inside it. */
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

/** The room one window's feed has: the pane's height less its head, its foot and its frame, in rows. A
 * box too short for even one row has no room rather than a negative count — a stage that small still
 * draws, it just has nothing to stand rows in. */
function roomOf(height: number, head: number, foot: number): number {
  return Math.max(0, Math.floor((height - BOX_BORDER - head - foot) / ROW_H))
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
  /* The rail is a fact about the live children, not about the drawing: it stands from two of them,
     shown or not. While it stands the lane it keeps stays clear on both sides — that symmetry is
     what puts the group on the stage's middle; with no rail the stage's own blank is all there is. */
  const railVisible = childRows.length >= RAIL_FROM
  const side = Math.max(railVisible ? RAIL_LANE : 0, FIELD_PAD)
  /* What the stage really has left under the lane it keeps — nothing fabricated: on a stage too
     narrow for even that, the windows take whatever is there and shrink with it. */
  const availW = Math.max(0, stage.width - side * 2)
  /* The field is the stage's own frame, so it takes the stage's height less its edge blank and never
     more: a short stage gets a short field, not a field that hangs off the bottom. */
  const fieldHeight = Math.min(FIELD_MAX_H, Math.max(0, stage.height - FIELD_PAD * 2))

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
  /* The column stands for live children only, and only where two windows can both keep their
     smallest sizes: with no child, or on a stage too narrow for the pair, the ground between two
     windows is not kept for a window that is not there. */
  const childrenShown = childRows.length > 0 && availW >= MAIN_MIN_W && mainW >= MAIN_MIN_W && childW >= CHILD_MIN_W
  if (!childrenShown) {
    /* The column leaves whole; the main window takes what the stage next to the rail can give, and
       narrows with the stage rather than running off it. */
    mainW = Math.max(0, Math.min(MAIN_MAX_W, availW))
    childW = 0
    shownGapX = 0
  }

  const fieldWidth = mainW + shownGapX + childW
  /* Centred on the stage, not on the room left of the lane; the lane's own ground is a floor, so a
     stage too narrow to centre the group still keeps it off the lane. */
  const fieldLeft = Math.max(side, Math.floor((stage.width - fieldWidth) / 2))
  const fieldTop = Math.max(0, Math.floor((stage.height - fieldHeight) / 2))
  /* The nameplate probes left only as far as the ground between the group and the lane —
     the probe stops at the lane, never inside it. */
  const plateOut = Math.max(0, Math.min(PLATE_OUT, fieldLeft - side))

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
    const share = Math.max(0, Math.floor((fieldHeight - GAP_Y * (n - 1)) / n))
    const heights = childRows.map((rows) => Math.min(share, CHILD_HEAD + Math.max(0, rows) * ROW_H + CHILD_FOOT + BOX_BORDER))
    const stack = heights.reduce((a, b) => a + b, 0)
    /* The ground between two children gives way on a stage too short to hold it, so the column ends
       inside the field's own end rather than past it. */
    const gapY = n > 1 ? Math.max(0, Math.min(GAP_Y, Math.floor((fieldHeight - stack) / (n - 1)))) : 0
    const total = stack + gapY * (n - 1)
    let y = fieldTop + Math.round((fieldHeight - total) / 2)
    const childLeft = fieldLeft + mainW + shownGapX
    for (const h of heights) {
      children.push({ left: childLeft, top: y, width: childW, height: h, rowsRoom: roomOf(h, CHILD_HEAD, CHILD_FOOT) })
      y += h + gapY
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
    railVisible,
  }
}

/** The dot where a line leaves the main window, as the demo draws it. */
export const LINK_DOT_R = 2.5

/** How far a line turns with a corner instead of a right angle; a short run shortens it further. */
export const LINK_BEND = 12

/** One line from a dispatch row to the window that row started, in stage pixels. */
export interface OverviewLink {
  /** The path's own `d`, drawn inside the stage's frame. */
  readonly d: string
  /** Where the line leaves the main window: its right edge, on the anchored row's centre. */
  readonly fromX: number
  readonly fromY: number
  /** Where the line enters the child window: its left edge, on its own centre. */
  readonly toX: number
  readonly toY: number
}

/**
 * The line from one dispatch row to the window it dispatched, or nothing when there is no line to
 * draw.
 *
 * The anchor is an identity and never a guess: the caller hands the row's own place among the rows
 * the main window draws, and a row that is not on the screen — past the rows drawn, or off the top
 * of the room the box has — yields no line at all. A child that stands outside the drawing (a box
 * with no width, the column's own not-drawn state) yields none either. Nothing here borrows the
 * nearest row or the nearest window.
 *
 * The line leaves the main window's right edge on the row's middle, runs across the ground between
 * the two windows, turns with one corner into the child's height, and enters the child's left edge
 * on its middle.
 */
export function layoutLink(input: {
  readonly main: OverviewBox
  /** The child window the line reaches. */
  readonly child: OverviewBox
  /** The anchored row's place among the rows the main window draws, top first; absent when the reading has no such row. */
  readonly rowIndex: number | undefined
  /** How many rows the main window draws in its feed. */
  readonly rowCount: number
  /** The ground between the two windows, in pixels. */
  readonly gap: number
}): OverviewLink | undefined {
  const { main, child, rowIndex, rowCount, gap } = input
  /* The window has to be drawn to be reached: a column that left the stage, or a box standing over
     the main window rather than beside it, has no line. */
  if (child.width <= 0) return undefined
  const fromX = main.left + main.width
  if (child.left < fromX) return undefined
  if (gap < 0) return undefined
  if (rowIndex === undefined || !Number.isInteger(rowIndex) || rowIndex < 0) return undefined
  if (!Number.isInteger(rowCount) || rowIndex >= rowCount) return undefined
  /* The feed stands bottom-justified: when more rows are drawn than the box has room for, the top
     ones are the cut, and an anchor among them has no place on the screen. */
  const visible = Math.min(rowCount, main.rowsRoom)
  const slot = rowIndex - (rowCount - visible)
  if (slot < 0 || slot >= visible) return undefined
  /* A row's place is counted up from the pane's own bottom edge — its hairline, its foot, then the
     rows under it — because the feed stands bottom-justified: whatever blank the stage's cut left
     sits at the top of the stack, and counting down from the head would drift by exactly that blank.
     At the capacity the drift is most of a row, so the dot would stand on the row above. */
  const feedBottom = main.top + main.height - FRAME_SIDE - MAIN_FOOT
  const fromY = feedBottom - (rowCount - 1 - rowIndex) * ROW_H - ROW_H / 2
  if (fromY < main.top + MAIN_HEAD || fromY > feedBottom) return undefined
  const toX = child.left
  const toY = child.top + child.height / 2

  const midX = fromX + gap / 2
  const dy = toY - fromY
  if (dy === 0) {
    /* Two middles on one line: across the ground and straight in, no corner to turn. */
    return { d: `M${fromX} ${fromY} H${toX}`, fromX, fromY, toX, toY }
  }
  const bend = Math.max(0, Math.min(LINK_BEND, Math.abs(dy), gap / 2))
  const dir = dy > 0 ? 1 : -1
  const d = bend === 0
    ? `M${fromX} ${fromY} H${midX} V${toY} H${toX}`
    : `M${fromX} ${fromY} H${midX - bend} Q${midX} ${fromY} ${midX} ${fromY + dir * bend} V${toY} H${toX}`
  return { d, fromX, fromY, toX, toY }
}
