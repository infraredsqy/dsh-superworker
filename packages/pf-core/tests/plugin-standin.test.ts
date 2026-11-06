import { describe, expect, it } from 'vitest';
import { standInContext } from '../src/plugins/standin';
import { CORE_READING_SOURCES } from '../src/plugins/types';
import type { PluginDeclaration } from '../src/plugins/types';

/**
 * The stand-in context doctor hands to a real question: it answers the contract's shape and nothing else.
 * The point of these cases is that it reads a declared cell the same way every other reader does — the
 * core's reading sources are the ones the core states (not the one word "ticket" copied here), and a knob
 * value is the first value its own kind allows.
 */

const PROJECT = 'C:/stand-in-project';

describe('the stand-in reads declared cells through the registry, not through a second reading', () => {
  it('a reading whose source the core serves is given 1, because the core source list is read here', async () => {
    // A source the core adds later is served by the stand-in the day it is added: the list is read, not
    // copied. The word "ticket" spelled into this file would answer null here instead of 1.
    const added = 'a_source_the_core_added_later';
    (CORE_READING_SOURCES as string[]).push(added);
    try {
      const decl: PluginDeclaration = { readings: { measured: { source: added } } };
      const ctx = standInContext(decl, PROJECT);
      expect(await ctx.reading('measured')).toBe(1);
    } finally {
      (CORE_READING_SOURCES as string[]).pop();
    }
  });

  it('a reading whose source nobody serves honestly answers "none this round"', async () => {
    const decl: PluginDeclaration = { readings: { measured: { source: 'nobody_serves_this' } } };
    const ctx = standInContext(decl, PROJECT);
    expect(await ctx.reading('measured')).toBeNull();
  });

  it('a knob takes the first value its kind allows: 1 for a number / integer, the first word, on for a switch', async () => {
    const decl: PluginDeclaration = {
      knobs: {
        count: { kind: 'number', default: null },
        total: { kind: 'integer', default: 3 },
        mode: { kind: 'word', values: ['fast', 'slow'], default: 'slow' },
        armed: { kind: 'switch', default: 'off' },
      },
    };
    const ctx = standInContext(decl, PROJECT);
    expect(await ctx.knob('count')).toBe(1);
    expect(await ctx.knob('total')).toBe(1);
    expect(await ctx.knob('mode')).toBe('fast');
    expect(await ctx.knob('armed')).toBe('on');
    expect(await ctx.knob('not_declared')).toBeNull();
  });
});
