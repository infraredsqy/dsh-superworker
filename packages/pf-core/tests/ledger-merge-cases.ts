/**
 * Byte-for-byte replay case data: each side and the merged result are the raw bytes fixed in
 * that round. Records are written with LF on every platform, so the text here is the record text
 * exactly, and the test side compares byte for byte.
 *
 * The data was collected by running `git merge` in a temp git repo: the three sides are laid into
 * one repo, the merge runs once, and the output is copied down. Test time starts no process and
 * reads nothing from outside the repo.
 */

/** The kind of a record; `null` means the file cannot be recognised, and the driver should refuse to take it. */
export type LedgerMergeKind = 'ideas' | 'state' | 'instructions' | 'signal';

export interface LedgerMergeCase {
  readonly name: string;
  readonly kind: LedgerMergeKind | null;
  /** git's %P: where this record lives in the repo. */
  readonly path: string;
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
  /** The exit code the driver should hand back. */
  readonly expectCode: number;
  /** The merged record text (LF spelling); null in the refusal and conflict cases, where not a byte should move. */
  readonly expectMerged: string | null;
}

export const LEDGER_MERGE_CASES: readonly LedgerMergeCase[] = [
  {
    name: "ideas-field-merge",
    kind: "ideas",
    path: ".pf/ideas.json",
    base: "{\n  \"nodes\": {\n    \"aaaaaaaa-1111-4111-8111-111111111111\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"original description\",\n      \"mode\": \"auto\",\n      \"status\": \"todo\",\n      \"title\": \"original title\",\n      \"updated_at\": \"2026-02-01T00:00:00.000000Z\"\n    },\n    \"bbbbbbbb-2222-4222-8222-222222222222\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"B description\",\n      \"mode\": \"auto\",\n      \"status\": \"todo\",\n      \"title\": \"second node\",\n      \"updated_at\": \"2026-02-01T00:00:00.000000Z\"\n    }\n  }\n}",
    ours: "{\n  \"nodes\": {\n    \"aaaaaaaa-1111-4111-8111-111111111111\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"original description\",\n      \"mode\": \"auto\",\n      \"status\": \"shelved\",\n      \"title\": \"title changed on the A side\",\n      \"updated_at\": \"2026-02-01T01:00:00.000000Z\"\n    },\n    \"bbbbbbbb-2222-4222-8222-222222222222\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"B description\",\n      \"mode\": \"auto\",\n      \"status\": \"todo\",\n      \"title\": \"second node\",\n      \"updated_at\": \"2026-02-01T00:00:00.000000Z\"\n    }\n  }\n}",
    theirs: "{\n  \"nodes\": {\n    \"aaaaaaaa-1111-4111-8111-111111111111\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [\n        \"bbbbbbbb-2222-4222-8222-222222222222\"\n      ],\n      \"description\": \"description changed on the B side\",\n      \"mode\": \"auto\",\n      \"status\": \"todo\",\n      \"title\": \"original title\",\n      \"updated_at\": \"2026-02-01T02:00:00.000000Z\"\n    },\n    \"bbbbbbbb-2222-4222-8222-222222222222\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"B description\",\n      \"mode\": \"auto\",\n      \"status\": \"completed\",\n      \"title\": \"second node\",\n      \"updated_at\": \"2026-02-01T02:00:00.000000Z\"\n    }\n  }\n}",
    expectCode: 0,
    expectMerged: "{\n  \"nodes\": {\n    \"aaaaaaaa-1111-4111-8111-111111111111\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [\n        \"bbbbbbbb-2222-4222-8222-222222222222\"\n      ],\n      \"description\": \"description changed on the B side\",\n      \"mode\": \"auto\",\n      \"status\": \"shelved\",\n      \"title\": \"title changed on the A side\",\n      \"updated_at\": \"2026-02-01T02:00:00.000000Z\"\n    },\n    \"bbbbbbbb-2222-4222-8222-222222222222\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"B description\",\n      \"mode\": \"auto\",\n      \"status\": \"completed\",\n      \"title\": \"second node\",\n      \"updated_at\": \"2026-02-01T02:00:00.000000Z\"\n    }\n  }\n}",
  },
  {
    name: "ideas-rules-stack",
    kind: "ideas",
    path: ".pf/ideas.json",
    base: "{\n  \"nodes\": {\n    \"aaaaaaaa-1111-4111-8111-111111111111\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"original description\",\n      \"mode\": \"auto\",\n      \"status\": \"todo\",\n      \"title\": \"original title\",\n      \"updated_at\": \"2026-02-01T00:00:00.000000Z\"\n    },\n    \"bbbbbbbb-2222-4222-8222-222222222222\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"B description\",\n      \"mode\": \"auto\",\n      \"status\": \"todo\",\n      \"title\": \"B node\",\n      \"updated_at\": \"2026-02-01T00:00:00.000000Z\"\n    },\n    \"cccccccc-3333-4333-8333-333333333333\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"C description\",\n      \"mode\": \"auto\",\n      \"status\": \"todo\",\n      \"title\": \"C node\",\n      \"updated_at\": \"2026-02-01T00:00:00.000000Z\"\n    }\n  }\n}",
    ours: "{\n  \"nodes\": {\n    \"aaaaaaaa-1111-4111-8111-111111111111\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [\n        \"bbbbbbbb-2222-4222-8222-222222222222\"\n      ],\n      \"description\": \"original description\",\n      \"mode\": \"auto\",\n      \"status\": \"shelved\",\n      \"title\": \"A-side title\",\n      \"updated_at\": \"2026-02-01T01:00:00.000000Z\"\n    },\n    \"bbbbbbbb-2222-4222-8222-222222222222\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"B description\",\n      \"mode\": \"auto\",\n      \"status\": \"todo\",\n      \"title\": \"B node\",\n      \"updated_at\": \"2026-02-01T00:00:00.000000Z\"\n    },\n    \"cccccccc-3333-4333-8333-333333333333\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"C description\",\n      \"mode\": \"auto\",\n      \"status\": \"todo\",\n      \"title\": \"C node\",\n      \"updated_at\": \"2026-02-01T00:00:00.000000Z\"\n    }\n  }\n}",
    theirs: "{\n  \"nodes\": {\n    \"aaaaaaaa-1111-4111-8111-111111111111\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [\n        \"cccccccc-3333-4333-8333-333333333333\"\n      ],\n      \"description\": \"original description\",\n      \"mode\": \"auto\",\n      \"status\": \"completed\",\n      \"title\": \"B-side title\",\n      \"updated_at\": \"2026-02-01T02:00:00.000000Z\"\n    },\n    \"bbbbbbbb-2222-4222-8222-222222222222\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"B description\",\n      \"mode\": \"auto\",\n      \"status\": \"todo\",\n      \"title\": \"B node\",\n      \"updated_at\": \"2026-02-01T00:00:00.000000Z\"\n    },\n    \"cccccccc-3333-4333-8333-333333333333\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"C description\",\n      \"mode\": \"auto\",\n      \"status\": \"todo\",\n      \"title\": \"C node\",\n      \"updated_at\": \"2026-02-01T00:00:00.000000Z\"\n    }\n  }\n}",
    expectCode: 0,
    expectMerged: "{\n  \"nodes\": {\n    \"aaaaaaaa-1111-4111-8111-111111111111\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [\n        \"bbbbbbbb-2222-4222-8222-222222222222\",\n        \"cccccccc-3333-4333-8333-333333333333\"\n      ],\n      \"description\": \"original description\",\n      \"mode\": \"auto\",\n      \"status\": \"completed\",\n      \"title\": \"B-side title\",\n      \"updated_at\": \"2026-02-01T02:00:00.000000Z\"\n    },\n    \"bbbbbbbb-2222-4222-8222-222222222222\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"B description\",\n      \"mode\": \"auto\",\n      \"status\": \"todo\",\n      \"title\": \"B node\",\n      \"updated_at\": \"2026-02-01T00:00:00.000000Z\"\n    },\n    \"cccccccc-3333-4333-8333-333333333333\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"C description\",\n      \"mode\": \"auto\",\n      \"status\": \"todo\",\n      \"title\": \"C node\",\n      \"updated_at\": \"2026-02-01T00:00:00.000000Z\"\n    }\n  }\n}",
  },
  {
    name: "ideas-title-conflict",
    kind: "ideas",
    path: ".pf/ideas.json",
    base: "{\n  \"nodes\": {\n    \"aaaaaaaa-1111-4111-8111-111111111111\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"original description\",\n      \"mode\": \"auto\",\n      \"status\": \"todo\",\n      \"title\": \"original title\",\n      \"updated_at\": \"2026-02-01T00:00:00.000000Z\"\n    }\n  }\n}",
    ours: "{\n  \"nodes\": {\n    \"aaaaaaaa-1111-4111-8111-111111111111\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"original description\",\n      \"mode\": \"auto\",\n      \"status\": \"todo\",\n      \"title\": \"A-side title\",\n      \"updated_at\": \"2026-02-01T01:00:00.000000Z\"\n    }\n  }\n}",
    theirs: "{\n  \"nodes\": {\n    \"aaaaaaaa-1111-4111-8111-111111111111\": {\n      \"created_at\": \"2026-02-01T00:00:00.000000Z\",\n      \"dependencies\": [],\n      \"description\": \"original description\",\n      \"mode\": \"auto\",\n      \"status\": \"todo\",\n      \"title\": \"B-side title\",\n      \"updated_at\": \"2026-02-01T01:00:00.000000Z\"\n    }\n  }\n}",
    expectCode: 1,
    expectMerged: null,
  },
  {
    name: "state-path-append",
    kind: "state",
    path: ".pf/state.json",
    base: "{\n  \"cycles\": [\n    {\n      \"id\": \"pf-core\",\n      \"title\": \"main thread\",\n      \"status\": \"active\",\n      \"holding\": [],\n      \"path\": [\n        {\n          \"node\": \"cccccccc-3333-4333-8333-333333333333\",\n          \"started_at\": \"2026-02-01T00:00:00Z\",\n          \"ended_at\": \"2026-02-01T00:10:00Z\",\n          \"result\": \"completed\"\n        }\n      ],\n      \"created_at\": \"2026-02-01T00:00:00Z\",\n      \"updated_at\": \"2026-02-01T00:10:00Z\"\n    }\n  ]\n}",
    ours: "{\n  \"cycles\": [\n    {\n      \"id\": \"pf-core\",\n      \"title\": \"main thread\",\n      \"status\": \"active\",\n      \"holding\": [],\n      \"path\": [\n        {\n          \"node\": \"cccccccc-3333-4333-8333-333333333333\",\n          \"started_at\": \"2026-02-01T00:00:00Z\",\n          \"ended_at\": \"2026-02-01T00:10:00Z\",\n          \"result\": \"completed\"\n        },\n        {\n          \"node\": \"bbbbbbbb-2222-4222-8222-222222222222\",\n          \"started_at\": \"2026-02-01T00:10:00Z\",\n          \"ended_at\": \"2026-02-01T00:20:00Z\",\n          \"result\": \"completed\"\n        }\n      ],\n      \"created_at\": \"2026-02-01T00:00:00Z\",\n      \"updated_at\": \"2026-02-01T00:20:00Z\"\n    }\n  ]\n}",
    theirs: "{\n  \"cycles\": [\n    {\n      \"id\": \"pf-core\",\n      \"title\": \"main thread\",\n      \"status\": \"active\",\n      \"holding\": [\n        {\n          \"id\": \"bbbbbbbb-2222-4222-8222-222222222222\",\n          \"since\": \"2026-02-01T00:30:00Z\"\n        }\n      ],\n      \"path\": [\n        {\n          \"node\": \"cccccccc-3333-4333-8333-333333333333\",\n          \"started_at\": \"2026-02-01T00:00:00Z\",\n          \"ended_at\": \"2026-02-01T00:10:00Z\",\n          \"result\": \"completed\"\n        },\n        {\n          \"node\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n          \"started_at\": \"2026-02-01T00:20:00Z\",\n          \"ended_at\": \"2026-02-01T00:30:00Z\",\n          \"result\": \"failed\"\n        }\n      ],\n      \"created_at\": \"2026-02-01T00:00:00Z\",\n      \"updated_at\": \"2026-02-01T00:30:00Z\"\n    }\n  ]\n}",
    expectCode: 0,
    expectMerged: "{\n  \"cycles\": [\n    {\n      \"id\": \"pf-core\",\n      \"title\": \"main thread\",\n      \"status\": \"active\",\n      \"holding\": [\n        {\n          \"id\": \"bbbbbbbb-2222-4222-8222-222222222222\",\n          \"since\": \"2026-02-01T00:30:00Z\"\n        }\n      ],\n      \"path\": [\n        {\n          \"node\": \"cccccccc-3333-4333-8333-333333333333\",\n          \"started_at\": \"2026-02-01T00:00:00Z\",\n          \"ended_at\": \"2026-02-01T00:10:00Z\",\n          \"result\": \"completed\"\n        },\n        {\n          \"node\": \"bbbbbbbb-2222-4222-8222-222222222222\",\n          \"started_at\": \"2026-02-01T00:10:00Z\",\n          \"ended_at\": \"2026-02-01T00:20:00Z\",\n          \"result\": \"completed\"\n        },\n        {\n          \"node\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n          \"started_at\": \"2026-02-01T00:20:00Z\",\n          \"ended_at\": \"2026-02-01T00:30:00Z\",\n          \"result\": \"failed\"\n        }\n      ],\n      \"created_at\": \"2026-02-01T00:00:00Z\",\n      \"updated_at\": \"2026-02-01T00:30:00Z\"\n    }\n  ]\n}",
  },
  {
    name: "state-holding-conflict",
    kind: "state",
    path: ".pf/state.json",
    base: "{\n  \"cycles\": [\n    {\n      \"id\": \"pf-core\",\n      \"title\": \"main thread\",\n      \"status\": \"active\",\n      \"holding\": [],\n      \"path\": [],\n      \"created_at\": \"2026-02-01T00:00:00Z\",\n      \"updated_at\": \"2026-02-01T00:00:00Z\"\n    }\n  ]\n}",
    ours: "{\n  \"cycles\": [\n    {\n      \"id\": \"pf-core\",\n      \"title\": \"main thread\",\n      \"status\": \"active\",\n      \"holding\": [\n        {\n          \"id\": \"bbbbbbbb-2222-4222-8222-222222222222\",\n          \"since\": \"2026-02-01T00:10:00Z\"\n        }\n      ],\n      \"path\": [],\n      \"created_at\": \"2026-02-01T00:00:00Z\",\n      \"updated_at\": \"2026-02-01T00:00:00Z\"\n    }\n  ]\n}",
    theirs: "{\n  \"cycles\": [\n    {\n      \"id\": \"pf-core\",\n      \"title\": \"main thread\",\n      \"status\": \"active\",\n      \"holding\": [\n        {\n          \"id\": \"cccccccc-3333-4333-8333-333333333333\",\n          \"since\": \"2026-02-01T00:10:00Z\"\n        }\n      ],\n      \"path\": [],\n      \"created_at\": \"2026-02-01T00:00:00Z\",\n      \"updated_at\": \"2026-02-01T00:00:00Z\"\n    }\n  ]\n}",
    expectCode: 1,
    expectMerged: null,
  },
  {
    name: "instructions-resolution",
    kind: "instructions",
    path: ".pf/instructions.json",
    base: "{\n  \"instructions\": [\n    {\n      \"id\": \"1\",\n      \"text\": \"first entry\",\n      \"scope\": \"global\",\n      \"target\": \"stage\",\n      \"state\": \"live\",\n      \"cycle\": null,\n      \"node\": null,\n      \"said_by\": \"user\",\n      \"at\": \"2026-02-01T00:00:00Z\",\n      \"resolved_at\": null,\n      \"note\": null\n    }\n  ],\n  \"removed\": [\n    {\n      \"id\": \"3\",\n      \"at\": \"2026-02-01T00:10:00Z\"\n    }\n  ]\n}",
    ours: "{\n  \"instructions\": [\n    {\n      \"id\": \"1\",\n      \"text\": \"first entry\",\n      \"scope\": \"global\",\n      \"target\": \"stage\",\n      \"state\": \"withdrawn\",\n      \"cycle\": null,\n      \"node\": null,\n      \"said_by\": \"user\",\n      \"at\": \"2026-02-01T00:00:00Z\",\n      \"resolved_at\": \"2026-02-01T01:00:00Z\",\n      \"note\": null\n    }\n  ],\n  \"removed\": [\n    {\n      \"id\": \"3\",\n      \"at\": \"2026-02-01T00:10:00Z\"\n    },\n    {\n      \"id\": \"4\",\n      \"at\": \"2026-02-01T01:05:00Z\"\n    }\n  ]\n}",
    theirs: "{\n  \"instructions\": [\n    {\n      \"id\": \"1\",\n      \"text\": \"first entry\",\n      \"scope\": \"global\",\n      \"target\": \"stage\",\n      \"state\": \"live\",\n      \"cycle\": null,\n      \"node\": null,\n      \"said_by\": \"user\",\n      \"at\": \"2026-02-01T00:00:00Z\",\n      \"resolved_at\": null,\n      \"note\": \"a line written by hand\"\n    }\n  ],\n  \"removed\": [\n    {\n      \"id\": \"3\",\n      \"at\": \"2026-02-01T00:10:00Z\"\n    },\n    {\n      \"id\": \"5\",\n      \"at\": \"2026-02-01T01:06:00Z\"\n    }\n  ]\n}",
    expectCode: 0,
    expectMerged: "{\n  \"instructions\": [\n    {\n      \"id\": \"1\",\n      \"text\": \"first entry\",\n      \"scope\": \"global\",\n      \"target\": \"stage\",\n      \"state\": \"withdrawn\",\n      \"cycle\": null,\n      \"node\": null,\n      \"said_by\": \"user\",\n      \"at\": \"2026-02-01T00:00:00Z\",\n      \"resolved_at\": \"2026-02-01T01:00:00Z\",\n      \"note\": \"a line written by hand\"\n    }\n  ],\n  \"removed\": [\n    {\n      \"id\": \"3\",\n      \"at\": \"2026-02-01T00:10:00Z\"\n    },\n    {\n      \"id\": \"4\",\n      \"at\": \"2026-02-01T01:05:00Z\"\n    },\n    {\n      \"id\": \"5\",\n      \"at\": \"2026-02-01T01:06:00Z\"\n    }\n  ]\n}",
  },
  {
    name: "instructions-delete-vs-edit",
    kind: "instructions",
    path: ".pf/instructions.json",
    base: "{\n  \"instructions\": [\n    {\n      \"id\": \"1\",\n      \"text\": \"first entry\",\n      \"scope\": \"global\",\n      \"target\": \"stage\",\n      \"state\": \"live\",\n      \"cycle\": null,\n      \"node\": null,\n      \"said_by\": \"user\",\n      \"at\": \"2026-02-01T00:00:00Z\",\n      \"resolved_at\": null,\n      \"note\": null\n    },\n    {\n      \"id\": \"2\",\n      \"text\": \"second entry\",\n      \"scope\": \"global\",\n      \"target\": \"stage\",\n      \"state\": \"live\",\n      \"cycle\": null,\n      \"node\": null,\n      \"said_by\": \"user\",\n      \"at\": \"2026-02-01T00:00:00Z\",\n      \"resolved_at\": null,\n      \"note\": null\n    }\n  ],\n  \"removed\": []\n}",
    ours: "{\n  \"instructions\": [\n    {\n      \"id\": \"1\",\n      \"text\": \"first entry\",\n      \"scope\": \"global\",\n      \"target\": \"stage\",\n      \"state\": \"live\",\n      \"cycle\": null,\n      \"node\": null,\n      \"said_by\": \"user\",\n      \"at\": \"2026-02-01T00:00:00Z\",\n      \"resolved_at\": null,\n      \"note\": null\n    }\n  ],\n  \"removed\": [\n    {\n      \"id\": \"2\",\n      \"at\": \"2026-02-01T02:00:00Z\"\n    }\n  ]\n}",
    theirs: "{\n  \"instructions\": [\n    {\n      \"id\": \"1\",\n      \"text\": \"first entry\",\n      \"scope\": \"global\",\n      \"target\": \"stage\",\n      \"state\": \"live\",\n      \"cycle\": null,\n      \"node\": null,\n      \"said_by\": \"user\",\n      \"at\": \"2026-02-01T00:00:00Z\",\n      \"resolved_at\": null,\n      \"note\": null\n    },\n    {\n      \"id\": \"2\",\n      \"text\": \"second entry changed on the B side\",\n      \"scope\": \"global\",\n      \"target\": \"stage\",\n      \"state\": \"live\",\n      \"cycle\": null,\n      \"node\": null,\n      \"said_by\": \"user\",\n      \"at\": \"2026-02-01T00:00:00Z\",\n      \"resolved_at\": null,\n      \"note\": null\n    }\n  ],\n  \"removed\": []\n}",
    expectCode: 1,
    expectMerged: null,
  },
  {
    name: "signal-terminal-beats-pending",
    kind: "signal",
    path: ".pf/signals/pf-core/aaaaaaaa-1111-4111-8111-111111111111.json",
    base: "{\n  \"cycle\": \"pf-core\",\n  \"node\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n  \"status\": \"completed\",\n  \"summary\": \"original report\",\n  \"outputs\": {\n    \"notes\": [\n      \"one entry\"\n    ]\n  },\n  \"timestamp\": \"2026-02-01T00:00:00Z\"\n}",
    ours: "{\n  \"cycle\": \"pf-core\",\n  \"node\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n  \"status\": \"failed\",\n  \"summary\": \"original report\",\n  \"outputs\": {\n    \"notes\": [\n      \"one entry\"\n    ]\n  },\n  \"timestamp\": \"2026-02-01T00:00:00Z\"\n}",
    theirs: "{\n  \"cycle\": \"pf-core\",\n  \"node\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n  \"status\": \"pending\",\n  \"summary\": \"pending rerun\",\n  \"outputs\": {\n    \"notes\": [\n      \"one entry\"\n    ]\n  },\n  \"timestamp\": \"2026-02-01T01:00:00Z\"\n}",
    expectCode: 0,
    expectMerged: "{\n  \"cycle\": \"pf-core\",\n  \"node\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n  \"status\": \"failed\",\n  \"summary\": \"pending rerun\",\n  \"outputs\": {\n    \"notes\": [\n      \"one entry\"\n    ]\n  },\n  \"timestamp\": \"2026-02-01T01:00:00Z\"\n}",
  },
  {
    name: "issues-refused",
    kind: null,
    path: ".pf/issues/issues.json",
    base: "{\n  \"version\": 1,\n  \"issues\": {}\n}",
    ours: "{\n  \"version\": 1,\n  \"issues\": {\n    \"aaaaaaaa-1111-4111-8111-111111111111\": {\n      \"id\": \"aaaaaaaa-1111-4111-8111-111111111111\",\n      \"severity\": \"P2\",\n      \"module\": \"core\",\n      \"title\": \"title changed on the A side\",\n      \"decision\": \"autofix\",\n      \"source\": \"scan\",\n      \"status\": \"open\",\n      \"discovered\": \"2026-02-01T00:00:00.000000Z\",\n      \"updated_at\": \"2026-02-01T01:00:00.000000Z\",\n      \"check_count\": 1,\n      \"files\": [],\n      \"functions\": [],\n      \"description\": \"\",\n      \"suggestion\": \"\",\n      \"reason\": null,\n      \"plan_path\": null\n    }\n  }\n}",
    theirs: "{\n  \"version\": 1,\n  \"issues\": {}\n}",
    expectCode: 2,
    expectMerged: null,
  },
];
