/**
 * The panel's Simplified Chinese word lookup table — the key-set source of truth.
 *
 * Every word a reader of the panel can see lives here, and nowhere else: a component that prints
 * text asks for a key, never for a literal. This file states which keys exist; every other locale
 * is typed against it, so a missing or extra key is a compile error rather than a screen where one
 * word stays in the wrong language.
 *
 * Keys are flat and dotted, matching the shape DSH's own locale service registers (see
 * `@deepseek-ai/dsh-client-locale`). A `{name}` placeholder is substituted at call time; the
 * wording around it is free to move the placeholder anywhere, because word order differs between
 * languages.
 *
 * Two things deliberately do NOT live here: the records' own words (a node's title, a status the
 * tool wrote, a `config` value) and the console diagnostics this plugin prints for developers.
 * The first is data — it is shown verbatim in every language. The second is not interface text.
 */
export const zh = {
  /* ── The panel's identity ─────────────────────────────────────────────────────────────────── */
  /* Three words, one family: the wordmark over the panel is the product's own name, the row in
   * DSH's sidebar is where that panel sits, and the settings section is its knobs. The section
   * deliberately reads 配置 rather than 设置 — the panel's own 设置 pane holds the project's knobs
   * from the record, and two objects must not share one word. */
  'brand.mark': 'SUPERWORKER',
  'seat.label': '超级工坊',
  'settings.section': '工坊配置',

  /* ── When the panel has nothing to draw ───────────────────────────────────────────────────── */
  'panel.not-enabled': '当前工作区的记录里还没有节点。',
  'panel.no-record': '当前工作区没有记录。',
  'panel.ungrouped-empty': '未分组名下没有记录；这条会话属于清单里的某个工作区。',
  'panel.unreadable': '无法读取当前工作区的记录。',
  'panel.no-session': '尚未选中会话，无法确定工作区。',

  /* The pane-level crash guard's sentence (`pane-boundary.tsx`): one pane that cannot be drawn
   * says so in its own place instead of the whole cell going dark. The wording is the reader's
   * own, approved verbatim — not invented here. */
  'panel.crashed': '当前页面显示时出现错误。',

  /* The legacy-directory notice: the workspace still holds the previous record directory, so the
   * panel has nothing to draw and one way forward. The body names the directory this plugin reads,
   * never the one it replaced — the old name is the engine's fact to spell, not this panel's. */
  'panel.legacy.title': '记录目录已更名',
  'panel.legacy.body': '当前项目仍在使用旧版记录目录。本插件只读取 `.superworker`，因此这里没有可显示的内容。',
  'panel.legacy.link': '由 agent 完成迁移',

  /* ── The workspace selector ───────────────────────────────────────────────────────────────── */
  'workspace.aria': '工作区',
  'workspace.ungrouped': '未分组',

  /* ── The vocabulary of state ──────────────────────────────────────────────────────────────── */
  /* Five marks carry meaning on this panel: delivered / running / not started / waiting / failed.
   * These words are said in many places — a column head, a section head, a count pill, a hover —
   * and they are spelled once here so that all of them say the same thing. */
  'state.done': '已交付',
  'state.running': '进行中',
  'state.todo': '未开始',
  'state.shelved': '等待处理',
  'state.ready': '可开工',
  'state.next': '即将进线',

  /* ── The human gate ───────────────────────────────────────────────────────────────────────── */
  /* A gate's own kind says which of these it is; the shelved gate reads as the shelved state, so
   * it reuses that word rather than saying a second thing for the same fact. */
  'gate.manual': '手动节点',
  'gate.checkpoint': '检查点',

  /* ── The four states an issue can sit in ──────────────────────────────────────────────────── */
  'issue.open': '未解决',
  'issue.acknowledged': '已承认',
  'issue.rejected': '已驳回',
  'issue.resolved': '已解决',

  /* ── The panel's own display controls ─────────────────────────────────────────────────────── */
  /* 当前 is the session windows; 概览 is the record's own board — the map and the list drawn from
   * one reading. Two pages, two words, and neither language may give them the one word. */
  'view.overview': '当前',
  'view.nodes': '概览',
  'view.notes': '指令',
  'view.issue': '问题',
  'view.config': '设置',

  /* ── The settings section ─────────────────────────────────────────────────────────────────── */
  /* Two switches over what the panel draws, each with the one line DSH's own settings rows carry
   * under their name. Which view the panel opens on is deliberately not here: the panel remembers
   * the tab it was left on and writes it back, so a row for it would be a knob the reader keeps
   * overwriting. */
  'settings.archived.label': '指令面板显示已归档指令',
  'settings.archived.desc': '开启后，指令列表中同时显示已归档的历史指令。',
  'settings.other-states.label': '问题面板显示全部状态的问题',
  'settings.other-states.desc': '开启后，除未解决问题外，一并显示已承认、已驳回与已解决的问题。',
  'settings.auto-relay.label': '节点完成后自动启动下一节点',
  'settings.auto-relay.desc': '开启后，当前节点完成并满足派发条件时自动开启下一节点会话；关闭则暂停等待手动启动。',
  'settings.inject.label': '向会话上下文注入生效指令',
  'settings.inject.desc': '开启后，每轮对话自动附带当前工作区生效中的用户指令；关闭则不注入。',
  'settings.unavailable': 'DSH 还没把 {ns} 暴露成设置命名空间，这里的改动不会保存。',
  'settings.answer.label': '术语解释级别',
  'settings.answer.desc': '汇报时对专业术语的解释方式：plain 附带通俗说明，technical 仅用术语（可按项目覆盖）。',
  'settings.answer.no-session': '未连接到超级工坊服务，暂无法读取或修改全局配置。',

  /* ── Words shared across the panes ────────────────────────────────────────────────────────── */
  'common.settings': '设置',
  'common.close': '关闭',
  'common.cancel': '取消',
  'common.delete': '删除',
  'common.archive': '归档',
  'common.revive': '复原',
  'common.collapse': '收起',
  'common.unset': '未设置',
  'common.global': '全局',
  'common.expand-more': '展开其余 {count} 条',

  /* ── The node board: one reading, two drawings ────────────────────────────────────────────── */
  /* The band over both drawings says which cells are in scope and which way they are drawn. The
   * scope control carries a scope's own word and nothing else: a line is a line, and the control
   * does not dress it up as a state. */
  'board.scope.aria': '作用域',
  'board.mode.aria': '这一页怎么画',
  'board.mode.map': '地图',
  'board.mode.detail': '明细',
  /* The one thing a press on a row does, for a row that has no gate sentence to wear in its hover. */
  'board.row.go': '去这条会话',

  /* ── The map ──────────────────────────────────────────────────────────────────────────────── */
  'map.region.aria': '整张图',
  'map.overview.aria': '全览 / 回到焦点',
  'map.refresh.aria': '重新读一遍',
  'map.card.aria': '{node} 的会话',
  'map.card.go': '再按一下去这条会话',

  /* ── The list ─────────────────────────────────────────────────────────────────────────────── */
  'detail.folded.cells.one': ' 格',
  'detail.folded.cells.other': ' 格',
  /* The one action a ready cell carries: the host opens the session itself, the plan's first
   * instruction goes in verbatim. */
  'node.open': '开会话',
  /* The stranded dispatch: the claim is on disk, the session is gone. The sentence names the two
   * record words the remedy names, and the exact word line, so it can be followed as it is read. */
  'cell.stranded': '这一格的认领还在盘上，会话已经不在了：请 `cycle retry {cycle} {node} --drop` 清掉认领，再 `dispatch {cycle}` 重开这一棒。',

  /* ── The instruction ledger ───────────────────────────────────────────────────────────────── */
  'notes.scroll.aria': '用户指令',
  'notes.scope.aria': '这句话管到哪儿',
  'notes.text.placeholder': '原话照抄',
  'notes.text.aria': '原话照抄',
  'notes.add': '添加',
  'notes.empty': '这份记录里还没有指令。',
  'notes.empty-live': '现在没有生效的指令。',
  'notes.in-force': ' 生效',
  'notes.entries.one': ' 条',
  'notes.entries.other': ' 条',
  'notes.out-of-scope': '范围外',
  'notes.archived-mark': '已归档',
  'notes.said-at': '说于',
  'notes.said-mark': '{mark}于',
  'notes.archive.tip': '收进归档：这一条不再生效，条目留在原处',
  'notes.revive.tip': '让它重新生效',
  'notes.delete.tip': '删掉：这一条连同正文一起从记录里拿走，放不回来',
  'notes.delete.name': '删除这一条',
  'notes.delete.warning': '此次删除将移除该指令的存在痕迹。',

  /* ── The issue pool ───────────────────────────────────────────────────────────────────────── */
  'pool.detail-level.aria': '问题池的详略',
  'pool.lean.tip': '{state} {count} 条',
  'pool.lean': '精简',
  'pool.full': '完整',
  'pool.scroll.aria': '问题池',
  'pool.grip.aria': '问题池与一案的宽度',
  'pool.case.aria': '一案',
  'pool.weight.tip': '{severity} · 权重 {weight} · {title}',
  'pool.gauge.aria': '问题池重量与策略线',
  'pool.policy-line.tip': '策略线：issue_pool_weight_limit = {value}',
  'pool.severity.tip': '{severity} · 权重 {weight}',
  'pool.case.description': '现象',
  'pool.case.suggestion': '修法',
  'pool.case.locations': '位置',
  'pool.case.plan': '方案',

  /* ── Project settings ─────────────────────────────────────────────────────────────────────── */
  'config.categories.aria': '设置分组',
  'config.file.project.term': '项目层',
  'config.file.line.term': '管线层',
  'config.group.general': '常规',
  'config.group.issue': '问题',
  'config.group.test': '测试',
  'config.group.line': '管线',
  'config.line.pick.aria': '选择要设置的管线',
  'config.line.state.running': '进行中',
  'config.line.state.waiting': '等待处理',
  'config.line.state.idle': '空闲',
  'config.line.empty': '这个工作区还没有线。',
  'config.toggle.on': '开',
  'config.toggle.off': '关',
  'config.unregistered-caption': '暂无说明，输入值由引擎校验',
  'config.layer.default': '默认',
  'config.layer.cycle': '管线',
  'config.layer.project': '本项目',
  'config.row.answer.name': '术语解释级别',
  'config.row.answer.caption': 'plain 附带通俗解释，technical 仅使用专业术语',
  'config.row.worktree_mode.name': 'Worktree 隔离模式',
  'config.row.worktree_mode.caption': '控制节点任务是否在独立的 Git worktree 中执行',
  'config.row.test_tier.name': '测试范围',
  'config.row.test_tier.caption': 'full 运行完整测试套件，minimal 仅运行核心检查项',
  'config.row.max_agents.name': '并发 Subagent 上限',
  'config.row.max_agents.caption': '单个会话内允许同时运行的子代理最大数量',
  'config.row.issue_repair.name': '问题池自动修复',
  'config.row.issue_repair.caption': '问题池超限时自动插入修复节点，关闭则不触发',
  'config.row.issue_pool.name': '问题池超限自动修复',
  'config.row.issue_pool.caption': '节点完成时若问题池总权重超限，自动插入修复节点',
  'config.row.issue_pool_weight_limit.name': '问题池权重上限',
  'config.row.issue_pool_weight_limit.caption': '触发修复节点的问题池总权重阈值，留空则不限制',
  'config.row.test_audit.name': '测试超时自动精简',
  'config.row.test_audit.caption': '节点完成时若完整测试耗时超限，自动插入精简节点',
  'config.row.test_seconds_limit.name': '测试耗时上限（秒）',
  'config.row.test_seconds_limit.caption': '触发测试精简的完整套件耗时阈值，留空则不限制',
  /* The line category's rows: the engine's four line policies, then the plugin knobs a line may
   * carry — the knobs keep the names the project rows use, and speak these captions under the picker. */
  'config.line.row.when_shelved.name': '节点未交付处理',
  'config.line.row.when_shelved.caption': '节点未交付时，管线暂停等待（stop）或搁置后继续（continue）',
  'config.line.row.parallel.name': '管线最大并发数',
  'config.line.row.parallel.caption': '该管线同时执行的最大节点与会话数量',
  'config.line.row.stop_after_nodes.name': '单次运行节点上限',
  'config.line.row.stop_after_nodes.caption': '完成指定数量节点后自动停止管线，留空则不限制',
  'config.line.row.model.name': '指定模型',
  'config.line.row.model.caption': '管线会话使用的模型（provider/model），留空则沿用默认配置',
  'config.line.row.issue_pool.caption': '该管线节点完成时是否检查问题池权重，设置后覆盖项目配置',
  'config.line.row.issue_pool_weight_limit.caption': '该管线专属的问题池权重阈值，留空则继承项目配置',
  'config.line.row.test_audit.caption': '该管线节点完成时是否检查测试耗时，设置后覆盖项目配置',
  'config.line.row.test_seconds_limit.caption': '该管线专属的测试耗时阈值（秒），留空则继承项目配置',

  /* ── What a node is waiting on ────────────────────────────────────────────────────────────── */
  /* The owed-prerequisite sentence is asked for in two pieces, around the number: the panel styles
   * that number, and a language is free to put it first (see the English table, where the head
   * is empty). Splitting one finished sentence on the number would break the moment word order
   * moved. */
  'deps.owed.head': '前置节点 ',
  'deps.owed.tail': ' 个',

  /* ── The reading marks shared by the panes ────────────────────────────────────────────────── */
  'marks.running.elapsed': '进行中 · {elapsed}',

  /* ── How a moment reads ───────────────────────────────────────────────────────────────────── */
  /* Which moment is "now" is decided once, on the fetch beat, and handed to these words; they take
   * the current time from the caller and never read a clock of their own. */
  'date.today': '今天',
  'date.yesterday': '昨天',
  'date.before-yesterday': '前天',
  'date.month-day': '{month}月{day}日',

  /* ── How a span reads ────────────────────────────────────────────────────────────────────── */
  /* The unit the model measured, said in this language's own hand: the hours and the minutes left
   * past them, the minutes and the seconds left past them, or the smaller unit alone when nothing
   * is left past it. No verb stands beside the number — no "已运行" — because a window putting a
   * number on its own title line has already said what the number is about. */
  'span.hours-minutes': '{hours}小时{minutes}分',
  'span.hours': '{hours}小时',
  'span.minutes-seconds': '{minutes}分{seconds}秒',
  'span.minutes': '{minutes}分',
  'span.seconds': '{seconds}秒',

  /* ── The overview ─────────────────────────────────────────────────────────────────────────── */
  /* The stage's empty state: what the record says when no window can be drawn. Three situations,
   * three sentences — a record with no node, one that names no session yet, and one whose sessions
   * are none of them drawable now — because they are different things to know. The stage says which
   * one it is and nothing more: the move is the standing corner's doors, which need no sentence. */
  'overview.empty.no-nodes': '这个工作区还没有节点。',
  'overview.empty.no-session': '这个工作区没有已执行的节点。',
  'overview.empty.no-window': '当前没有可识别的运行中会话。',
  /* The standing corner: two doors and their fold. The words name the two skills' own work — the
   * graph's and the line's — and are heard only, never drawn: the doors answer with glyphs. */
  'overview.launch.pin': '启动',
  'overview.launch.route': '开一个改图会话',
  'overview.launch.conduct': '开一个推线会话',
  /* A window's own readings line and its rows' verbs. The two person-waiting modes reuse the gate
   * words — the same fact said the same way on every view — so only the third mode needs a word of
   * its own here. */
  'overview.weight.light': '轻',
  'overview.weight.standard': '标准',
  'overview.mode.auto': '自动',
  /* The feed's own row words. `input` names the prompt the conversation was handed — the one row that
   * is not the conversation's, drawn so the reply has something above it to reply to. It reads as the
   * action word the others are, never as a verb of the reader's: it says what this line is, the way
   * `思考` and `输出` do. */
  'overview.row.input': '输入',
  'overview.row.think': '思考',
  'overview.row.read': '读取',
  'overview.row.write': '写入',
  'overview.row.run': '运行',
  'overview.row.output': '输出',
  'overview.row.dispatch': '派出',
  'overview.row.fail': '失败',
  'overview.row.tool': '调用',
  /* The one short word a broken window's line says: why this step stands as a break, in the fewest
   * syllables the reader can still tell apart. The turn's own reason is carried verbatim off DSH's
   * `turn/end` where there is one. `before` is the word for the break the log cannot name — the turn
   * closed by itself (`completed` says the model stopped talking, never that the work landed) with no
   * ticket handed in behind it, so the line says what actually happened instead of repeating a word
   * that would read as success. `other` is also the word for an ending the log does not carry. */
  'overview.fault.before': '提前结束',
  'overview.fault.user': '被手动停下',
  'overview.fault.disposed': '宿主中断',
  'overview.fault.interrupted': '进程中断',
  'overview.fault.error': '出错',
  'overview.fault.other': '没有交代',
  /* The name a window whose title the record does not name is announced by: what pressing it does. */
  'overview.window.aria': '打开这个会话',
  /* The stage's two drawings, on the pane's own corner control: every row the feed holds, or one line
   * per step. `draw` rather than `mode`, because `overview.mode.*` above is the node's own mode, and
   * one word must not come to mean two things. */
  'overview.draw.aria': '这一步怎么画',
  'overview.draw.full': '完整',
  'overview.draw.brief': '简洁',
  /* A step said in one line. Every word below is DSH's own — `message.stepProcess.*` in `ui-chat`'s
   * locale table — quoted as it stands, so a collapsed step in the harness's conversation and a step
   * on this stage say the same thing. `done` is what a finished step did; `run` is what the step being
   * worked is on. The one deviation is `done.subagents`: this panel calls a dispatch 派出, and its
   * full feed has said so since the row existed.
   *
   * The four pieces under them are DSH's join and not words of this panel's: `joinTwo` binds two
   * categories, `shared` is the prefix two labels elide when both open with it, `comma` joins three,
   * and `more` closes a title that had more than three. */
  'brief.done.thinking': '已完成分析',
  'brief.done.read': '已读取文件',
  'brief.done.readImage': '已读取图片',
  'brief.done.search': '已搜索代码',
  'brief.done.write': '已写入文件',
  'brief.done.edit': '修改了文件',
  'brief.done.commands': '执行了命令',
  'brief.done.code': '运行了代码',
  'brief.done.webSearch': '已搜索网页',
  'brief.done.webFetch': '已访问网页',
  'brief.done.subagents': '已派出',
  'brief.done.plan': '更新了计划',
  'brief.done.questions': '向用户提出了问题',
  'brief.done.tools': '已调用工具',
  'brief.run.thinking': '正在分析请求',
  'brief.run.read': '正在读取文件',
  'brief.run.readImage': '正在读取图片',
  'brief.run.search': '正在搜索代码',
  'brief.run.write': '正在写入文件',
  'brief.run.edit': '正在编辑文件',
  'brief.run.commands': '正在运行命令',
  'brief.run.code': '正在运行代码',
  'brief.run.webSearch': '正在搜索网页',
  'brief.run.webFetch': '正在访问网页',
  'brief.run.subagents': '正在派出',
  'brief.run.plan': '正在更新计划',
  'brief.run.questions': '等待你的操作',
  'brief.run.tools': '正在调用工具',
  'brief.step.joinTwo': '{first}并{second}',
  'brief.step.shared': '已',
  'brief.step.comma': '，',
  'brief.step.more': '{title}等',

  /* ── When an operation is refused ─────────────────────────────────────────────────────────── */
  /* Each code from `src/host/failure.ts` and `src/client/failure.ts` reads as one of these.
   *
   * Two of them are the whole detail and nothing else: `tool-refused` and `transport-failed` carry
   * another program's words — the words layer's own reason, or a message from the transport — and no
   * table here owns those. They are carried out verbatim, which is also why the panel can show
   * them in a language it does not speak; `failure.unstated` stands in when they said nothing. */
  'failure.arg-not-allowed': '该参数不能进入记录：{detail}',
  'failure.root-not-string': '这次调用交给它的工作区根不是一个名字：{detail}',
  'failure.tool-refused': '{detail}',
  'failure.scope-unknown': '无法识别的范围：{detail}',
  'failure.empty-text': '空话不落笔：先写一句原话。',
  'failure.no-session-service': '这个宿主没有 {detail} 服务，开不了会话。',
  'failure.prompt-missing': '这一格的派发提示不在记录里（{detail}）：先派发，再开会话。',
  'failure.open-failed': '会话没有开成：{detail}',
  'failure.dispatch-refused': '派发没有完成：{detail}',
  'failure.no-operation': '这条通道上没有 {detail} 这个操作。',
  'failure.not-connected': '该部署未连接记录服务，无法读取记录。',
  'failure.no-write-channel': '该部署没有可用的写入通道。',
  'failure.unparsable-answer': '宿主返回了无法解析的数据。',
  'failure.transport-failed': '{detail}',
  'failure.config-unreadable': '无法读取该工作区的项目设置。',
  'failure.config-write-failed': '这次写入没有生效。',
  'failure.settings-refused': '保存失败：设置服务没有接受这次改动。',
  'failure.settings-unwritable': '显示偏好未能保存：设置服务未连接，本次改动只在当前页面生效。',
  'failure.unstated': '这次操作没有成功，也没有说出原因。',
} as const

/**
 * Every key this panel can ask for.
 *
 * Derived from the table above rather than declared separately: one list, so a key cannot exist
 * in the type and be missing from the words. Every other locale is typed against this, which is what
 * makes a missing or extra key a compile error.
 */
export type WordKey = keyof typeof zh