/**
 * The model layer's entry: four records + one moment → the reading at that
 * moment.
 *
 * It fetches nothing (the records are handed in by the data bridge), draws no
 * UI, touches no DOM, and holds no global state: the same input always gives
 * the same output.
 */
export type * from './records.ts'
export type * from './contract.ts'
export { readProject } from './project.ts'
export { depthsOf, readDeps, readGraph } from './graph.ts'
export { groupInstructions, readInstructions } from './instructions.ts'
export { bornInSessionOf, readBirthplaces, readSessions, runSessionOf, strandedCycleOf } from './sessions.ts'
export { endingOf, owedSessions, readJudgement, readOverview } from './overview.ts'
export type {
  JudgementInput,
  OverviewCellVerdict,
  OverviewEnding,
  OverviewInput,
  OverviewJudgement,
  OverviewLeg,
  OverviewReading,
  OverviewSessionRow,
  OverviewSnapshot,
  OverviewWindow,
} from './overview.ts'
export type { OverviewEvent, OverviewRow, OverviewRowKind } from './overview-fold.ts'
export { briefRowsOf } from './brief.ts'
export type { BriefCategory, BriefReply, BriefRow, BriefStep } from './brief.ts'
export type { OverviewMainFrom } from './overview-main.ts'
export { readLine, readPool } from './pool.ts'
export { belongsTo, bucketOf, dispatchCycleOf, everySourceIs, lineStateOf, nodesOf, ownersOf, rankOf } from './reading.ts'
export type { CycleState, DetailGroupKey, NodeBucket, NodeRank } from './reading.ts'
export { clock, dayParts, elapsedParts } from './format.ts'
export type { DayParts, ElapsedParts } from './format.ts'
export { cutAt, field, happenedAt, secondsBetween, text, toMoment, writtenBy } from './fields.ts'
