import { describe, expect, it } from 'vitest';
import type {
  CycleRecord,
  HandoffRecord,
  InstructionLedger,
  InstructionRecord,
  IssueLedger,
  IssueRecord,
  NodeRecord,
  SessionNoteRecord,
} from '../src/types';

/**
 * Shape samples of the frozen record types: one complete sample per record kind, with the key
 * sets checked one by one. Vocabulary and key names are written exactly as the `.pf/` records have
 * them on disk.
 */

const node: NodeRecord = {
  title: '脚手架',
  description: '把接口面立起来',
  status: 'completed',
  mode: 'auto',
  dependencies: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
  created_at: '2026-01-01T00:00:00.000000Z',
  updated_at: '2026-01-02T00:00:00.000000Z',
  tags: ['coding'],
  weight: 'light',
  completed_at: '2026-01-02T00:00:00.000000Z',
  approved_at: '2026-01-02T12:00:00.000000Z',
};

const cycle: CycleRecord = {
  id: 'main',
  title: 'Cycle 2026-01-01',
  status: 'active',
  holding: [{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', since: '2026-01-01T00:00:00Z' }],
  path: [
    {
      node: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      started_at: '2026-01-01T00:00:00Z',
      ended_at: '2026-01-01T01:00:00Z',
      result: 'completed',
    },
  ],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T01:00:00Z',
  tags: ['coding'],
  policies: { when_shelved: 'stop', parallel: 2, spawner: 'dsh' },
};

const instruction: InstructionRecord = {
  id: 'i-0001',
  text: '审计的临时产物只写进 .tmp/',
  scope: 'global',
  target: 'stage',
  state: 'live',
  cycle: null,
  node: null,
  said_by: 'owner',
  at: '2026-01-01T00:00:00Z',
  resolved_at: null,
  note: null,
  stop_after_nodes: 3,
};

const instructionLedger: InstructionLedger = {
  instructions: [instruction],
  removed: [{ id: 'i-0002', at: '2026-01-01T00:00:00Z' }],
};

const issue: IssueRecord = {
  id: 'demo-untitled',
  severity: 'P2',
  module: 'demo',
  title: '示例问题',
  decision: 'autofix',
  source: 'scan',
  status: 'open',
  discovered: '2026-01-01T00:00:00.000000Z',
  updated_at: '2026-01-01T00:00:00.000000Z',
  check_count: 1,
  files: ['src/demo.ts'],
  functions: ['demo'],
  description: '',
  suggestion: '',
  reason: null,
  plan_path: null,
};

const issueLedger: IssueLedger = { version: 1, issues: { [issue.id]: issue } };

const handoff: HandoffRecord = {
  cycle: 'main',
  node: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  status: 'completed',
  summary: '干完了',
  outputs: { deliverable: 'x' },
  timestamp: '2026-01-01T01:00:00Z',
};

const sessionNote: SessionNoteRecord = {
  v: 1,
  discussion: [{ session: 's-1', host: 'dsh', at: '2026-01-01T00:00:00Z' }],
  run: [{ session: 'sess_abc', host: 'dsh', at: null, source: 'ledger' }],
};

describe('key sets of the six frozen record kinds', () => {
  it('node (a value in the nodes table of ideas.json)', () => {
    expect(Object.keys(node).sort()).toEqual([
      'approved_at', 'completed_at', 'created_at', 'dependencies', 'description',
      'mode', 'status', 'tags', 'title', 'updated_at', 'weight',
    ]);
  });
  it('cycle (an entry in the cycles table of state.json)', () => {
    expect(Object.keys(cycle).sort()).toEqual([
      'created_at', 'holding', 'id', 'path', 'policies', 'status', 'tags', 'title', 'updated_at',
    ]);
    expect(Object.keys(cycle.holding[0]!).sort()).toEqual(['id', 'since']);
    expect(Object.keys(cycle.path[0]!).sort()).toEqual(['ended_at', 'node', 'result', 'started_at']);
  });
  it('instruction (an entry in the instructions table of instructions.json)', () => {
    expect(Object.keys(instruction).sort()).toEqual([
      'at', 'cycle', 'id', 'node', 'note', 'resolved_at', 'said_by', 'scope',
      'state', 'stop_after_nodes', 'target', 'text',
    ]);
    expect(Object.keys(instructionLedger).sort()).toEqual(['instructions', 'removed']);
    expect(Object.keys(instructionLedger.removed![0]!).sort()).toEqual(['at', 'id']);
  });
  it('issue (a value in the issues table of issues.json)', () => {
    expect(Object.keys(issue).sort()).toEqual([
      'check_count', 'decision', 'description', 'discovered', 'files', 'functions', 'id',
      'module', 'plan_path', 'reason', 'severity', 'source', 'status', 'suggestion',
      'title', 'updated_at',
    ]);
    expect(Object.keys(issueLedger).sort()).toEqual(['issues', 'version']);
  });
  it('handoff (signals/<cycle>/<node>.json)', () => {
    expect(Object.keys(handoff).sort()).toEqual([
      'cycle', 'node', 'outputs', 'status', 'summary', 'timestamp',
    ]);
  });
  it('session note (meta/sessions/<node>.json)', () => {
    expect(Object.keys(sessionNote).sort()).toEqual(['discussion', 'run', 'v']);
    expect(Object.keys(sessionNote.discussion[0]!).sort()).toEqual(['at', 'host', 'session']);
    expect(Object.keys(sessionNote.run[0]!).sort()).toEqual(['at', 'host', 'session', 'source']);
  });
});

describe('frozen value vocabularies', () => {
  it('three node states, three modes', () => {
    expect(['todo', 'shelved', 'completed']).toContain(node.status);
    expect(['manual', 'checkpoint', 'auto']).toContain(node.mode);
    expect(['light', 'standard']).toContain(node.weight!);
  });
  it('a cycle has only two states, a verdict only three words', () => {
    expect(['active', 'inactive']).toContain(cycle.status);
    expect(['completed', 'failed', 'stopped']).toContain(cycle.path[0]!.result);
    expect(['completed', 'failed', 'stopped']).toContain(handoff.status);
  });
  it('scope, target and state of an instruction', () => {
    expect(['global', 'cycle', 'node']).toContain(instruction.scope);
    expect(['stage', 'boundary']).toContain(instruction.target);
    expect(['live', 'withdrawn']).toContain(instruction.state);
  });
  it('severity, decision, source and state of an issue', () => {
    expect(['P0', 'P1', 'P2', 'P3']).toContain(issue.severity);
    expect(['autofix', 'external', 'unknown']).toContain(issue.decision);
    expect(['scan', 'manual', 'conduct']).toContain(issue.source);
    expect(['open', 'acknowledged', 'resolving', 'resolved', 'rejected']).toContain(issue.status);
  });
  it('host word and version number of a session note', () => {
    expect(sessionNote.v).toBe(1);
    // One host word: this engine opens DSH sessions and nothing else.
    expect(sessionNote.discussion[0]!.host).toBe('dsh');
    expect(sessionNote.run[0]!.host).toBe('dsh');
  });
});
