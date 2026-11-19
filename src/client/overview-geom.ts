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
 *   conversation alone — one leg to show — draws no rail and keeps only the stage's own blank: there
 *   is nothing to switch to. The rail is the line's switch over its steps, not an index of the
 *   children column, so it stands whatever that column does; the lane is kept from two legs, which is
 *   the same threshold. The main
 *   window's nameplate is the one thing that crosses its own window's left edge; the probe's ground
 *   is reserved out of the band before a window is measured, so the probe is room the layout keeps
 *   on every stage rather than slack a narrow one spends — and one pixel of the rail is never
 *   covered.
 * - The group is the windows and the probe hanging off the main window's left edge — the plate is the
 *   group's left end — and that group is centred on the stage itself, not the window band alone and
 *   not the room the rail leaves over. The lane is kept on both sides while it stands, so the picture
 *   stays on the stage's middle and its two gutters stay equal instead of leaning half a probe left.
 * - The field is the stage's own frame: its box is the windows' extent, in stage coordinates, and it
 *   never stands taller than the stage. The shelf that draws the panes lays the field over the whole
 *   stage and writes a pane's coordinate once — never once for the field and again for the pane.
 * - The children stand in one column to the right of the main window, each narrower than it. Equal
 *   share first, content need second: a child never grows past the rows it actually has. With no
 *   live child the column is not drawn and the field is exactly the main window's width.
 * - The main window hugs its content. Only the stage itself cuts it, and the cut is the feed's
 *   fade, not a scrollbar. Its width is the stage's less the two lanes and the probe's own ground;
 *   it narrows under the pair's own 340 judge down to the width at which it can still be read.
 * - Past the width where two windows can no longer both keep their smallest sizes, the children
 *   column does not squeeze — it leaves, and the main window stands alone.
 * - A child's window is tied to the dispatch row that opened it by one line: out of the main
 *   window's right edge on that row's middle, across the ground between the two windows, into the
 *   child's left edge on its own middle. The tie is an identity — the row's own call id — so a row
 *   that is no longer on the screen leaves the child unlinked rather than pointed at a neighbour.
 * - The windows the five-window cap folded away are counted, not drawn: three dots and the number
 *   stand on the children column's own top edge. A count, never an eighth window.
 */

/** One feed row's height; the feed's room is counted in these. */
export const ROW_H = 24

/** The lane the node rail keeps on the left; windows and nameplates stay right of it. */
export const RAIL_LANE = 56

/** Where the rail's own marks start, inside the lane. */
export const RAIL_LEFT = 16

/** The windows' widest: a child is always the narrower one. */
export const MAIN_MAX_W = 440
export const CHILD_MAX_W = 420
/** The pair's own judge, and only that: below it two windows can no longer both be read, so the
 * children column leaves whole. It is not the width the main window alone may not go under — on a
 * phone's stage keeping it would push the nameplate back inside the frame, so the window alone is
 * allowed down to `MAIN_FLOOR_W`. */
export const MAIN_MIN_W = 340
export const CHILD_MIN_W = 330

/**
 * The narrowest the main window stands while the stage has the room for it.
 *
 * 240 is where the window's own cell still reads: the feed's insets (24 + 20) leave 196 of row text,
 * and the nameplate — the window less its 76px right inset, plus the 32px probe — is the same 196
 * wide, enough for a node's title and its readings line without wrapping. Under it both the title
 * and the readings start to truncate, which is the one thing a probe's ground must never cost.
 */
export const MAIN_FLOOR_W = 240

/**
 * The narrowest a child window stands while the stage has the room for it.
 *
 * A child's own cell reads narrower than the main window's: its title line carries one label, the
 * readings and the number — no nameplate prose — and its feed's insets (24 + 20) leave 176 of row
 * text at 220. Kept under {@link MAIN_FLOOR_W} on purpose: the main window is the bigger of the two
 * wherever the pair stands, and two equal windows would read as peers. A stage too narrow for the
 * pair at these floors drops the column; one that fits the pair only where the ground between them
 * gives way keeps its column, and the ground gives way instead.
 */
export const CHILD_FLOOR_W = 220

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
export const FIELD_MAX_H = 380
export const FIELD_PAD = 8

/** The window frame's hairline on both ends; without it the last row would be counted as fitting when it does not. */
export const BOX_BORDER = 2

/** The hairline on one end, as the sheet draws it (`0.5px`): a pane's padding box — what its absolutely
 * placed feed hangs off — ends this far above the pane's own bottom edge. */
const FRAME_SIDE = 0.5

/** How far the nameplate probes out of the main window's left edge at most. */
export const PLATE_OUT = 32

/** The rail exists from this many legs up: a stage with one conversation has nothing to switch to. */
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
  /** Whether the node rail stands: it takes two legs of the line, which is one other step to switch to. */
  readonly railVisible: boolean
}

/** The room one window's feed has: the pane's height less its head, its foot and its frame, in rows. A
 * box too short for even one row has no room rather than a negative count — a stage that small still
 * draws, it just has nothing to stand rows in. */
function roomOf(height: number, head: number, foot: number): number {
  return Math.max(0, Math.floor((height - BOX_BORDER - head - foot) / ROW_H))
}

/** The tallest a feed could ever stand, in rows: the bound the caller gives the reading's cut. The
 * capacity is the rows the tallest window can stand, and the main window is that window — its head
 * and foot are the deeper pair, so at the field's own height it holds the fewest rows of the two
 * frames and its count is the bound both keep: 96 + n*24 + 20 + 2 <= 380 stands ten rows. */
export const READING_CAPACITY = roomOf(FIELD_MAX_H, MAIN_HEAD, MAIN_FOOT)

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
  /** How many legs the rail offers; the rail stands from two, which is one other step to switch to. */
  readonly legCount: number
}): OverviewPlacement {
  const { stage, mainRows, childRows } = input
  /* The lane is kept from two legs — the rail's own threshold — whether or not the stage ends up seating
     a children column: the rail is a switch over the line's steps, not an index of that column, so a
     stage too narrow for the column still keeps it. While it is kept it stays clear on both sides, and
     that symmetry is what puts the group on the stage's middle; with no lane the stage's own blank is
     all there is. */
  const wantRail = input.legCount >= RAIL_FROM
  const side = Math.max(wantRail ? RAIL_LANE : 0, FIELD_PAD)
  /* What the stage really has left under the lane it keeps — nothing fabricated: on a stage too
     narrow for even that, the windows take whatever is there and shrink with it. The nameplate's
     probe is taken out first, because it is ground the picture needs rather than slack it may
     spend: measuring a window against the full band is what emptied the probe on a phone's stage. */
  const availW = Math.max(0, stage.width - side * 2 - PLATE_OUT)
  /* The field is the stage's own frame, so it takes the stage's height less its edge blank and never
     more: a short stage gets a short field, not a field that hangs off the bottom. */
  const fieldHeight = Math.min(FIELD_MAX_H, Math.max(0, stage.height - FIELD_PAD * 2))

  /* The ground between the two windows gives way before the column does, the way the ground between
     two children gives way on a short stage: a pair standing at its floors needs only what it needs,
     and a stage narrower than the pair's *minimums* used to drop the column whole — a pipeline with
     legs drawn as a pipeline with none. */
  const preferredGapX = Math.max(GAP_X_MIN, Math.min(GAP_X_MAX, Math.round(availW * 0.1)))
  const gapX = Math.max(0, Math.min(preferredGapX, availW - MAIN_FLOOR_W - CHILD_FLOOR_W))
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
  /* The column stands for live children only, and only where two windows can both keep their floors:
     their documented minimums where the stage has the room, and their readable floors where it does
     not. */
  const childrenShown = childRows.length > 0 && availW >= MAIN_FLOOR_W + CHILD_FLOOR_W
  if (childrenShown && (mainW < MAIN_FLOOR_W || childW < CHILD_FLOOR_W)) {
    /* Neither window goes under the width its own cell still reads at: on a stage whose share already
       clears both floors nothing moves, and where it does not, the pair is pulled apart to them. */
    mainW = Math.max(MAIN_FLOOR_W, Math.min(mainW, rest - CHILD_FLOOR_W))
    childW = Math.max(CHILD_FLOOR_W, rest - mainW)
  }
  /* The rail is the line's own switch: it stands wherever there is a second step to move to, and it
     no longer leaves with the children column, because switching a step was never that column's
     business. The lane it keeps goes back to being the stage's own blank only when it does not stand. */
  const railVisible = wantRail
  if (!childrenShown) {
    /* The column leaves whole; the main window takes what the stage next to the rail can give, and
       narrows with the stage rather than running off it. Its floor is the readable one and not the
       pair's judge: a phone's stage may put it under 340, never under the width its nameplate can
       still be read at, and never past the room the stage actually has. */
    mainW = Math.max(Math.min(MAIN_FLOOR_W, availW), Math.min(MAIN_MAX_W, availW))
    childW = 0
    shownGapX = 0
  }

  const fieldWidth = mainW + shownGapX + childW
  /* Centring is the group's, and the group's left end is the plate's: the windows stand one probe
     right of the centre the picture takes. Counting the probe here (and its ground in the band
     above) is what makes the two gutters equal — centring the window band alone left the picture
     half a probe left of the stage's middle and, on a narrow stage, no probe at all. The lane's own
     ground is a floor and the stage's right edge the other end, so a stage too narrow to centre the
     group still keeps the windows off both. */
  const centred = Math.floor((stage.width - fieldWidth - PLATE_OUT) / 2) + PLATE_OUT
  const fieldLeft = Math.max(side, Math.min(centred, stage.width - fieldWidth))
  const fieldTop = Math.max(0, Math.floor((stage.height - fieldHeight) / 2))
  /* The probe reaches the ground the group keeps on its left. That is the reserved 32 on every
     stage with room for its lanes; less only where the stage is narrower than the lanes, the probe
     and the windows together — and then the plate stops at the lane rather than inside it. */
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
    /* A child's box is at least its title line, its foot and one row: under that it holds no feed at
       all. The ground between two children gives way before a child's own rows do, so the even share
       takes that floor whenever the field can hold n of them with no ground between them. */
    const least = CHILD_HEAD + CHILD_FOOT + BOX_BORDER + ROW_H
    const even = Math.max(0, Math.floor((fieldHeight - GAP_Y * (n - 1)) / n))
    const share = fieldHeight >= least * n ? Math.max(least, even) : even
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

/* ---- The marks a window can carry ---------------------------------------- */
/* Two fillings: the delivered window's check over its body, the pause a window held at a person's
 * gate wears in the same square, and the small ring that says the window is still moving, in its
 * head. A break is not a mark — the window's own frame wears it, so the stage states no box for it.
 * Sizes and positions are the design's own table, stated here so the drawing reads them and neither
 * the component nor the sheet keeps a copy. */

/** The feed's own insets: the band its rows stand in, and the box a window's mark centres on. */
export const FEED_LEFT = 24
export const FEED_RIGHT = 20

/** The check: the design's 44 square, and the pen that draws it — 4px on screen, stated in the glyph's 12-unit viewBox. */
export const MARK_CHECK = 44
export const MARK_CHECK_STROKE = 1.09

/** The disc of the window's own ground the check stands on, so it never melts into the rows behind it. */
export const MARK_SCRIM = 108

/** The fault line a broken window says: the glyph's size and the line's height. The word is short in
 * every language on purpose — the conversation behind the press carries the detail. */
export const FAULT_MARK = 16
export const FAULT_LINE_H = 20

/** The running ring: 10 across, standing in the child's title-line cell — a 20 cell, right 16, top 7. */
export const RING_SIZE = 10
export const RING_CELL = 20
export const RING_RIGHT = 16
export const RING_TOP = 7

/**
 * Where a child's title line stops on the right: at the ring's cell's own edge. The cell is the
 * ring's and no one else's, so the line's last word — the elapsed number — can never be put under
 * the turning ink; the ring keeps the cell's own ground on every side of it.
 */
export const HEAD_RIGHT = RING_RIGHT + RING_CELL

/** One mark's box in its pane's own coordinates, and the pen its glyph is stroked with. */
export interface OverviewMark {
  readonly left: number
  readonly top: number
  readonly size: number
  readonly stroke: number
}

/**
 * Where a window's check stands: on the middle of the process band, the band running from the head to
 * the window's own foot. The main window is the only one that is ever marked, and it reads its head
 * and foot here the same way any box did. A box too short or too narrow to hold the mark still states
 * a box inside the pane rather than a negative one.
 */
export function layoutMark(input: {
  readonly width: number
  readonly height: number
  readonly head: number
  readonly foot: number
  readonly size: number
  readonly stroke: number
}): OverviewMark {
  const { width, height, head, foot, size, stroke } = input
  const bandTop = Math.min(head, height)
  const bandBottom = Math.max(bandTop, height - foot)
  const bandWidth = Math.max(0, width - FEED_LEFT - FEED_RIGHT)
  const left = FEED_LEFT + Math.round((bandWidth - size) / 2)
  const top = bandTop + Math.round((bandBottom - bandTop - size) / 2)
  return {
    left: Math.max(0, Math.min(left, width - size)),
    top: Math.max(0, Math.min(top, height - size)),
    size,
    stroke,
  }
}

/** The fault line's own box, in its pane's own coordinates: the whole width of the band, one line tall. */
export interface OverviewFault {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * Where a broken window's one line stands: centred on the process band's middle — the same middle
 * the check takes, so the eye that learned where a verdict lives finds this one there too. The line
 * takes the band's whole width and centres what it holds in it; a pane too short for the line keeps
 * it inside the pane rather than stating a box that falls off.
 */
export function layoutFault(input: {
  readonly width: number
  readonly height: number
  readonly head: number
  readonly foot: number
}): OverviewFault {
  const { width, height, head, foot } = input
  const bandTop = Math.min(head, height)
  const bandBottom = Math.max(bandTop, height - foot)
  const top = bandTop + Math.round((bandBottom - bandTop - FAULT_LINE_H) / 2)
  return {
    left: FEED_LEFT,
    top: Math.max(0, Math.min(top, height - FAULT_LINE_H)),
    width: Math.max(0, width - FEED_LEFT - FEED_RIGHT),
    height: FAULT_LINE_H,
  }
}

/** The running ring's own box: the child's title-line cell, on the same centre the check would take. */
export interface OverviewRing {
  readonly left: number
  readonly top: number
  readonly size: number
}

/**
 * Where the running ring turns: centred in the child window's title-line cell. A pane narrower
 * than that cell still states a box inside itself rather than a negative one.
 */
export function layoutRing(input: { readonly width: number }): OverviewRing {
  const cellLeft = input.width - RING_RIGHT - RING_CELL
  const left = Math.max(0, cellLeft) + Math.round((RING_CELL - RING_SIZE) / 2)
  return {
    left: Math.max(0, Math.min(left, input.width - RING_SIZE)),
    top: RING_TOP + Math.round((RING_CELL - RING_SIZE) / 2),
    size: RING_SIZE,
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

/** The badge above the children column: its three dots, then the count. Its width holds the dots and
 * the widest count the cap can produce. */
export const SPILL_W = 40

/**
 * Where a window that joined this beat came from, in stage pixels: the point it grows out of.
 *
 * The main window has no such point, and that is the whole asymmetry this states. It is the
 * conversation this pane is about — the pipeline's own subject, already the frame the drawing stands
 * in — so it was always there and has nowhere to arrive from; a source handed back for it would be an
 * invented place, which is exactly the sliver in the stage's corner the reader saw. A child does have
 * one: the dispatch row that opened it, which is a real row of the main conversation's own feed, so
 * the window grows along the line that already ties it there.
 *
 * The source is the line's own leaving point ({@link layoutLink}), so the tie and the growth agree by
 * construction: where a reader sees the line start is where the window came from. A child with no line
 * — its dispatch row cut off the top, or an unanchored window — has no source either, and is simply
 * drawn.
 */
export function layoutBirth(input: {
  /** Whether this is the pane's main window: it never has a source. */
  readonly main: boolean
  /** The line to the window that is being drawn, when there is one. */
  readonly link: OverviewLink | undefined
}): { readonly x: number; readonly y: number } | undefined {
  if (input.main || input.link === undefined) return undefined
  return { x: input.link.fromX, y: input.link.fromY }
}

/** The badge's own height, and the ground it keeps between itself and the column's top. */
export const SPILL_H = 12
export const SPILL_GAP = 10

/** How many dots stand before the count, as the demo draws them. */
export const SPILL_DOTS = 3

/** The badge that counts the windows the cap folded away, in stage pixels. */
export interface OverviewSpill {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * Where the count of folded-away windows stands, or nothing when it has nothing to say.
 *
 * The badge stands on the children column's own top edge, its right edge on the column's right edge,
 * in the ground above the column. With no window folded away, no column drawn, or no ground above the
 * column — a stage so short that the badge would lie across the first window — it is not drawn at all.
 */
export function layoutSpill(input: {
  /** The drawn children column, top first; empty when the column did not stand. */
  readonly children: readonly OverviewBox[]
  /** How many running children the cap folded away. */
  readonly hiddenChildren: number
}): OverviewSpill | undefined {
  const { children, hiddenChildren } = input
  const first = children[0]
  if (hiddenChildren <= 0 || first === undefined) return undefined
  const top = first.top - SPILL_GAP - SPILL_H
  if (top < 0) return undefined
  const right = first.left + first.width
  return { left: right - SPILL_W, top, width: SPILL_W, height: SPILL_H }
}
