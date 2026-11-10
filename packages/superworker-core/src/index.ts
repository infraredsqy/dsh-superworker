/**
 * The package exit of superworker-core. What is exported at runtime is settled by the runtime-exports section
 * of `docs/api.md`, and that list is the only place the names are written down — everything else here is
 * types. Names and signatures are not renamed separately.
 */

export { open } from './open';
export type { Superworker, RecordOpenOptions } from './open';
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
  CycleHolder,
  CyclePolicySet,
  CyclePolicyValue,
  CycleStanding,
  CycleStandingSignal,
  CycleStandingStep,
  CycleStartInput,
  CyclesNamespace,
  DagAddInput,
  DagAddManyRow,
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
  ExcludeReading,
  InitReport,
  KnownGeneration,
  LedgerInitOptions,
  LedgerMigrateOptions,
  LedgerNamespace,
  LedgerRegisterOptions,
  MergeDriverReading,
  MigrationReport,
  NodeContext,
  NodeContextEntry,
  NodeSummary,
} from './ledger';

/* The one module that still knows the old record directory: the facts a workspace that ran the
   pipeline before the rename can be asked — is one here, can it be recognised, may it move — plus
   the fixed sentence the panel's link hands to an agent. Nothing else in the package spells that
   directory; a reader that must act on it asks here. */
export {
  CONSULT_PROMPT,
  LEGACY_DIR_NAME,
  hasLegacyRecord,
  isRecognizableLegacyRecord,
  legacyRecordDir,
  migrationPreconditions,
} from './legacy';
export type { MigrationRefusal, MigrationReading } from './legacy';

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

/* The record directory's own name, exported rather than respelled: the host half builds its
   workspace-relative source paths from this one constant, so a second spelling of the directory
   has nowhere to appear. */
export { RECORD_DIR_NAME } from './paths';

export type { RecordLocations, RecordPaths } from './paths';
