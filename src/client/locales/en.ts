/**
 * The panel's English word lookup table.
 *
 * Typed as a complete map of the key set {@link zh} states, so this file cannot lose a key or
 * invent one: an omission or a typo is a compile error, not a screen where one word stays in the
 * wrong language. Adding a language means adding a sibling file with the same shape and listing it
 * in `./index.ts` — no other file changes.
 */
import type { WordKey } from './zh.ts'

export const en: Readonly<Record<WordKey, string>> = {
  /* ── The panel's identity ─────────────────────────────────────────────────────────────────── */
  /* The wordmark is the product's own name, so it stays the same word in every language; the row
   * in DSH's sidebar is where the panel sits; the section is its knobs. The Chinese section word is
   * deliberately 配置 rather than 设置, so it stays apart from the panel's own 设置 pane. */
  'brand.mark': 'PATHFINDER',
  'seat.label': 'Pathfinder Center',
  'settings.section': 'Pathfinder Settings',

  /* ── When the panel has nothing to draw ───────────────────────────────────────────────────── */
  'panel.not-enabled': 'Pathfinder is not enabled in this workspace.',
  'panel.no-record': 'This workspace has no Pathfinder record.',
  'panel.ungrouped-empty': 'The ungrouped bucket holds no record; this session belongs to a workspace in the list.',
  'panel.unreadable': 'This workspace’s record cannot be read.',
  'panel.no-session': 'No session is selected, so the workspace cannot be determined.',

  /* ── The workspace selector ───────────────────────────────────────────────────────────────── */
  'workspace.aria': 'Workspace',
  'workspace.ungrouped': 'Ungrouped',

  /* ── The vocabulary of state ──────────────────────────────────────────────────────────────── */
  'state.done': 'Delivered',
  'state.running': 'Running',
  'state.todo': 'Not started',
  'state.shelved': 'Waiting',
  'state.ready': 'Ready',
  'state.next': 'Entering next',

  /* ── The human gate ───────────────────────────────────────────────────────────────────────── */
  'gate.manual': 'Manual step',
  'gate.checkpoint': 'Checkpoint',

  /* ── The four states an issue can sit in ──────────────────────────────────────────────────── */
  'issue.open': 'Open',
  'issue.acknowledged': 'Acknowledged',
  'issue.rejected': 'Rejected',
  'issue.resolved': 'Resolved',

  /* ── The panel's own display controls ─────────────────────────────────────────────────────── */
  'view.map': 'Map',
  'view.detail': 'Detail',
  'view.notes': 'Instructions',
  'view.issue': 'Issues',
  'view.config': 'Settings',

  /* ── The settings section ─────────────────────────────────────────────────────────────────── */
  'settings.archived.label': 'Show archived instructions',
  'settings.archived.desc': 'Also lists archived instructions.',
  'settings.other-states.label': 'Show every issue state',
  'settings.other-states.desc': 'Also lists acknowledged, rejected, and resolved issues.',
  'settings.auto-relay.label': 'Open the next round after a session settles',
  'settings.auto-relay.desc': 'When on, the next round opens by itself once a line’s session settles and the plan says dispatch; when off, the line waits and a person dispatches.',
  'settings.unavailable': 'DSH does not expose {ns} as a settings namespace yet, so changes here are not saved.',

  /* ── Words shared across the panes ────────────────────────────────────────────────────────── */
  'common.settings': 'Settings',
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.archive': 'Archive',
  'common.revive': 'Revive',
  'common.collapse': 'Collapse',
  'common.unset': 'Not set',
  'common.global': 'Global',
  'common.expand-more': 'Show {count} more',

  /* ── The map ──────────────────────────────────────────────────────────────────────────────── */
  'map.scope.aria': 'Search under',
  'map.region.aria': 'The whole drawing',
  'map.overview.aria': 'Overview / back to the focus',
  'map.refresh.aria': 'Read the record again',
  'map.card.aria': 'Session for {node}',
  'map.card.go': 'press again to go to this session',

  /* ── The detail view ──────────────────────────────────────────────────────────────────────── */
  'detail.lines.aria': 'Lines',
  'detail.side-grip.aria': 'Resize the line sidebar',
  'detail.folded.cells.one': ' cell',
  'detail.folded.cells.other': ' cells',
  'cycle.blocked': 'Blocked',
  'cycle.running': 'In service',
  'cycle.stopped': 'Stopped',
  'node.open': 'Open session',
  /* The stranded dispatch: the claim is on disk, the session is gone. The sentence names the two
   * record words the remedy names, and the exact word line, so it can be followed as it is read. */
  'cell.stranded': 'This cell still has its dispatch claim on disk, but its session is gone: ask for `cycle retry {cycle} {node} --drop` to clear the claim, then `dispatch {cycle}` to open this round again.',

  /* ── The instruction ledger ───────────────────────────────────────────────────────────────── */
  'notes.scroll.aria': 'User instructions',
  'notes.scope.node': 'This cell · {node}',
  'notes.scope.aria': 'What this sentence governs',
  'notes.text.placeholder': 'Verbatim',
  'notes.text.aria': 'Verbatim',
  'notes.add': 'Add',
  'notes.empty': 'This record holds no instructions yet.',
  'notes.empty-live': 'No instruction is in force right now.',
  'notes.in-force': ' in force',
  'notes.entries.one': ' entry',
  'notes.entries.other': ' entries',
  'notes.out-of-scope': 'Out of scope',
  'notes.archived-mark': 'Archived',
  'notes.said-at': 'said',
  'notes.said-mark': '{mark} at',
  'notes.archive.tip': 'Archive: this instruction stops counting, and the entry stays where it is',
  'notes.revive.tip': 'Make it count again',
  'notes.delete.tip': 'Delete: this instruction and its text leave the record for good',
  'notes.delete.name': 'Delete this instruction',
  'notes.delete.warning': 'Deleting removes every trace of this instruction from the record.',

  /* ── The issue pool ───────────────────────────────────────────────────────────────────────── */
  'pool.detail-level.aria': 'Issue pool detail',
  'pool.lean.tip': '{state} × {count}',
  'pool.lean': 'Lean',
  'pool.full': 'All',
  'pool.scroll.aria': 'Issue pool',
  'pool.grip.aria': 'Width of the pool and the case',
  'pool.case.aria': 'Case',
  'pool.weight.tip': '{severity} · weight {weight} · {title}',
  'pool.gauge.aria': 'Pool weight and the policy line',
  'pool.policy-line.tip': 'policy line: issue_pool_weight_limit = {value}',
  'pool.severity.tip': '{severity} · weight {weight}',
  'pool.case.description': 'Symptoms',
  'pool.case.suggestion': 'Fix',
  'pool.case.locations': 'Locations',
  'pool.case.plan': 'Plan',

  /* ── Project settings ─────────────────────────────────────────────────────────────────────── */
  'config.categories.aria': 'Settings groups',
  'config.file.term': 'Settings file',
  'config.group.general': 'General',
  'config.group.issue': 'Issues',
  'config.group.test': 'Tests',
  'config.toggle.on': 'On',
  'config.toggle.off': 'Off',
  'config.unregistered-caption': 'No description is on file for this key; the tool judges whether the value is legal',
  'config.layer.default': 'Default',
  'config.layer.project': 'This project',
  'config.row.worktree_mode.name': 'worktree mode',
  'config.row.worktree_mode.caption': 'Whether a cell’s work runs in its own worktree',
  'config.row.test_tier.name': 'test tier',
  'config.row.test_tier.caption': 'full runs the whole suite; minimal runs only the project’s own checks',
  'config.row.max_agents.name': 'Parallel subagent cap',
  'config.row.max_agents.caption': 'How many subagents one session may have in flight at once',
  'config.row.issue_repair.name': 'issue repair',
  'config.row.issue_repair.caption': 'Adds a repair node automatically once the pool crosses the line; off means it never does',
  'config.row.issue_pool.name': 'Insert a repair node past the pool line',
  'config.row.issue_pool.caption': 'When a node closes and the pool’s weighted sum is past the limit, a repair node is inserted; off means it never is',
  'config.row.issue_pool_weight_limit.name': 'Pool weighted-sum limit',
  'config.row.issue_pool_weight_limit.caption': 'The sum the record’s per-tier weight table adds up to; the next close must stay below it. Blank means no judgement.',
  'config.row.test_audit.name': 'Insert a lean test node past the time limit',
  'config.row.test_audit.caption': 'When a node closes and the suite took longer than the limit, a lean-test node is inserted; off means it never is',
  'config.row.test_seconds_limit.name': 'Test suite time limit (seconds)',
  'config.row.test_seconds_limit.caption': 'How long the whole suite took; the next close must stay below it. Blank means no judgement.',

  /* ── What a node is waiting on ────────────────────────────────────────────────────────────── */
  /* The head is empty in English: the number leads, so nothing stands before it. */
  'deps.owed.head': '',
  'deps.owed.tail': ' prerequisites owed',

  /* ── The reading marks shared by the panes ────────────────────────────────────────────────── */
  'marks.running.elapsed': 'Running · {elapsed}',

  /* ── How a moment reads ───────────────────────────────────────────────────────────────────── */
  'date.today': 'Today',
  'date.yesterday': 'Yesterday',
  'date.before-yesterday': 'Two days ago',
  'date.month-day': '{month}/{day}',
  'duration.none': 'No record',
  'duration.seconds': '{value}s',
  'duration.minutes': '{value}m',
  'duration.hours': '{value}h',
  'duration.hours-minutes': '{value}h {rest}m',
  'ago.just-now': 'Just now',
  'ago.minutes': '{value}m ago',
  'ago.hours': '{value}h ago',
  'ago.days': '{value}d ago',

  /* ── The scope of an instruction ──────────────────────────────────────────────────────────── */
  'scope.node': 'This cell',

  /* ── When an operation is refused ─────────────────────────────────────────────────────────── */
  /* The tool's own reason and the transport's own message are carried out verbatim: no lookup table
   * here owns another program's words. */
  'failure.arg-not-allowed': 'This argument cannot address a record: {detail}',
  'failure.tool-refused': '{detail}',
  'failure.scope-unknown': 'Unrecognized scope: {detail}',
  'failure.empty-text': 'Nothing to record: write the sentence first.',
  'failure.no-session-service': 'This host exposes no {detail} service, so no session can be opened.',
  'failure.prompt-missing': 'The dispatch prompt for this cell is not in the record ({detail}): dispatch first, then open a session.',
  'failure.open-failed': 'The session did not open: {detail}',
  'failure.dispatch-refused': 'The dispatch did not complete: {detail}',
  'failure.no-operation': 'This channel has no {detail} operation.',
  'failure.not-connected': 'This deployment is not connected to the Pathfinder record service, so records cannot be read.',
  'failure.no-write-channel': 'This deployment has no usable write channel.',
  'failure.unparsable-answer': 'The host returned data that cannot be parsed.',
  'failure.transport-failed': '{detail}',
  'failure.config-unreadable': 'This workspace’s project settings cannot be read.',
  'failure.config-write-failed': 'That write did not take effect.',
  'failure.settings-refused': 'Not saved: the settings service did not accept this change.',
  'failure.settings-unwritable': 'Display preferences were not saved: no settings service is connected, so this change lives only on this screen.',
  'failure.unstated': 'The operation did not succeed and said nothing about why.',
}