import { describe, expect, it } from 'vitest';
import { open } from '../src/open';

/**
 * The surface exists: the handle's namespaces carry every frozen method, none missing and none extra.
 * The names come from the frozen surface in docs/api.md; renaming goes through the conductor and
 * does not quietly happen here.
 */

const DAG_METHODS = [
  'add', 'addMany', 'remove', 'update', 'link', 'unlink', 'setStatus', 'approve', 'revive',
  'get', 'info', 'context', 'search', 'list', 'specPath', 'validate',
];
const CYCLE_METHODS = [
  'create', 'start', 'rename', 'setStatus', 'setPolicy', 'list', 'current',
  'show', 'policies', 'standing', 'holder', 'hold', 'close', 'retry',
];
const CONFIG_METHODS = ['get', 'set', 'unset', 'list', 'keys'];
const SESSION_METHODS = ['list', 'show', 'note'];
const CONDUCTOR_METHODS = [
  'next', 'prepare', 'dispatch', 'dispatchPreview', 'handoff', 'settle', 'settlePreview', 'close',
  'advance', 'doctor', 'handoffForm', 'pluginCommand', 'pluginCommands', 'startedHolding',
];

const superworker = open('\\\\tmp\\superworker-surface-probe');

describe('the handle open() hands back', () => {
  it('root plus four namespaces and the record tree locations, no key missing and none extra', () => {
    expect(Object.keys(superworker).sort()).toEqual(['conductor', 'config', 'ledger', 'locations', 'root', 'sessions']);
  });
  it('root is kept as given', () => {
    expect(superworker.root).toBe('\\\\tmp\\superworker-surface-probe');
  });
});

describe('superworker.ledger', () => {
  it('init / register / migrate / cleanTemp / dag / cycles are all there', () => {
    expect(Object.keys(superworker.ledger).sort())
      .toEqual(['cleanTemp', 'cycles', 'dag', 'init', 'migrate', 'register']);
    expect(typeof superworker.ledger.init).toBe('function');
    expect(typeof superworker.ledger.register).toBe('function');
    expect(typeof superworker.ledger.migrate).toBe('function');
    expect(typeof superworker.ledger.cleanTemp).toBe('function');
  });
  it('dag has all sixteen verbs', () => {
    expect(Object.keys(superworker.ledger.dag).sort()).toEqual([...DAG_METHODS].sort());
  });
  it('cycles has all fourteen verbs', () => {
    expect(Object.keys(superworker.ledger.cycles).sort()).toEqual([...CYCLE_METHODS].sort());
  });
});

describe('superworker.config / superworker.sessions / superworker.conductor', () => {
  it('config has all five verbs', () => {
    expect(Object.keys(superworker.config).sort()).toEqual([...CONFIG_METHODS].sort());
  });
  it('sessions has all three verbs', () => {
    expect(Object.keys(superworker.sessions).sort()).toEqual([...SESSION_METHODS].sort());
  });
  it('conductor has all fourteen verbs', () => {
    expect(Object.keys(superworker.conductor).sort()).toEqual([...CONDUCTOR_METHODS].sort());
  });
});
