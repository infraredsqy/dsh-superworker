import { describe, expect, it } from 'vitest';
import { open } from '../src/open';

/**
 * The surface exists: the four namespaces carry every frozen method, none missing and none extra.
 * The names come from the frozen surface in docs/api.md; renaming goes through the conductor and
 * does not quietly happen here.
 */

const DAG_METHODS = [
  'add', 'remove', 'update', 'link', 'unlink', 'setStatus', 'approve', 'revive',
  'get', 'info', 'context', 'search', 'list', 'specPath', 'validate',
];
const CYCLE_METHODS = [
  'create', 'start', 'rename', 'setStatus', 'setPolicy', 'list', 'current',
  'show', 'policies', 'standing', 'hold', 'close', 'retry',
];
const INSTRUCTION_METHODS = ['add', 'list', 'resolve', 'revive', 'remove'];
const CONFIG_METHODS = ['get', 'set', 'unset', 'list', 'keys'];
const SESSION_METHODS = ['list', 'show', 'note'];
const CONDUCTOR_METHODS = [
  'next', 'prepare', 'dispatch', 'handoff', 'settle', 'close', 'advance', 'doctor',
  'handoffForm', 'pluginCommand', 'pluginCommands',
];

const pf = open('\\\\tmp\\pf-surface-probe');

describe('the handle open() hands back', () => {
  it('root plus four namespaces, no key missing and none extra', () => {
    expect(Object.keys(pf).sort()).toEqual(['conductor', 'config', 'ledger', 'root', 'sessions']);
  });
  it('root is kept as given', () => {
    expect(pf.root).toBe('\\\\tmp\\pf-surface-probe');
  });
});

describe('pf.ledger', () => {
  it('init / register / cleanTemp / dag / cycles / instructions are all there', () => {
    expect(Object.keys(pf.ledger).sort())
      .toEqual(['cleanTemp', 'cycles', 'dag', 'init', 'instructions', 'register']);
    expect(typeof pf.ledger.init).toBe('function');
    expect(typeof pf.ledger.register).toBe('function');
    expect(typeof pf.ledger.cleanTemp).toBe('function');
  });
  it('dag has all fifteen verbs', () => {
    expect(Object.keys(pf.ledger.dag).sort()).toEqual([...DAG_METHODS].sort());
  });
  it('cycles has all thirteen verbs', () => {
    expect(Object.keys(pf.ledger.cycles).sort()).toEqual([...CYCLE_METHODS].sort());
  });
  it('instructions has all five verbs', () => {
    expect(Object.keys(pf.ledger.instructions).sort()).toEqual([...INSTRUCTION_METHODS].sort());
  });
});

describe('pf.config / pf.sessions / pf.conductor', () => {
  it('config has all five verbs', () => {
    expect(Object.keys(pf.config).sort()).toEqual([...CONFIG_METHODS].sort());
  });
  it('sessions has all three verbs', () => {
    expect(Object.keys(pf.sessions).sort()).toEqual([...SESSION_METHODS].sort());
  });
  it('conductor has all eleven verbs', () => {
    expect(Object.keys(pf.conductor).sort()).toEqual([...CONDUCTOR_METHODS].sort());
  });
});
