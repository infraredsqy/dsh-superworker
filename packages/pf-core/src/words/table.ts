import type { TableTop, WordRow } from './types';

/**
 * The words table: one row per word, and every cell states that word's shape -- the usage line's
 * required / repeated / exclusive shapes, the two section listings, each option's invocation and its
 * help. The parser, the help printer and the router all read this one table, so a word cannot be
 * routable and unprintable at the same time.
 *
 * Frozen: edit a row only together with the surface it describes. This is the one copy: the
 * transport layer in front of the engine reads it from here.
 */
/**
 * The command table: one row per word, and every cell states that word's shape -- the usage line's
 * required / repeated / exclusive shapes, the two section listings, each option's invocation and its
 * help. The parser, the help printer and the router all read this one table, so a word cannot be
 * routable and unprintable at the same time.
 *
 * Frozen: edit a row only together with the surface it describes.
 */
export const TOP = {
  "prog": "pathfinder",
  "verbs": [
    "init",
    "register",
    "plan",
    "hold",
    "settle",
    "advance",
    "dispatch",
    "clean-temp",
    "handoff",
    "merge-ledger"
  ],
  "groups": [
    "cycle",
    "dag",
    "config",
    "instruction",
    "session"
  ]
};

export const COMMANDS = {
  "init": {
    "word": "init",
    "prog": "init",
    "description": "Write `.pf/.gitignore` and `.pf/.gitattributes`, and decide whether this project commits its `.pf/` or keeps that directory to itself. `--local` (the default) writes one line into the repository's `info/exclude` -- a per-clone file, so no teammate ever sees a line about a directory that does not exist for them -- and gives `.pf/` its own repository unless `--no-own-repo`. `--commit` takes the exclude line back out and lets `.pf/` travel with the project. Idempotent: re-running it never does anything twice, and switching modes is just running it again with the other flag.",
    "positionals": [],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      },
      {
        "flags": [
          "--local"
        ],
        "help": "Keep `.pf/` out of the project's repository (the default)",
        "invocation": "--local"
      },
      {
        "flags": [
          "--commit"
        ],
        "help": "Let `.pf/` go into the project's repository",
        "invocation": "--commit"
      },
      {
        "flags": [
          "--own-repo"
        ],
        "help": "Local mode only: give `.pf/` a repository of its own (the default)",
        "invocation": "--own-repo"
      },
      {
        "flags": [
          "--no-own-repo"
        ],
        "help": "Local mode only: leave `.pf/` as plain ignored files",
        "invocation": "--no-own-repo"
      }
    ],
    "exclusive": [
      [
        "--local",
        "--commit"
      ]
    ]
  },
  "register": {
    "word": "register",
    "prog": "register",
    "description": "Set `merge.pf.name` and `merge.pf.driver` in the project's git config. `init` already does this as part of its one setup act; the verb is here so a project can be brought forward, or a moved checkout re-pointed, without re-running setup. `register` calls exactly this.",
    "positionals": [],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      }
    ]
  },
  "plan": {
    "word": "plan",
    "prog": "plan",
    "description": "Read-only: what the next step is, writing not one byte. The answer is one action -- `dispatch` (a node is claimed: send it out, and it lands the cell''s material when the claim left none), `open_node` (the line holds no node: the head of the ranking is what a claim would pick -- `hold` names it), `stop_pipeline` (nothing left, or the line was stopped), `wait` (a ticket is owed or a session is already out: read `note` / `close_with`, never poll), `ask_user`, `no_cycle` -- plus the cells a reader acts on. `--after <node>` asks the closing question instead: that node''s ticket is on disk, and settling it, where would the line go. Carrying any of it out is `dispatch` (the single op) or `advance` (claim, material and session in one word).",
    "positionals": [],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "Print `plan`'s help (the tail carries the full set of actions)",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--cycle"
        ],
        "metavar": "CYCLE",
        "help": "Cycle id (default: the single active cycle)",
        "invocation": "--cycle CYCLE"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      },
      {
        "flags": [
          "--after"
        ],
        "metavar": "NODE_ID",
        "help": "The closing rehearsal: this node has handed in its ticket, and settling it, where would the line go. Read-only all the same -- the writing half is `settle`",
        "invocation": "--after NODE_ID"
      },
      {
        "flags": [
          "--json"
        ],
        "help": "Print raw JSON",
        "invocation": "--json"
      }
    ],
    "epilog": "the full set of actions `plan` returns (the discriminant is the `action` field):\n  dispatch        a node is claimed -- `dispatch <cycle>` lands its material if the claim left none and opens its session\n  open_node       the line holds no node and the ranking's head is what a claim would pick -- `hold <node>` claims it, then `dispatch <cycle>` opens it\n  stop_pipeline   nothing left to do, the line was stopped, or nothing is left in its picking range -- read `reason`\n  wait            it is not yet time to act -- read `note` / `close_with`, never poll\n  ask_user        the state cannot explain itself -- ask a human\n  no_cycle        there is no line yet -- opening one takes a human's intent\n\nthe standard flow is one word per operation: `plan` reads, `hold` claims, `dispatch` opens; a node's end is `handoff` then `settle`. `advance` is those three moves as one word (claim, material, session) for the host that drives the line by itself.\n\nInvariant: the action is a reading of the records. The words that write are `settle`, `hold`, `dispatch` and `advance`."
  },
  "hold": {
    "word": "hold",
    "prog": "hold",
    "description": "Put nodes into this line's hand: the claim that makes `dispatch` send them out. One node belongs to one line at a time -- a node another line holds stops the whole call before one byte is written. It writes the line's `holding` and nothing else: no material, no session, no path step, no status. The line is named with `--cycle`; without it the single active line is taken, and a line that is not in service is refused (put it back with `cycle status <id> active`).",
    "positionals": [
      {
        "name": "node",
        "metavar": "node",
        "required": true,
        "nargs": "+"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "Print `hold`'s help",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--cycle"
        ],
        "metavar": "CYCLE",
        "help": "Cycle id (default: the single active cycle)",
        "invocation": "--cycle CYCLE"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      }
    ],
    "epilog": "the claim step of the standard flow: `plan` names the head of the ranking, `hold <node>` puts it in the line's hand, `dispatch <cycle>` lands its material and opens its session. Several ids in one line are one write, all or none. An id already in that hand is not an error (nothing is written twice); an id another line holds is refused with nothing written."
  },
  "settle": {
    "word": "settle",
    "prog": "settle",
    "description": "Record one node''s end: read its handoff ticket, put the verdict into the line''s `path`, lay the claim down, mark the graph node `completed` / `shelved`, and run the close-time plugin seam (an offer may put a node into the graph, wired in front of the node this close would have opened next). It claims nothing, lands no prompt, opens no session and stops no line -- the next claim is `hold`''s, the session is `dispatch`''s, and the plan printed underneath says who they touch. A missing ticket, or one still `pending`, is refused with nothing written. `--dry-run` is the same gates and criteria with the effect shaped away: it reports the step, the graph mark and what the seam would insert, and writes not one byte (a plugin that ships no close preview is skipped, with one WARNING line).",
    "positionals": [
      {
        "name": "node",
        "metavar": "NODE",
        "required": true,
        "help": "The node whose ticket is on disk. The line holding it is read off the claim table unless --cycle names one"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--cycle"
        ],
        "metavar": "CYCLE",
        "help": "Cycle id (default: the line holding the node)",
        "invocation": "--cycle CYCLE"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      },
      {
        "flags": [
          "--dry-run"
        ],
        "help": "Rehearse it: the path step, the graph mark and the close-time seam, with not one byte written",
        "invocation": "--dry-run"
      },
      {
        "flags": [
          "--json"
        ],
        "help": "Print raw JSON",
        "invocation": "--json"
      }
    ],
    "epilog": "settle is the write half of a worker''s close, and the whole of it: the line''s hand does not move. To stop the line: `cycle status <cycle> inactive`. To name the next node: `hold <node> --cycle <cycle>`. To read what happens next without doing it: `plan --after <node>`; to read what this settle itself would write, `--dry-run`."
  },
  "advance": {
    "word": "advance",
    "prog": "advance",
    "description": "The composed word, and nothing new: claim the nodes the line has free slots for (the head of the graph''s ranking, as many as `parallel` allows), land each one''s prompt and run doc, then open one session per cell in hand; a line that stopped with nothing left is turned `inactive`. Every move in it is a word of its own (`hold`, `dispatch`), so the same work can always be done one reading at a time. It settles nothing -- a node whose work ended is recorded by `settle` -- and it never moves a node''s status.",
    "positionals": [],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--cycle"
        ],
        "metavar": "CYCLE",
        "help": "Cycle id (default: the single active cycle)",
        "invocation": "--cycle CYCLE"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      },
      {
        "flags": [
          "--model"
        ],
        "metavar": "ROUTE",
        "help": "The model route these sessions open with (`provider/model`). Default: the line''s own `model` policy, then the machine''s `DSH_CONDUCT_MODEL`, then the host''s default.",
        "invocation": "--model ROUTE"
      },
      {
        "flags": [
          "--json"
        ],
        "help": "Print raw JSON",
        "invocation": "--json"
      }
    ],
    "epilog": "the composed step: claim (`hold`), material (the dispatch preparation) and session (`dispatch`), in that order, for whatever the plan says. It is never required -- `plan` -> `hold` -> `dispatch` is the same work with a reading between the moves -- and it is what the host runs when it drives a line with nobody in between."
  },
  "dispatch": {
    "word": "dispatch",
    "prog": "dispatch",
    "description": "Open the sessions of the nodes this cycle holds, and nothing else: land each cell''s material when it is not on disk yet (the prompt at .pf/meta/launch/<cycle>/<node>/prompt.txt, the run doc), hand it to the executor, and stamp the cell `started`. It never claims a node -- that is `hold` -- and it never settles one; that makes \"commit and push first, then open the next session\" expressible as two commands. `--dry-run` is the same gates with the effect shaped away: it reports the cells it would hand over, where each material stands, the model route, and the lines a dispatch-time gate would refuse with -- writing nothing, claiming nothing and opening nothing (so a process without an opener can rehearse too). DSH_CONDUCT_SPAWN_DRY_RUN=1 is the machine-wide drill of the same call: it goes through the executor, which answers it without opening a session.",
    "positionals": [
      {
        "name": "id",
        "metavar": "id",
        "required": true,
        "help": "Cycle id"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      },
      {
        "flags": [
          "--json"
        ],
        "help": "Print raw JSON",
        "invocation": "--json"
      },
      {
        "flags": [
          "--dry-run"
        ],
        "help": "Rehearse it: the cells, their material and route, and the lines a dispatch-time gate would refuse with -- nothing written, nothing claimed, no session opened",
        "invocation": "--dry-run"
      },
      {
        "flags": [
          "--model"
        ],
        "metavar": "ROUTE",
        "help": "The model route this session opens with (`provider/model`). Default: the line's own `model` policy, then the machine's `DSH_CONDUCT_MODEL`, then the host's default.",
        "invocation": "--model ROUTE"
      }
    ]
  },
  "clean-temp": {
    "word": "clean-temp",
    "prog": "clean-temp",
    "description": null,
    "positionals": [],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      },
      {
        "flags": [
          "--node"
        ],
        "metavar": "NODE",
        "help": "Only this node id (prefix is enough)",
        "invocation": "--node NODE"
      },
      {
        "flags": [
          "--yes"
        ],
        "help": "Actually delete; without it, only list",
        "invocation": "--yes"
      },
      {
        "flags": [
          "--force"
        ],
        "help": "Also clear a node a cycle is holding right now (its session is gone and the claim was never released)",
        "invocation": "--force"
      }
    ]
  },
  "handoff": {
    "word": "handoff",
    "prog": "handoff",
    "description": "Write one node's signal and hand the baton on (one command for a worker).",
    "positionals": [
      {
        "name": "cycle",
        "metavar": "cycle",
        "required": true
      },
      {
        "name": "node",
        "metavar": "node",
        "required": false,
        "help": "The DAG node this session was working on"
      },
      {
        "name": "{completed,failed,stopped}",
        "metavar": "{completed,failed,stopped}",
        "required": false,
        "help": "",
        "choices": [
          "completed",
          "failed",
          "stopped"
        ]
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "-s",
          "--summary"
        ],
        "metavar": "SUMMARY",
        "help": "",
        "invocation": "-s, --summary SUMMARY"
      },
      {
        "flags": [
          "-o",
          "--outputs"
        ],
        "metavar": "OUTPUTS",
        "help": "JSON object of key outputs. `@path` reads it from a file and `-` from the caller's own input source: an inline object keeps its quotes only where the shell leaves them alone, and the Windows `.cmd` shim does not",
        "invocation": "-o, --outputs OUTPUTS"
      },
      {
        "flags": [
          "--form"
        ],
        "help": "Print the ticket shape this line asks for, and stop (writes nothing)",
        "invocation": "--form"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: cwd)",
        "invocation": "--project PROJECT"
      },
    ]
  },
  "doctor": {
    "word": "doctor",
    "prog": "doctor",
    "description": "Read the health of this tree and this project, cell by cell.",
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--fix"
        ],
        "help": "run `init` once afterwards, to fill in the layout files a red cell named",
        "invocation": "--fix"
      }
    ]
  },
  "version": {
    "word": "version",
    "prog": "version",
    "description": "Print which package this is, its version, and the directory it was read from.",
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      }
    ]
  },
  "merge-ledger": {
    "word": "merge-ledger",
    "prog": "merge-ledger",
    "description": "Three-way merge of one pf ledger file (a git merge driver: %O %A %B [%P]).",
    "positionals": [
      {
        "name": "base",
        "metavar": "base",
        "required": true,
        "help": "git's %O -- the common ancestor"
      },
      {
        "name": "ours",
        "metavar": "ours",
        "required": true,
        "help": "git's %A -- the merged result is written HERE"
      },
      {
        "name": "theirs",
        "metavar": "theirs",
        "required": true,
        "help": "git's %B -- the other branch"
      },
      {
        "name": "path",
        "metavar": "path",
        "required": false,
        "help": "git's %P -- the ledger's path in the repo, which is what names it (under git, %O/%A/%B are temp files)"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--dry-run"
        ],
        "help": "Print the decisions and write nothing",
        "invocation": "--dry-run"
      }
    ]
  },
  "cycle create": {
    "word": "create",
    "prog": "cycle create",
    "description": null,
    "positionals": [
      {
        "name": "id",
        "metavar": "id",
        "required": true
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--title"
        ],
        "metavar": "TITLE",
        "help": "Cycle title (auto-generated if omitted)",
        "invocation": "--title TITLE"
      },
      {
        "flags": [
          "--force"
        ],
        "help": "Create it while another cycle is still active",
        "invocation": "--force"
      },
      {
        "flags": [
          "--tags"
        ],
        "metavar": "TAGS",
        "help": "Comma-separated filter set for what this cycle picks from: writing / coding / art. Required -- a call without it is refused: an empty scope leaves this line nothing to pick from",
        "invocation": "--tags TAGS"
      }
    ],
    "group": "cycle",
    "summary": "Create a new cycle"
  },
  "cycle start": {
    "word": "start",
    "prog": "cycle start",
    "description": null,
    "positionals": [
      {
        "name": "id",
        "metavar": "id",
        "required": true
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--title"
        ],
        "metavar": "TITLE",
        "help": "The user's words, verbatim",
        "invocation": "--title TITLE"
      },
      {
        "flags": [
          "--tags"
        ],
        "metavar": "TAGS",
        "help": "Comma-separated filter set for this cycle: it decides which nodes the first pick and every later pick may take (writing / coding / art). Required -- a call without it is refused: an empty scope leaves this line nothing to pick from",
        "invocation": "--tags TAGS"
      },
      {
        "flags": [
          "--parallel"
        ],
        "metavar": "PARALLEL",
        "help": "How many nodes this line holds and runs at once: pin that many of the ready set right here, and write it down as the line's `parallel` policy (same slot `cycle policy <id> parallel <n>` writes). A positive integer, or `off` for the default 1",
        "invocation": "--parallel PARALLEL"
      },
      {
        "flags": [
          "--force"
        ],
        "help": "Start anyway while another cycle is active (a bare `next` will then have to be told which cycle)",
        "invocation": "--force"
      }
    ],
    "group": "cycle",
    "summary": "Create a cycle AND pin it on the node the rule picks (one command for the launcher). Refuses on an empty graph, and refuses while another cycle is still active unless --force"
  },
  "cycle rename": {
    "word": "rename",
    "prog": "cycle rename",
    "description": null,
    "positionals": [
      {
        "name": "id",
        "metavar": "id",
        "required": true
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--title"
        ],
        "metavar": "TITLE",
        "required": true,
        "help": "New title",
        "invocation": "--title TITLE"
      }
    ],
    "group": "cycle",
    "summary": "Rename an existing cycle"
  },
  "cycle status": {
    "word": "status",
    "prog": "cycle status",
    "description": null,
    "positionals": [
      {
        "name": "id",
        "metavar": "id",
        "required": true
      },
      {
        "name": "{active,inactive}",
        "metavar": "{active,inactive}",
        "required": true,
        "help": "",
        "choices": [
          "active",
          "inactive"
        ]
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      }
    ],
    "group": "cycle",
    "summary": "Put the line in or out of service: active | inactive"
  },
  "cycle policy": {
    "word": "policy",
    "prog": "cycle policy",
    "description": null,
    "positionals": [
      {
        "name": "id",
        "metavar": "id",
        "required": true
      },
      {
        "name": "{issue_pool,issue_pool_weight_limit,model,parallel,test_audit,test_seconds_limit,when_shelved}",
        "metavar": "{issue_pool,issue_pool_weight_limit,model,parallel,test_audit,test_seconds_limit,when_shelved}",
        "required": true,
        "help": "",
        "choices": [
          "issue_pool",
          "issue_pool_weight_limit",
          "model",
          "parallel",
          "test_audit",
          "test_seconds_limit",
          "when_shelved"
        ]
      },
      {
        "name": "value",
        "metavar": "value",
        "required": true,
        "help": "The value, in the key's own kind -- when_shelved: stop | continue -- what this line does when a node comes back not delivered: stop and wait for a human, or mark it shelved and carry on (default: stop); parallel: a positive integer -- how many nodes this line holds and how many sessions it opens at once (a cap: whether they can run side by side is the graph's call) (default: 1); issue_pool_weight_limit: a positive number -- the issue pool's weighted sum the next close must read below; test_seconds_limit: a positive number -- the project test suite's full wall clock (seconds) the next close must read below; model: a route word -- which model the sessions this line opens use (`provider/model`, carried whole to the opener; a call's own --model wins over it). Every knob a plugin declares rides on this line too. A core setting does not: it takes the project and global layers only, and `config set` is its door. `off` drops this line's entry for a number / integer / word, so the next layer of the chain shows through; on a switch it is a value -- a switch is turned off by writing `off`, and dropping its entry is `config unset --cycle`. Numbers and integers take a positive value only: a line of 0 fails every reading"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      }
    ],
    "group": "cycle",
    "summary": "Write one policy on this line's own record (the effective set is echoed back; a core setting is `config set`'s, not this line's)"
  },
  "cycle list": {
    "word": "list",
    "prog": "cycle list",
    "description": null,
    "positionals": [],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      }
    ],
    "group": "cycle",
    "summary": "Show all cycles (state.json)"
  },
  "cycle current": {
    "word": "current",
    "prog": "cycle current",
    "description": null,
    "positionals": [],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      }
    ],
    "group": "cycle",
    "summary": "Show the active cycle and the node it holds"
  },
  "cycle show": {
    "word": "show",
    "prog": "cycle show",
    "description": null,
    "positionals": [
      {
        "name": "id",
        "metavar": "id",
        "required": true
      },
      {
        "name": "node",
        "metavar": "node",
        "required": true
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      }
    ],
    "group": "cycle",
    "summary": "One node's standing in a cycle: signal + path step"
  },
  "cycle close": {
    "word": "close",
    "prog": "cycle close",
    "description": null,
    "positionals": [
      {
        "name": "id",
        "metavar": "id",
        "required": true
      },
      {
        "name": "node",
        "metavar": "node",
        "required": true
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--result"
        ],
        "metavar": "{completed,failed,stopped}",
        "required": true,
        "choices": [
          "completed",
          "failed",
          "stopped"
        ],
        "help": "completed | failed | stopped (what the worker reported)",
        "invocation": "--result {completed,failed,stopped}"
      }
    ],
    "group": "cycle",
    "summary": "Record the step on the cycle's path and let the node go"
  },
  "cycle retry": {
    "word": "retry",
    "prog": "cycle retry",
    "description": null,
    "positionals": [
      {
        "name": "id",
        "metavar": "id",
        "required": true
      },
      {
        "name": "node",
        "metavar": "node",
        "required": true
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--summary"
        ],
        "metavar": "SUMMARY",
        "help": "Why the node was restarted",
        "invocation": "--summary SUMMARY"
      },
      {
        "flags": [
          "--drop"
        ],
        "help": "Leave no ticket at all. A `pending` ticket is a red light: `next` waits on it forever, so dropping it is what lets the retry be dispatched",
        "invocation": "--drop"
      }
    ],
    "group": "cycle",
    "summary": "Take a node signal out of the way (retries): rewrite it as pending, or --drop to leave no ticket at all"
  },
  "dag add": {
    "word": "add",
    "prog": "dag add",
    "description": null,
    "positionals": [
      {
        "name": "title",
        "metavar": "title",
        "required": false,
        "help": "Node title"
      },
      {
        "name": "description",
        "metavar": "description",
        "required": false,
        "help": "Description text (positional, space-separated)",
        "nargs": "*"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--desc"
        ],
        "metavar": "DESC",
        "help": "Description text (flag, alternative to positional)",
        "invocation": "--desc DESC"
      },
      {
        "flags": [
          "--depends-on"
        ],
        "metavar": "DEPENDS_ON",
        "help": "Comma-separated dependency UUIDs",
        "invocation": "--depends-on DEPENDS_ON"
      },
      {
        "flags": [
          "--mode"
        ],
        "metavar": "{manual,auto,checkpoint}",
        "choices": [
          "manual",
          "auto",
          "checkpoint"
        ],
        "help": "Node execution mode: manual/checkpoint/auto (default: auto). manual = a discussion node, no execute-review- fix loop; checkpoint = the loop runs, then stops for your go-ahead; auto = the loop runs and the line carries on by itself",
        "invocation": "--mode {manual,auto,checkpoint}"
      },
      {
        "flags": [
          "--weight"
        ],
        "metavar": "{light,standard}",
        "choices": [
          "light",
          "standard"
        ],
        "help": "Node weight: light/standard (default: standard; the key is written only for light). light = the conductor implements it itself and dispatches review alone; standard = it dispatches Execute as usual",
        "invocation": "--weight {light,standard}"
      },
      {
        "flags": [
          "--tags"
        ],
        "metavar": "TAGS",
        "help": "Comma-separated tags: writing / coding / art. Untagged = never filtered",
        "invocation": "--tags TAGS"
      },
      {
        "flags": [
          "--from-file"
        ],
        "metavar": "FILE",
        "help": "Register a batch from a JSON file instead of a title: one node per row. A row may carry a `ref` that this batch's own `depends_on` can name; the whole batch is one graph write, and any bad row, unknown dependency or cycle refuses all of it",
        "invocation": "--from-file FILE"
      }
    ],
    "group": "dag",
    "summary": "Add a new idea node"
  },
  "dag rm": {
    "word": "rm",
    "prog": "dag rm",
    "description": null,
    "positionals": [
      {
        "name": "uuid",
        "metavar": "uuid",
        "required": true,
        "help": "Node UUID"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--force"
        ],
        "help": "Force removal even if depended on",
        "invocation": "--force"
      }
    ],
    "group": "dag",
    "summary": "Remove an idea node"
  },
  "dag update": {
    "word": "update",
    "prog": "dag update",
    "description": null,
    "positionals": [
      {
        "name": "uuid",
        "metavar": "uuid",
        "required": true,
        "help": "Node UUID"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--title"
        ],
        "metavar": "TITLE",
        "help": "New title",
        "invocation": "--title TITLE"
      },
      {
        "flags": [
          "--desc"
        ],
        "metavar": "DESC",
        "help": "New description",
        "invocation": "--desc DESC"
      },
      {
        "flags": [
          "--mode"
        ],
        "metavar": "{auto,checkpoint,manual}",
        "choices": [
          "auto",
          "checkpoint",
          "manual"
        ],
        "help": "New execution mode: manual/checkpoint/auto",
        "invocation": "--mode {auto,checkpoint,manual}"
      },
      {
        "flags": [
          "--weight"
        ],
        "metavar": "{light,standard}",
        "choices": [
          "light",
          "standard"
        ],
        "help": "New weight: light/standard (standard drops the key)",
        "invocation": "--weight {light,standard}"
      },
      {
        "flags": [
          "--tags"
        ],
        "metavar": "TAGS",
        "help": "New tag set, comma-separated (replaces what the node carries)",
        "invocation": "--tags TAGS"
      },
      {
        "flags": [
          "--clear-tags"
        ],
        "help": "Drop every tag: the node becomes visible to all filter sets again",
        "invocation": "--clear-tags"
      }
    ],
    "group": "dag",
    "summary": "Update title and/or description"
  },
  "dag depend": {
    "word": "depend",
    "prog": "dag depend",
    "description": null,
    "positionals": [
      {
        "name": "uuid",
        "metavar": "uuid",
        "required": true,
        "help": "Node UUID that depends on --on"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--on"
        ],
        "metavar": "ON",
        "required": true,
        "help": "Comma-separated dependency ids: `--on a,b,c` (one batch, one write)",
        "invocation": "--on ON"
      }
    ],
    "group": "dag",
    "summary": "Add a dependency edge"
  },
  "dag undepend": {
    "word": "undepend",
    "prog": "dag undepend",
    "description": null,
    "positionals": [
      {
        "name": "uuid",
        "metavar": "uuid",
        "required": true,
        "help": "Node UUID"
      },
      {
        "name": "dep",
        "metavar": "dep",
        "required": false,
        "help": "Dependency UUID to remove (positional)"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--from"
        ],
        "metavar": "FROM_",
        "help": "Dependency UUID to remove (flag, alternative to positional)",
        "invocation": "--from FROM_"
      }
    ],
    "group": "dag",
    "summary": "Remove a dependency edge"
  },
  "dag status": {
    "word": "status",
    "prog": "dag status",
    "description": null,
    "positionals": [
      {
        "name": "uuid",
        "metavar": "uuid",
        "required": true,
        "help": "Node UUID"
      },
      {
        "name": "{todo,shelved,completed}",
        "metavar": "{todo,shelved,completed}",
        "required": true,
        "help": "New status: todo | shelved | completed. todo = in play, not delivered (a node a cycle is working on is still todo); shelved = out of play, waiting for a human (never ready, never recommended; release with status <uuid> todo); completed = delivered",
        "choices": [
          "todo",
          "shelved",
          "completed"
        ]
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      }
    ],
    "group": "dag",
    "summary": "Set node status"
  },
  "dag approve": {
    "word": "approve",
    "prog": "dag approve",
    "description": null,
    "positionals": [
      {
        "name": "uuid",
        "metavar": "uuid",
        "required": true,
        "help": "Node UUID"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--at"
        ],
        "metavar": "AT",
        "help": "The moment of the approval (default: now). Written as given, in the record timestamp shape: 2026-10-16T15:13:44.160813Z",
        "invocation": "--at AT"
      }
    ],
    "group": "dag",
    "summary": "Record that a human approved one node's delivery"
  },
  "dag revive": {
    "word": "revive",
    "prog": "dag revive",
    "description": null,
    "positionals": [
      {
        "name": "uuid",
        "metavar": "uuid",
        "required": true,
        "help": "Node UUID"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      }
    ],
    "group": "dag",
    "summary": "Put a shelved node back to todo so it can run again"
  },
  "dag list": {
    "word": "list",
    "prog": "dag list",
    "description": null,
    "positionals": [],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--ready"
        ],
        "help": "Only show ready nodes (todo, with every dependency completed)",
        "invocation": "--ready"
      },
      {
        "flags": [
          "--status"
        ],
        "metavar": "{todo,shelved,completed}",
        "nargs": "*",
        "choices": [
          "todo",
          "shelved",
          "completed"
        ],
        "help": "Filter by status(es): --status todo shelved completed",
        "invocation": "--status {todo,shelved,completed} [{todo,shelved,completed} ...]"
      },
      {
        "flags": [
          "--verbose",
          "-v"
        ],
        "help": "Show dependencies and dependents",
        "invocation": "--verbose, -v"
      },
      {
        "flags": [
          "--limit",
          "-n"
        ],
        "metavar": "LIMIT",
        "help": "Max items to output (0 = unlimited)",
        "invocation": "--limit, -n LIMIT"
      },
      {
        "flags": [
          "--tags"
        ],
        "metavar": "TAGS",
        "help": "Show only what a filter set like this would pick from: comma-separated tags. An untagged node always stays in view",
        "invocation": "--tags TAGS"
      }
    ],
    "group": "dag",
    "summary": "List nodes sorted by urgency × importance"
  },
  "dag info": {
    "word": "info",
    "prog": "dag info",
    "description": null,
    "positionals": [
      {
        "name": "uuid",
        "metavar": "uuid",
        "required": true,
        "help": "Node UUID"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--verbose"
        ],
        "help": "Extended fields",
        "invocation": "--verbose"
      }
    ],
    "group": "dag",
    "summary": "Show node details"
  },
  "dag context": {
    "word": "context",
    "prog": "dag context",
    "description": null,
    "positionals": [
      {
        "name": "uuid",
        "metavar": "uuid",
        "required": true,
        "help": "Node UUID"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      }
    ],
    "group": "dag",
    "summary": "Show full upstream/downstream context of a node"
  },
  "dag search": {
    "word": "search",
    "prog": "dag search",
    "description": null,
    "positionals": [
      {
        "name": "query",
        "metavar": "query",
        "required": true,
        "help": "Regex pattern (case-insensitive). Always quote: search 'IYL|loading'"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--limit",
          "-n"
        ],
        "metavar": "LIMIT",
        "help": "Max results (0 = unlimited)",
        "invocation": "--limit, -n LIMIT"
      },
      {
        "flags": [
          "--active-only"
        ],
        "help": "Exclude completed nodes from results",
        "invocation": "--active-only"
      }
    ],
    "group": "dag",
    "summary": "Search nodes by title/description using regex"
  },
  "dag open": {
    "word": "open",
    "prog": "dag open",
    "description": null,
    "positionals": [
      {
        "name": "uuid",
        "metavar": "uuid",
        "required": true,
        "help": "Node UUID"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      }
    ],
    "group": "dag",
    "summary": "Print absolute spec.md path"
  },
  "dag validate": {
    "word": "validate",
    "prog": "dag validate",
    "description": null,
    "positionals": [],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      }
    ],
    "group": "dag",
    "summary": "Validate graph integrity"
  },
  "dag help": {
    "word": "help",
    "prog": "dag help",
    "description": null,
    "positionals": [],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      }
    ],
    "group": "dag",
    "summary": "Show the full usage reference"
  },
  "config list": {
    "word": "list",
    "prog": "config list",
    "description": null,
    "positionals": [],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      },
      {
        "flags": [
          "--cycle"
        ],
        "metavar": "CYCLE",
        "help": "Read this line's layer too (a cycle id): what that line sees",
        "invocation": "--cycle CYCLE"
      },
      {
        "flags": [
          "--node"
        ],
        "metavar": "NODE",
        "help": "Read this node's layer too (a node id): what that node's run sees",
        "invocation": "--node NODE"
      }
    ],
    "group": "config",
    "summary": "Every knob's effective value, and the layer it came from"
  },
  "config get": {
    "word": "get",
    "prog": "config get",
    "description": null,
    "positionals": [
      {
        "name": "{issue_pool,issue_pool_weight_limit,max_agents,test_audit,test_seconds_limit,test_tier,worktree_mode}",
        "metavar": "{issue_pool,issue_pool_weight_limit,max_agents,test_audit,test_seconds_limit,test_tier,worktree_mode}",
        "required": true,
        "help": "",
        "choices": [
          "issue_pool",
          "issue_pool_weight_limit",
          "max_agents",
          "test_audit",
          "test_seconds_limit",
          "test_tier",
          "worktree_mode"
        ]
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      },
      {
        "flags": [
          "--cycle"
        ],
        "metavar": "CYCLE",
        "help": "Read this line's layer too (a cycle id)",
        "invocation": "--cycle CYCLE"
      },
      {
        "flags": [
          "--node"
        ],
        "metavar": "NODE",
        "help": "Read this node's layer too (a node id)",
        "invocation": "--node NODE"
      }
    ],
    "group": "config",
    "summary": "Print one effective value, and nothing else"
  },
  "config set": {
    "word": "set",
    "prog": "config set",
    "description": null,
    "positionals": [
      {
        "name": "{issue_pool,issue_pool_weight_limit,max_agents,test_audit,test_seconds_limit,test_tier,worktree_mode}",
        "metavar": "{issue_pool,issue_pool_weight_limit,max_agents,test_audit,test_seconds_limit,test_tier,worktree_mode}",
        "required": true,
        "help": "",
        "choices": [
          "issue_pool",
          "issue_pool_weight_limit",
          "max_agents",
          "test_audit",
          "test_seconds_limit",
          "test_tier",
          "worktree_mode"
        ]
      },
      {
        "name": "value",
        "metavar": "value",
        "required": true
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--global"
        ],
        "help": "Write the global layer (~/.pf/config.json) instead of the project one",
        "invocation": "--global"
      },
      {
        "flags": [
          "--cycle"
        ],
        "metavar": "CYCLE",
        "help": "Write this line's layer instead (a cycle id): the value rides on the cycle record, whose one writer takes it",
        "invocation": "--cycle CYCLE"
      },
      {
        "flags": [
          "--node"
        ],
        "metavar": "NODE",
        "help": "Write this node's layer instead (a node id): `.pf/nodes/<id>/config.json`",
        "invocation": "--node NODE"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      }
    ],
    "exclusive": [
      [
        "--global",
        "--cycle",
        "--node"
      ]
    ],
    "group": "config",
    "summary": "Write one value into exactly one layer (the project layer by default)"
  },
  "config unset": {
    "word": "unset",
    "prog": "config unset",
    "description": null,
    "positionals": [
      {
        "name": "{issue_pool,issue_pool_weight_limit,max_agents,test_audit,test_seconds_limit,test_tier,worktree_mode}",
        "metavar": "{issue_pool,issue_pool_weight_limit,max_agents,test_audit,test_seconds_limit,test_tier,worktree_mode}",
        "required": true,
        "help": "",
        "choices": [
          "issue_pool",
          "issue_pool_weight_limit",
          "max_agents",
          "test_audit",
          "test_seconds_limit",
          "test_tier",
          "worktree_mode"
        ]
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--global"
        ],
        "help": "Drop it from the global layer instead of the project one",
        "invocation": "--global"
      },
      {
        "flags": [
          "--cycle"
        ],
        "metavar": "CYCLE",
        "help": "Drop it from this line's layer instead (a cycle id)",
        "invocation": "--cycle CYCLE"
      },
      {
        "flags": [
          "--node"
        ],
        "metavar": "NODE",
        "help": "Drop it from this node's layer instead (a node id)",
        "invocation": "--node NODE"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      }
    ],
    "exclusive": [
      [
        "--global",
        "--cycle",
        "--node"
      ]
    ],
    "group": "config",
    "summary": "Drop one override, letting the next wider layer take over again"
  },
  "instruction add": {
    "word": "add",
    "prog": "instruction add",
    "description": null,
    "positionals": [],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--text"
        ],
        "metavar": "TEXT",
        "required": true,
        "help": "The sentence, EXACTLY as the user said it",
        "invocation": "--text TEXT"
      },
      {
        "flags": [
          "--scope"
        ],
        "metavar": "{global,cycle,node}",
        "choices": [
          "global",
          "cycle",
          "node"
        ],
        "help": "Where this instruction is visible from (`instruction --help`): global = everywhere; cycle = the cycle it is recorded in, out of sight once that cycle ends; node = the node it is recorded in, out of sight once that node is completed. The cycle/node it binds to come from the state, or from --cycle / --node when the state cannot name one; a cycle/node entry that nothing binds is refused. (default: global -- the noisy side of a coin flip is the safe one)",
        "invocation": "--scope {global,cycle,node}"
      },
      {
        "flags": [
          "--cycle"
        ],
        "metavar": "CYCLE",
        "help": "The line this entry belongs to. Needed while two active cycles run side by side, where the state has no single current one; a cycle-scoped entry with nothing to bind to is refused (it would be read as visible everywhere, forever). Default: the single active cycle",
        "invocation": "--cycle CYCLE"
      },
      {
        "flags": [
          "--node"
        ],
        "metavar": "NODE",
        "help": "The node this entry belongs to, for --scope node. Default: the node the cycle is holding",
        "invocation": "--node NODE"
      },
      {
        "flags": [
          "--target"
        ],
        "metavar": "{stage,boundary}",
        "choices": [
          "stage",
          "boundary"
        ],
        "help": "stage = a constraint every worker must see; boundary = rhythm, read only when a node closes (default: stage)",
        "invocation": "--target {stage,boundary}"
      },
      {
        "flags": [
          "--said-by"
        ],
        "metavar": "SAID_BY",
        "help": "",
        "invocation": "--said-by SAID_BY"
      },
      {
        "flags": [
          "--note"
        ],
        "metavar": "NOTE",
        "help": "",
        "invocation": "--note NOTE"
      },
      {
        "flags": [
          "--stop-after-nodes"
        ],
        "metavar": "STOP_AFTER_NODES",
        "help": "Optional machine-checkable cap: stop once this many nodes have run",
        "invocation": "--stop-after-nodes STOP_AFTER_NODES"
      }
    ],
    "group": "instruction",
    "summary": "Append one instruction, verbatim"
  },
  "instruction list": {
    "word": "list",
    "prog": "instruction list",
    "description": "This is how an instruction reaches a session: run it among your first commands\nand read the answer. The default output is computed from WHERE the pipeline\nstands -- global entries always, a cycle entry while its cycle is the current\none, a node entry while its node is the one in hand, and anything it cannot\njudge -- as plain sentences, with ids and bookkeeping folded away. `--json` is\nthe same answer for a machine (an empty array when there is nothing). `--all`,\n`--live` and `--scope` ask for the ACCOUNT instead: the raw rows, retired\nentries included when `--all` says so.",
    "positionals": [],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--json"
        ],
        "help": "",
        "invocation": "--json"
      },
      {
        "flags": [
          "--live"
        ],
        "help": "Account view: only the entries whose state is live",
        "invocation": "--live"
      },
      {
        "flags": [
          "--all"
        ],
        "help": "Account view: the whole account, retired entries included",
        "invocation": "--all"
      },
      {
        "flags": [
          "--scope"
        ],
        "metavar": "{global,cycle,node}",
        "choices": [
          "global",
          "cycle",
          "node"
        ],
        "help": "Account view narrowed to one scope. `--scope global` reads out the global entries",
        "invocation": "--scope {global,cycle,node}"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root. Default: the current directory. Pass it explicitly when your cwd may not be the project root -- the ledger root is resolved at import time, so a wrong cwd silently reads an empty account",
        "invocation": "--project PROJECT"
      },
      {
        "flags": [
          "--node"
        ],
        "metavar": "NODE",
        "help": "The DAG node you are working on: with two active cycles side by side it is how this read knows which line you stand on (`cycle` entries go to their own line only). Default: not asked",
        "invocation": "--node NODE"
      }
    ],
    "group": "instruction",
    "summary": "What the user asked for, as seen from where you stand (the instruction channel: nothing is injected into a prompt)"
  },
  "instruction resolve": {
    "word": "resolve",
    "prog": "instruction resolve",
    "description": null,
    "positionals": [
      {
        "name": "ins_id",
        "metavar": "ins_id",
        "required": true
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--state"
        ],
        "metavar": "{withdrawn}",
        "required": true,
        "choices": [
          "withdrawn"
        ],
        "help": "withdrawn = the entry is archived: it stays on the account and stops being read, and the archive writes the state and the moment, nothing else. It is the only move `resolve` has, and only the owner makes it -- a live entry is not marked with an outcome, and a cycle/node entry goes out of sight on its own when its node is completed or its cycle ends",
        "invocation": "--state {withdrawn}"
      },
      {
        "flags": [
          "--note"
        ],
        "metavar": "NOTE",
        "help": "",
        "invocation": "--note NOTE"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      }
    ],
    "group": "instruction",
    "summary": "Archive one instruction (only the owner puts it out of force)"
  },
  "instruction rm": {
    "word": "rm",
    "prog": "instruction rm",
    "description": "The owner takes an entry away: the sentence is printed first, then the entry\nand its text leave the account. What stays is the id and the moment -- the\ntrace the ledger merge holds the removal on, so a pull from a machine that\nstill has the entry does not bring it back, and so the id is never handed out\nagain. No view of the account shows a trace, and this is not a third state.\n`resolve` is the other move: an archived entry keeps its sentence and stops\nbeing read.",
    "positionals": [
      {
        "name": "ins_id",
        "metavar": "ins_id",
        "required": true
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      }
    ],
    "group": "instruction",
    "summary": "Take one instruction off the account, text and all (only the owner removes one)"
  },
  "instruction revive": {
    "word": "revive",
    "prog": "instruction revive",
    "description": "The owner undoes an archive: the entry goes back to `live`, and the moment the\narchive wrote is cleared back to the shape an added entry has, so the merged\nrecord stays one act. An entry that is already live is refused, and so is an\nid the account does not have: a removed entry is off the account for good, and\nputting one back is not how a removal is undone.",
    "positionals": [
      {
        "name": "ins_id",
        "metavar": "ins_id",
        "required": true
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      }
    ],
    "group": "instruction",
    "summary": "Put an archived instruction back in force (only the owner puts one back)"
  },
  "session show": {
    "word": "show",
    "prog": "session show",
    "description": null,
    "positionals": [
      {
        "name": "node",
        "metavar": "node",
        "required": true,
        "help": "Node id, or as much of its start as names one node"
      }
    ],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--json"
        ],
        "help": "Print raw JSON",
        "invocation": "--json"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      }
    ],
    "group": "session",
    "summary": "One node's note: its discussion, and the sessions that ran it"
  },
  "session list": {
    "word": "list",
    "prog": "session list",
    "description": null,
    "positionals": [],
    "options": [
      {
        "flags": [
          "-h",
          "--help"
        ],
        "help": "show this help message and exit",
        "invocation": "-h, --help"
      },
      {
        "flags": [
          "--json"
        ],
        "help": "Print raw JSON",
        "invocation": "--json"
      },
      {
        "flags": [
          "--project"
        ],
        "metavar": "PROJECT",
        "help": "Project root (default: current directory)",
        "invocation": "--project PROJECT"
      }
    ],
    "group": "session",
    "summary": "Every note this machine holds, keyed by node id"
  }
};

export const GROUPS = {
  "cycle": {
    "word": "cycle",
    "prog": "cycle",
    "description": "A cycle is one line of work: it picks ONE DAG node at a time, hands it to a session, and records the step when that session reports back. This group owns the line itself -- its identity, whether it is in service, its policies, and the path it has walked. Which nodes it holds is the `hold` word's business.",
    "metavar": "{create,start,rename,status,policy,list,current,show,close,retry}",
    "commands": [
      {
        "word": "create",
        "prog": "cycle create",
        "description": null,
        "positionals": [
          {
            "name": "id",
            "metavar": "id",
            "required": true
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--title"
            ],
            "metavar": "TITLE",
            "help": "Cycle title (auto-generated if omitted)",
            "invocation": "--title TITLE"
          },
          {
            "flags": [
              "--force"
            ],
            "help": "Create it while another cycle is still active",
            "invocation": "--force"
          },
          {
            "flags": [
              "--tags"
            ],
            "metavar": "TAGS",
            "help": "Comma-separated filter set for what this cycle picks from: writing / coding / art. Required -- a call without it is refused: an empty scope leaves this line nothing to pick from",
            "invocation": "--tags TAGS"
          }
        ],
        "group": "cycle",
        "summary": "Create a new cycle"
      },
      {
        "word": "start",
        "prog": "cycle start",
        "description": null,
        "positionals": [
          {
            "name": "id",
            "metavar": "id",
            "required": true
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--title"
            ],
            "metavar": "TITLE",
            "help": "The user's words, verbatim",
            "invocation": "--title TITLE"
          },
          {
            "flags": [
              "--tags"
            ],
            "metavar": "TAGS",
            "help": "Comma-separated filter set for this cycle: it decides which nodes the first pick and every later pick may take (writing / coding / art). Required -- a call without it is refused: an empty scope leaves this line nothing to pick from",
            "invocation": "--tags TAGS"
          },
          {
            "flags": [
              "--parallel"
            ],
            "metavar": "PARALLEL",
            "help": "How many nodes this line holds and runs at once: pin that many of the ready set right here, and write it down as the line's `parallel` policy (same slot `cycle policy <id> parallel <n>` writes). A positive integer, or `off` for the default 1",
            "invocation": "--parallel PARALLEL"
          },
          {
            "flags": [
              "--force"
            ],
            "help": "Start anyway while another cycle is active (a bare `next` will then have to be told which cycle)",
            "invocation": "--force"
          }
        ],
        "group": "cycle",
        "summary": "Create a cycle AND pin it on the node the rule picks (one command for the launcher). Refuses on an empty graph, and refuses while another cycle is still active unless --force"
      },
      {
        "word": "rename",
        "prog": "cycle rename",
        "description": null,
        "positionals": [
          {
            "name": "id",
            "metavar": "id",
            "required": true
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--title"
            ],
            "metavar": "TITLE",
            "required": true,
            "help": "New title",
            "invocation": "--title TITLE"
          }
        ],
        "group": "cycle",
        "summary": "Rename an existing cycle"
      },
      {
        "word": "status",
        "prog": "cycle status",
        "description": null,
        "positionals": [
          {
            "name": "id",
            "metavar": "id",
            "required": true
          },
          {
            "name": "{active,inactive}",
            "metavar": "{active,inactive}",
            "required": true,
            "help": "",
            "choices": [
              "active",
              "inactive"
            ]
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          }
        ],
        "group": "cycle",
        "summary": "Put the line in or out of service: active | inactive"
      },
      {
        "word": "policy",
        "prog": "cycle policy",
        "description": null,
        "positionals": [
          {
            "name": "id",
            "metavar": "id",
            "required": true
          },
          {
            "name": "{issue_pool,issue_pool_weight_limit,model,parallel,test_audit,test_seconds_limit,when_shelved}",
            "metavar": "{issue_pool,issue_pool_weight_limit,model,parallel,test_audit,test_seconds_limit,when_shelved}",
            "required": true,
            "help": "",
            "choices": [
              "issue_pool",
              "issue_pool_weight_limit",
              "model",
              "parallel",
              "test_audit",
              "test_seconds_limit",
              "when_shelved"
            ]
          },
          {
            "name": "value",
            "metavar": "value",
            "required": true,
            "help": "The value, in the key's own kind -- when_shelved: stop | continue -- what this line does when a node comes back not delivered: stop and wait for a human, or mark it shelved and carry on (default: stop); parallel: a positive integer -- how many nodes this line holds and how many sessions it opens at once (a cap: whether they can run side by side is the graph's call) (default: 1); issue_pool_weight_limit: a positive number -- the issue pool's weighted sum the next close must read below; test_seconds_limit: a positive number -- the project test suite's full wall clock (seconds) the next close must read below; model: a route word -- which model the sessions this line opens use (`provider/model`, carried whole to the opener; a call's own --model wins over it). Every knob a plugin declares rides on this line too. A core setting does not: it takes the project and global layers only, and `config set` is its door. `off` drops this line's entry for a number / integer / word, so the next layer of the chain shows through; on a switch it is a value -- a switch is turned off by writing `off`, and dropping its entry is `config unset --cycle`. Numbers and integers take a positive value only: a line of 0 fails every reading"
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          }
        ],
        "group": "cycle",
        "summary": "Write one policy on this line's own record (the effective set is echoed back; a core setting is `config set`'s, not this line's)"
      },
      {
        "word": "list",
        "prog": "cycle list",
        "description": null,
        "positionals": [],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          }
        ],
        "group": "cycle",
        "summary": "Show all cycles (state.json)"
      },
      {
        "word": "current",
        "prog": "cycle current",
        "description": null,
        "positionals": [],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          }
        ],
        "group": "cycle",
        "summary": "Show the active cycle and the node it holds"
      },
      {
        "word": "show",
        "prog": "cycle show",
        "description": null,
        "positionals": [
          {
            "name": "id",
            "metavar": "id",
            "required": true
          },
          {
            "name": "node",
            "metavar": "node",
            "required": true
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          }
        ],
        "group": "cycle",
        "summary": "One node's standing in a cycle: signal + path step"
      },
      {
        "word": "close",
        "prog": "cycle close",
        "description": null,
        "positionals": [
          {
            "name": "id",
            "metavar": "id",
            "required": true
          },
          {
            "name": "node",
            "metavar": "node",
            "required": true
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--result"
            ],
            "metavar": "{completed,failed,stopped}",
            "required": true,
            "choices": [
              "completed",
              "failed",
              "stopped"
            ],
            "help": "completed | failed | stopped (what the worker reported)",
            "invocation": "--result {completed,failed,stopped}"
          }
        ],
        "group": "cycle",
        "summary": "Record the step on the cycle's path and let the node go"
      },
      {
        "word": "retry",
        "prog": "cycle retry",
        "description": null,
        "positionals": [
          {
            "name": "id",
            "metavar": "id",
            "required": true
          },
          {
            "name": "node",
            "metavar": "node",
            "required": true
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--summary"
            ],
            "metavar": "SUMMARY",
            "help": "Why the node was restarted",
            "invocation": "--summary SUMMARY"
          },
          {
            "flags": [
              "--drop"
            ],
            "help": "Leave no ticket at all. A `pending` ticket is a red light: `next` waits on it forever, so dropping it is what lets the retry be dispatched",
            "invocation": "--drop"
          }
        ],
        "group": "cycle",
        "summary": "Take a node signal out of the way (retries): rewrite it as pending, or --drop to leave no ticket at all"
      }
    ]
  },
  "dag": {
    "word": "dag",
    "prog": "dag",
    "description": "Manage a dependency graph (DAG) of project ideas/plugins.",
    "metavar": "<command>",
    "commands": [
      {
        "word": "add",
        "prog": "dag add",
        "description": null,
        "positionals": [
          {
            "name": "title",
            "metavar": "title",
            "required": false,
            "help": "Node title"
          },
          {
            "name": "description",
            "metavar": "description",
            "required": false,
            "help": "Description text (positional, space-separated)",
            "nargs": "*"
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--desc"
            ],
            "metavar": "DESC",
            "help": "Description text (flag, alternative to positional)",
            "invocation": "--desc DESC"
          },
          {
            "flags": [
              "--depends-on"
            ],
            "metavar": "DEPENDS_ON",
            "help": "Comma-separated dependency UUIDs",
            "invocation": "--depends-on DEPENDS_ON"
          },
          {
            "flags": [
              "--mode"
            ],
            "metavar": "{manual,auto,checkpoint}",
            "choices": [
              "manual",
              "auto",
              "checkpoint"
            ],
            "help": "Node execution mode: manual/checkpoint/auto (default: auto). manual = a discussion node, no execute-review- fix loop; checkpoint = the loop runs, then stops for your go-ahead; auto = the loop runs and the line carries on by itself",
            "invocation": "--mode {manual,auto,checkpoint}"
          },
          {
            "flags": [
              "--weight"
            ],
            "metavar": "{light,standard}",
            "choices": [
              "light",
              "standard"
            ],
            "help": "Node weight: light/standard (default: standard; the key is written only for light). light = the conductor implements it itself and dispatches review alone; standard = it dispatches Execute as usual",
            "invocation": "--weight {light,standard}"
          },
          {
            "flags": [
              "--tags"
            ],
            "metavar": "TAGS",
            "help": "Comma-separated tags: writing / coding / art. Untagged = never filtered",
            "invocation": "--tags TAGS"
          },
          {
            "flags": [
              "--from-file"
            ],
            "metavar": "FILE",
            "help": "Register a batch from a JSON file instead of a title: one node per row. A row may carry a `ref` that this batch's own `depends_on` can name; the whole batch is one graph write, and any bad row, unknown dependency or cycle refuses all of it",
            "invocation": "--from-file FILE"
          }
        ],
        "group": "dag",
        "summary": "Add a new idea node"
      },
      {
        "word": "rm",
        "prog": "dag rm",
        "description": null,
        "positionals": [
          {
            "name": "uuid",
            "metavar": "uuid",
            "required": true,
            "help": "Node UUID"
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--force"
            ],
            "help": "Force removal even if depended on",
            "invocation": "--force"
          }
        ],
        "group": "dag",
        "summary": "Remove an idea node"
      },
      {
        "word": "update",
        "prog": "dag update",
        "description": null,
        "positionals": [
          {
            "name": "uuid",
            "metavar": "uuid",
            "required": true,
            "help": "Node UUID"
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--title"
            ],
            "metavar": "TITLE",
            "help": "New title",
            "invocation": "--title TITLE"
          },
          {
            "flags": [
              "--desc"
            ],
            "metavar": "DESC",
            "help": "New description",
            "invocation": "--desc DESC"
          },
          {
            "flags": [
              "--mode"
            ],
            "metavar": "{auto,checkpoint,manual}",
            "choices": [
              "auto",
              "checkpoint",
              "manual"
            ],
            "help": "New execution mode: manual/checkpoint/auto",
            "invocation": "--mode {auto,checkpoint,manual}"
          },
          {
            "flags": [
              "--weight"
            ],
            "metavar": "{light,standard}",
            "choices": [
              "light",
              "standard"
            ],
            "help": "New weight: light/standard (standard drops the key)",
            "invocation": "--weight {light,standard}"
          },
          {
            "flags": [
              "--tags"
            ],
            "metavar": "TAGS",
            "help": "New tag set, comma-separated (replaces what the node carries)",
            "invocation": "--tags TAGS"
          },
          {
            "flags": [
              "--clear-tags"
            ],
            "help": "Drop every tag: the node becomes visible to all filter sets again",
            "invocation": "--clear-tags"
          }
        ],
        "group": "dag",
        "summary": "Update title and/or description"
      },
      {
        "word": "depend",
        "prog": "dag depend",
        "description": null,
        "positionals": [
          {
            "name": "uuid",
            "metavar": "uuid",
            "required": true,
            "help": "Node UUID that depends on --on"
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--on"
            ],
            "metavar": "ON",
            "required": true,
            "help": "Comma-separated dependency ids: `--on a,b,c` (one batch, one write)",
            "invocation": "--on ON"
          }
        ],
        "group": "dag",
        "summary": "Add a dependency edge"
      },
      {
        "word": "undepend",
        "prog": "dag undepend",
        "description": null,
        "positionals": [
          {
            "name": "uuid",
            "metavar": "uuid",
            "required": true,
            "help": "Node UUID"
          },
          {
            "name": "dep",
            "metavar": "dep",
            "required": false,
            "help": "Dependency UUID to remove (positional)"
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--from"
            ],
            "metavar": "FROM_",
            "help": "Dependency UUID to remove (flag, alternative to positional)",
            "invocation": "--from FROM_"
          }
        ],
        "group": "dag",
        "summary": "Remove a dependency edge"
      },
      {
        "word": "status",
        "prog": "dag status",
        "description": null,
        "positionals": [
          {
            "name": "uuid",
            "metavar": "uuid",
            "required": true,
            "help": "Node UUID"
          },
          {
            "name": "{todo,shelved,completed}",
            "metavar": "{todo,shelved,completed}",
            "required": true,
            "help": "New status: todo | shelved | completed. todo = in play, not delivered (a node a cycle is working on is still todo); shelved = out of play, waiting for a human (never ready, never recommended; release with status <uuid> todo); completed = delivered",
            "choices": [
              "todo",
              "shelved",
              "completed"
            ]
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          }
        ],
        "group": "dag",
        "summary": "Set node status"
      },
      {
        "word": "approve",
        "prog": "dag approve",
        "description": null,
        "positionals": [
          {
            "name": "uuid",
            "metavar": "uuid",
            "required": true,
            "help": "Node UUID"
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--at"
            ],
            "metavar": "AT",
            "help": "The moment of the approval (default: now). Written as given, in the record timestamp shape: 2026-10-16T15:13:44.160813Z",
            "invocation": "--at AT"
          }
        ],
        "group": "dag",
        "summary": "Record that a human approved one node's delivery"
      },
      {
        "word": "revive",
        "prog": "dag revive",
        "description": null,
        "positionals": [
          {
            "name": "uuid",
            "metavar": "uuid",
            "required": true,
            "help": "Node UUID"
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          }
        ],
        "group": "dag",
        "summary": "Put a shelved node back to todo so it can run again"
      },
      {
        "word": "list",
        "prog": "dag list",
        "description": null,
        "positionals": [],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--ready"
            ],
            "help": "Only show ready nodes (todo, with every dependency completed)",
            "invocation": "--ready"
          },
          {
            "flags": [
              "--status"
            ],
            "metavar": "{todo,shelved,completed}",
            "nargs": "*",
            "choices": [
              "todo",
              "shelved",
              "completed"
            ],
            "help": "Filter by status(es): --status todo shelved completed",
            "invocation": "--status {todo,shelved,completed} [{todo,shelved,completed} ...]"
          },
          {
            "flags": [
              "--verbose",
              "-v"
            ],
            "help": "Show dependencies and dependents",
            "invocation": "--verbose, -v"
          },
          {
            "flags": [
              "--limit",
              "-n"
            ],
            "metavar": "LIMIT",
            "help": "Max items to output (0 = unlimited)",
            "invocation": "--limit, -n LIMIT"
          },
          {
            "flags": [
              "--tags"
            ],
            "metavar": "TAGS",
            "help": "Show only what a filter set like this would pick from: comma-separated tags. An untagged node always stays in view",
            "invocation": "--tags TAGS"
          }
        ],
        "group": "dag",
        "summary": "List nodes sorted by urgency × importance"
      },
      {
        "word": "info",
        "prog": "dag info",
        "description": null,
        "positionals": [
          {
            "name": "uuid",
            "metavar": "uuid",
            "required": true,
            "help": "Node UUID"
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--verbose"
            ],
            "help": "Extended fields",
            "invocation": "--verbose"
          }
        ],
        "group": "dag",
        "summary": "Show node details"
      },
      {
        "word": "context",
        "prog": "dag context",
        "description": null,
        "positionals": [
          {
            "name": "uuid",
            "metavar": "uuid",
            "required": true,
            "help": "Node UUID"
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          }
        ],
        "group": "dag",
        "summary": "Show full upstream/downstream context of a node"
      },
      {
        "word": "search",
        "prog": "dag search",
        "description": null,
        "positionals": [
          {
            "name": "query",
            "metavar": "query",
            "required": true,
            "help": "Regex pattern (case-insensitive). Always quote: search 'IYL|loading'"
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--limit",
              "-n"
            ],
            "metavar": "LIMIT",
            "help": "Max results (0 = unlimited)",
            "invocation": "--limit, -n LIMIT"
          },
          {
            "flags": [
              "--active-only"
            ],
            "help": "Exclude completed nodes from results",
            "invocation": "--active-only"
          }
        ],
        "group": "dag",
        "summary": "Search nodes by title/description using regex"
      },
      {
        "word": "open",
        "prog": "dag open",
        "description": null,
        "positionals": [
          {
            "name": "uuid",
            "metavar": "uuid",
            "required": true,
            "help": "Node UUID"
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          }
        ],
        "group": "dag",
        "summary": "Print absolute spec.md path"
      },
      {
        "word": "validate",
        "prog": "dag validate",
        "description": null,
        "positionals": [],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          }
        ],
        "group": "dag",
        "summary": "Validate graph integrity"
      },
      {
        "word": "help",
        "prog": "dag help",
        "description": null,
        "positionals": [],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          }
        ],
        "group": "dag",
        "summary": "Show the full usage reference"
      }
    ]
  },
  "config": {
    "word": "config",
    "prog": "config",
    "description": "Every setting is a knob with a kind, and one chain: this node -> this line -> this project -> this machine -> factory default. Narrower layers cover wider ones, and the same name may be stated on several layers at once: the resolution is deterministic, and `list` / `get` always say which layer the value in force came from. The table is the built-in settings plus every knob the installed plugins declare -- `list` prints it, and a name nobody declares is refused. Not every knob takes every layer: a core setting takes the project and global layers, a plugin's knob takes all four (`set` names the layers a knob takes when it refuses one). The line's own policies -- `parallel`, `when_shelved`, `model` -- are not settings and are not here: they live on the line record, written by `cycle policy`. The two file layers are `~/.pf/config.json` (global: travels with the person and the machine, never generated for you) and `<project>/.pf/config.json` (travels with the project; `init` puts an empty `{}` there); the two narrow ones ride on the cycle record and on one node's own `config.json`. `set` stores a value and `unset` drops that one layer's entry -- a switch is turned off by setting `off`, while dropping its entry is `unset` (the same split `cycle policy` explains). `set` / `unset` write exactly one layer: the project layer unless --global / --cycle / --node says otherwise.",
    "metavar": "{list,get,set,unset}",
    "commands": [
      {
        "word": "list",
        "prog": "config list",
        "description": null,
        "positionals": [],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--project"
            ],
            "metavar": "PROJECT",
            "help": "Project root (default: current directory)",
            "invocation": "--project PROJECT"
          },
          {
            "flags": [
              "--cycle"
            ],
            "metavar": "CYCLE",
            "help": "Read this line's layer too (a cycle id): what that line sees",
            "invocation": "--cycle CYCLE"
          },
          {
            "flags": [
              "--node"
            ],
            "metavar": "NODE",
            "help": "Read this node's layer too (a node id): what that node's run sees",
            "invocation": "--node NODE"
          }
        ],
        "group": "config",
        "summary": "Every knob's effective value, and the layer it came from"
      },
      {
        "word": "get",
        "prog": "config get",
        "description": null,
        "positionals": [
          {
            "name": "{issue_pool,issue_pool_weight_limit,max_agents,test_audit,test_seconds_limit,test_tier,worktree_mode}",
            "metavar": "{issue_pool,issue_pool_weight_limit,max_agents,test_audit,test_seconds_limit,test_tier,worktree_mode}",
            "required": true,
            "help": "",
            "choices": [
              "issue_pool",
              "issue_pool_weight_limit",
              "max_agents",
              "test_audit",
              "test_seconds_limit",
              "test_tier",
              "worktree_mode"
            ]
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--project"
            ],
            "metavar": "PROJECT",
            "help": "Project root (default: current directory)",
            "invocation": "--project PROJECT"
          },
          {
            "flags": [
              "--cycle"
            ],
            "metavar": "CYCLE",
            "help": "Read this line's layer too (a cycle id)",
            "invocation": "--cycle CYCLE"
          },
          {
            "flags": [
              "--node"
            ],
            "metavar": "NODE",
            "help": "Read this node's layer too (a node id)",
            "invocation": "--node NODE"
          }
        ],
        "group": "config",
        "summary": "Print one effective value, and nothing else"
      },
      {
        "word": "set",
        "prog": "config set",
        "description": null,
        "positionals": [
          {
            "name": "{issue_pool,issue_pool_weight_limit,max_agents,test_audit,test_seconds_limit,test_tier,worktree_mode}",
            "metavar": "{issue_pool,issue_pool_weight_limit,max_agents,test_audit,test_seconds_limit,test_tier,worktree_mode}",
            "required": true,
            "help": "",
            "choices": [
              "issue_pool",
              "issue_pool_weight_limit",
              "max_agents",
              "test_audit",
              "test_seconds_limit",
              "test_tier",
              "worktree_mode"
            ]
          },
          {
            "name": "value",
            "metavar": "value",
            "required": true
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--global"
            ],
            "help": "Write the global layer (~/.pf/config.json) instead of the project one",
            "invocation": "--global"
          },
          {
            "flags": [
              "--cycle"
            ],
            "metavar": "CYCLE",
            "help": "Write this line's layer instead (a cycle id): the value rides on the cycle record, whose one writer takes it",
            "invocation": "--cycle CYCLE"
          },
          {
            "flags": [
              "--node"
            ],
            "metavar": "NODE",
            "help": "Write this node's layer instead (a node id): `.pf/nodes/<id>/config.json`",
            "invocation": "--node NODE"
          },
          {
            "flags": [
              "--project"
            ],
            "metavar": "PROJECT",
            "help": "Project root (default: current directory)",
            "invocation": "--project PROJECT"
          }
        ],
        "exclusive": [
          [
            "--global",
            "--cycle",
            "--node"
          ]
        ],
        "group": "config",
        "summary": "Write one value into exactly one layer (the project layer by default)"
      },
      {
        "word": "unset",
        "prog": "config unset",
        "description": null,
        "positionals": [
          {
            "name": "{issue_pool,issue_pool_weight_limit,max_agents,test_audit,test_seconds_limit,test_tier,worktree_mode}",
            "metavar": "{issue_pool,issue_pool_weight_limit,max_agents,test_audit,test_seconds_limit,test_tier,worktree_mode}",
            "required": true,
            "help": "",
            "choices": [
              "issue_pool",
              "issue_pool_weight_limit",
              "max_agents",
              "test_audit",
              "test_seconds_limit",
              "test_tier",
              "worktree_mode"
            ]
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--global"
            ],
            "help": "Drop it from the global layer instead of the project one",
            "invocation": "--global"
          },
          {
            "flags": [
              "--cycle"
            ],
            "metavar": "CYCLE",
            "help": "Drop it from this line's layer instead (a cycle id)",
            "invocation": "--cycle CYCLE"
          },
          {
            "flags": [
              "--node"
            ],
            "metavar": "NODE",
            "help": "Drop it from this node's layer instead (a node id)",
            "invocation": "--node NODE"
          },
          {
            "flags": [
              "--project"
            ],
            "metavar": "PROJECT",
            "help": "Project root (default: current directory)",
            "invocation": "--project PROJECT"
          }
        ],
        "exclusive": [
          [
            "--global",
            "--cycle",
            "--node"
          ]
        ],
        "group": "config",
        "summary": "Drop one override, letting the next wider layer take over again"
      }
    ]
  },
  "instruction": {
    "word": "instruction",
    "prog": "instruction",
    "description": "Three scopes. Whether an entry can be read is decided by WHERE it was\nrecorded, not by anyone remembering to resolve it: global = readable anywhere,\nby every session and in every cycle; cycle = readable while the cycle it was\nrecorded in is active, and unreadable once that cycle ends; node = readable\nwhile the node it was recorded in is unfinished. `add` binds the cycle/node\nfrom the state, or takes the binding from `--cycle` / `--node` when the state\ncannot name one (two active cycles side by side); a cycle/node entry with\nnothing to bind to is refused, because an unbound entry is read as visible\neverywhere and never goes out of sight. Nothing is injected into a dispatch\nprompt: `list` is how a session reads the account, and running it among its\nfirst commands is what makes an instruction reach it. The account has two\nstates -- in force and archived -- and only the owner moves an entry off it:\n`resolve` archives one (the sentence stays on the account and stops being\nread), `rm` takes one away text and all, and `revive` puts an archived one\nback. An entry whose scope has run out goes out of sight on its own, with\nnothing to write.",
    "metavar": "{add,list,resolve,rm,revive}",
    "commands": [
      {
        "word": "add",
        "prog": "instruction add",
        "description": null,
        "positionals": [],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--text"
            ],
            "metavar": "TEXT",
            "required": true,
            "help": "The sentence, EXACTLY as the user said it",
            "invocation": "--text TEXT"
          },
          {
            "flags": [
              "--scope"
            ],
            "metavar": "{global,cycle,node}",
            "choices": [
              "global",
              "cycle",
              "node"
            ],
            "help": "Where this instruction is visible from (`instruction --help`): global = everywhere; cycle = the cycle it is recorded in, out of sight once that cycle ends; node = the node it is recorded in, out of sight once that node is completed. The cycle/node it binds to come from the state, or from --cycle / --node when the state cannot name one; a cycle/node entry that nothing binds is refused. (default: global -- the noisy side of a coin flip is the safe one)",
            "invocation": "--scope {global,cycle,node}"
          },
          {
            "flags": [
              "--cycle"
            ],
            "metavar": "CYCLE",
            "help": "The line this entry belongs to. Needed while two active cycles run side by side, where the state has no single current one; a cycle-scoped entry with nothing to bind to is refused (it would be read as visible everywhere, forever). Default: the single active cycle",
            "invocation": "--cycle CYCLE"
          },
          {
            "flags": [
              "--node"
            ],
            "metavar": "NODE",
            "help": "The node this entry belongs to, for --scope node. Default: the node the cycle is holding",
            "invocation": "--node NODE"
          },
          {
            "flags": [
              "--target"
            ],
            "metavar": "{stage,boundary}",
            "choices": [
              "stage",
              "boundary"
            ],
            "help": "stage = a constraint every worker must see; boundary = rhythm, read only when a node closes (default: stage)",
            "invocation": "--target {stage,boundary}"
          },
          {
            "flags": [
              "--said-by"
            ],
            "metavar": "SAID_BY",
            "help": "",
            "invocation": "--said-by SAID_BY"
          },
          {
            "flags": [
              "--note"
            ],
            "metavar": "NOTE",
            "help": "",
            "invocation": "--note NOTE"
          },
          {
            "flags": [
              "--stop-after-nodes"
            ],
            "metavar": "STOP_AFTER_NODES",
            "help": "Optional machine-checkable cap: stop once this many nodes have run",
            "invocation": "--stop-after-nodes STOP_AFTER_NODES"
          }
        ],
        "group": "instruction",
        "summary": "Append one instruction, verbatim"
      },
      {
        "word": "list",
        "prog": "instruction list",
        "description": "This is how an instruction reaches a session: run it among your first commands\nand read the answer. The default output is computed from WHERE the pipeline\nstands -- global entries always, a cycle entry while its cycle is the current\none, a node entry while its node is the one in hand, and anything it cannot\njudge -- as plain sentences, with ids and bookkeeping folded away. `--json` is\nthe same answer for a machine (an empty array when there is nothing). `--all`,\n`--live` and `--scope` ask for the ACCOUNT instead: the raw rows, retired\nentries included when `--all` says so.",
        "positionals": [],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--json"
            ],
            "help": "",
            "invocation": "--json"
          },
          {
            "flags": [
              "--live"
            ],
            "help": "Account view: only the entries whose state is live",
            "invocation": "--live"
          },
          {
            "flags": [
              "--all"
            ],
            "help": "Account view: the whole account, retired entries included",
            "invocation": "--all"
          },
          {
            "flags": [
              "--scope"
            ],
            "metavar": "{global,cycle,node}",
            "choices": [
              "global",
              "cycle",
              "node"
            ],
            "help": "Account view narrowed to one scope. `--scope global` reads out the global entries",
            "invocation": "--scope {global,cycle,node}"
          },
          {
            "flags": [
              "--project"
            ],
            "metavar": "PROJECT",
            "help": "Project root. Default: the current directory. Pass it explicitly when your cwd may not be the project root -- the ledger root is resolved at import time, so a wrong cwd silently reads an empty account",
            "invocation": "--project PROJECT"
          },
          {
            "flags": [
              "--node"
            ],
            "metavar": "NODE",
            "help": "The DAG node you are working on: with two active cycles side by side it is how this read knows which line you stand on (`cycle` entries go to their own line only). Default: not asked",
            "invocation": "--node NODE"
          }
        ],
        "group": "instruction",
        "summary": "What the user asked for, as seen from where you stand (the instruction channel: nothing is injected into a prompt)"
      },
      {
        "word": "resolve",
        "prog": "instruction resolve",
        "description": null,
        "positionals": [
          {
            "name": "ins_id",
            "metavar": "ins_id",
            "required": true
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--state"
            ],
            "metavar": "{withdrawn}",
            "required": true,
            "choices": [
              "withdrawn"
            ],
            "help": "withdrawn = the entry is archived: it stays on the account and stops being read, and the archive writes the state and the moment, nothing else. It is the only move `resolve` has, and only the owner makes it -- a live entry is not marked with an outcome, and a cycle/node entry goes out of sight on its own when its node is completed or its cycle ends",
            "invocation": "--state {withdrawn}"
          },
          {
            "flags": [
              "--note"
            ],
            "metavar": "NOTE",
            "help": "",
            "invocation": "--note NOTE"
          },
          {
            "flags": [
              "--project"
            ],
            "metavar": "PROJECT",
            "help": "Project root (default: current directory)",
            "invocation": "--project PROJECT"
          }
        ],
        "group": "instruction",
        "summary": "Archive one instruction (only the owner puts it out of force)"
      },
      {
        "word": "rm",
        "prog": "instruction rm",
        "description": "The owner takes an entry away: the sentence is printed first, then the entry\nand its text leave the account. What stays is the id and the moment -- the\ntrace the ledger merge holds the removal on, so a pull from a machine that\nstill has the entry does not bring it back, and so the id is never handed out\nagain. No view of the account shows a trace, and this is not a third state.\n`resolve` is the other move: an archived entry keeps its sentence and stops\nbeing read.",
        "positionals": [
          {
            "name": "ins_id",
            "metavar": "ins_id",
            "required": true
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--project"
            ],
            "metavar": "PROJECT",
            "help": "Project root (default: current directory)",
            "invocation": "--project PROJECT"
          }
        ],
        "group": "instruction",
        "summary": "Take one instruction off the account, text and all (only the owner removes one)"
      },
      {
        "word": "revive",
        "prog": "instruction revive",
        "description": "The owner undoes an archive: the entry goes back to `live`, and the moment the\narchive wrote is cleared back to the shape an added entry has, so the merged\nrecord stays one act. An entry that is already live is refused, and so is an\nid the account does not have: a removed entry is off the account for good, and\nputting one back is not how a removal is undone.",
        "positionals": [
          {
            "name": "ins_id",
            "metavar": "ins_id",
            "required": true
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--project"
            ],
            "metavar": "PROJECT",
            "help": "Project root (default: current directory)",
            "invocation": "--project PROJECT"
          }
        ],
        "group": "instruction",
        "summary": "Put an archived instruction back in force (only the owner puts one back)"
      }
    ]
  },
  "session": {
    "word": "session",
    "prog": "session",
    "description": "A session id is machine-local -- a conversation lives on the machine that opened it -- so the ids live in `.pf/meta/sessions/<node id>.json` instead of on the record: guaranteed dead on another machine, and impossible to tell apart from \"that session was deleted here\". `show` reads one node's note, `list` reads every note this machine holds (keyed by node id, for a panel), and `import` folds the older `dsh_session` field into notes once per machine -- writing notes and nothing else.",
    "metavar": "{show,list}",
    "commands": [
      {
        "word": "show",
        "prog": "session show",
        "description": null,
        "positionals": [
          {
            "name": "node",
            "metavar": "node",
            "required": true,
            "help": "Node id, or as much of its start as names one node"
          }
        ],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--json"
            ],
            "help": "Print raw JSON",
            "invocation": "--json"
          },
          {
            "flags": [
              "--project"
            ],
            "metavar": "PROJECT",
            "help": "Project root (default: current directory)",
            "invocation": "--project PROJECT"
          }
        ],
        "group": "session",
        "summary": "One node's note: its discussion, and the sessions that ran it"
      },
      {
        "word": "list",
        "prog": "session list",
        "description": null,
        "positionals": [],
        "options": [
          {
            "flags": [
              "-h",
              "--help"
            ],
            "help": "show this help message and exit",
            "invocation": "-h, --help"
          },
          {
            "flags": [
              "--json"
            ],
            "help": "Print raw JSON",
            "invocation": "--json"
          },
          {
            "flags": [
              "--project"
            ],
            "metavar": "PROJECT",
            "help": "Project root (default: current directory)",
            "invocation": "--project PROJECT"
          }
        ],
        "group": "session",
        "summary": "Every note this machine holds, keyed by node id"
      }
    ]
  }
};

// The rows as the readers type them: the data above stays verbatim, and these are the two tables
// every reader walks (a leaf's row, a group's row with its verbs).
const commandRows = COMMANDS as unknown as Record<string, WordRow>;
const groupRows = GROUPS as unknown as Record<string, WordRow>;
const tableTop = TOP as TableTop;
export { commandRows as COMMAND_ROWS, groupRows as GROUP_ROWS, tableTop as TABLE_TOP };
