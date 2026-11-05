/**
 * The package exit of pf-core: runtime exports `open`, `SimulatedExecutor` and the three readers of a
 * plugin's own skills, everything else is types. Names and signatures are not renamed separately.
 */

export { open } from './open';
export type { Pf, PfOpenOptions } from './open';
export { SimulatedExecutor } from './executor';
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
  ConductorCloseAnswers,
  ConductorDispatchInput,
  ConductorDoctorOptions,
  ConductorHandoffInput,
  ConductorNamespace,
  ConductorNamespaceOptions,
  ConductorPluginCommandInput,
  ConductorTarget,
  DispatchReceipt,
  DoctorCheck,
  DoctorReport,
  HandoffForm,
  HandoffFormReading,
  NextPlan,
  PluginCommandAnswer,
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
