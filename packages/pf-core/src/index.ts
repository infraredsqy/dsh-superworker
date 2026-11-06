/**
 * The package exit of pf-core: runtime exports `open`, `SimulatedExecutor` and the three readers of a
 * plugin's own skills, everything else is types. Names and signatures are not renamed separately.
 */

export { open } from './open';
export type { Pf, PfOpenOptions } from './open';
export { SimulatedExecutor } from './executor';
/* The words layer: the one table, its parser and printer, the verbs that read engine answers into
   lines, and the two entries a caller answers through — `answer(argv, io)` (one line of words in, the
   two streams and the exit code out) and `describe()` (the static index of the words). The transport
   in front of the engine and the agent-facing tool both read this layer; the words about this
   *process* (doctor, version, the merge driver's hand-off) stay with the transport. */
export { answer, describe, topHelp } from './words/router';
export { COMMANDS, GROUPS, specOf } from './words/spec';
export { helpText, parse, usageError } from './words/argparse';
export { LONG_RESULT_LIMIT, longResultPointerOf } from './words/out';
export type { WordsIndex } from './words/router';
export type { WordsIO } from './words/types';
/* A plugin's skills are read out of its folder by anyone who installs them: the scan of the plugin
   directory, the folders one plugin ships, and the two ways those folders disagree with the
   declaration. The engine keeps the verdict; the caller owns what happens next. */
export {
  PLUGIN_SKILL_FILE,
  loadPlugins,
  skillFolders,
  skillProblems,
} from './plugins/registry';
export type { PluginScan } from './plugins/registry';
export type {
  DispatchRequest,
  Executor,
  OpenedSession,
  SimulationScript,
} from './executor';

export type {
  MicroTimestamp,
  SecondsTimestamp,
  NodeMode,
  NodeRecord,
  NodeStatus,
  NodeWeight,
  CycleHolding,
  CyclePolicies,
  CyclePathStep,
  CycleRecord,
  CycleStatus,
  NodeResult,
  InstructionLedger,
  InstructionRecord,
  InstructionRemovalTrace,
  InstructionScope,
  InstructionState,
  InstructionTarget,
  IssueDecision,
  IssueLedger,
  IssueRecord,
  IssueSeverity,
  IssueSource,
  IssueStatus,
  HandoffRecord,
  SessionHost,
  SessionNoteEntry,
  SessionNoteRecord,
} from './types';

export type {
  AddedNode,
  CycleCloseInput,
  CycleCreateInput,
  CyclePolicySet,
  CyclePolicyValue,
  CycleStanding,
  CycleStandingSignal,
  CycleStandingStep,
  CycleStartInput,
  CyclesNamespace,
  DagAddInput,
  DagInfo,
  DagInfoEdge,
  DagInfoOptions,
  DagListFilter,
  DagNamespace,
  DagRemoveOptions,
  DagSearchHit,
  DagSearchOptions,
  DagUpdateInput,
  DagValidationReport,
  InstructionAddInput,
  InstructionListFilter,
  InstructionReaderRow,
  InstructionResolveOptions,
  InstructionsNamespace,
  ExcludeReading,
  InitReport,
  LedgerInitOptions,
  LedgerLayout,
  LedgerNamespace,
  LedgerRegisterOptions,
  MergeDriverReading,
  NodeContext,
  NodeContextEntry,
  NodeSummary,
} from './ledger';

export type { CleanTempEntry, CleanTempOptions, CleanTempReport } from './tempclean';

export type {
  ConfigDefault,
  ConfigLayer,
  ConfigLayerName,
  ConfigNamespace,
  ConfigReading,
  ConfigSource,
  ConfigValue,
} from './config';
export type { SessionNoteRole, SessionNoteSummary, SessionShow, SessionsNamespace } from './sessions';
export type { PreparedDispatch, PreparedNode } from './prepare';
export type {
  AdvanceReceipt,
  ConductorAdvanceInput,
  ConductorDispatchInput,
  ConductorDoctorOptions,
  ConductorHandoffInput,
  ConductorNamespace,
  ConductorNamespaceOptions,
  ConductorPluginCommandInput,
  ConductorTarget,
  DispatchPreview,
  DispatchReceipt,
  DoctorCheck,
  DoctorReport,
  HandoffForm,
  HandoffFormReading,
  NextPlan,
  PluginCommandAnswer,
  SettlePreview,
  SettlePreviewSeam,
} from './conductor';

export type {
  // plugin contract: the declaration surface, the closed set of timings and actions, the shape of an offer and of the host context
  NormalizedOffer,
  PluginAction,
  PluginCommandCell,
  PluginCommandEntry,
  PluginContext,
  PluginDeclaration,
  PluginFolder,
  PluginGraphSnapshot,
  PluginImplModule,
  PluginInsertTarget,
  PluginKnobCell,
  PluginKnobKind,
  PluginMetricCell,
  PluginOffer,
  PluginReadingCell,
  PluginReadingEntry,
  PluginSkillFolder,
  PluginSourceCell,
  PluginTiming,
} from './plugins/types';
