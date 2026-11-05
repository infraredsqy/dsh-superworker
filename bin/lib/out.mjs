/**
 * The small shared cells every verb's lines are built from: the short id, the path spelling, the two
 * scalar spellings the lines print, the project handle, and the one shape of a refusal.
 */
import { handleOf, messageOf, projectRoot } from './engine.mjs';

/** The first eight characters of an id: the short form the lines print. */
export const short = (id) => String(id).slice(0, 8);

/** A path the way the listings spell it: forward slashes, on every platform. */
export const posix = (path) => String(path).split('\\').join('/');

/** The list spelling: `['coding', 'writing']`. */
export function pyList(words) {
  return `[${words.map((word) => `'${word}'`).join(', ')}]`;
}

/** The scalar spelling: booleans spell `True` / `False`. */
export function pyScalar(value) {
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === null || value === undefined) return 'None';
  return String(value);
}

/** One refusal: the sentence on stderr, and the exit code a refusal answers with. */
export function refuse(message, code = 1) {
  return { code, stderr: `Error: ${message}` };
}

/** Wrap one handler so an engine refusal lands as its sentence plus that door's exit code. */
export function guarded(body, exitCode = 1) {
  return async (context) => {
    try {
      return await body(context);
    } catch (error) {
      return refuse(messageOf(error), exitCode);
    }
  };
}

/** The project root and the handle of one call. */
export async function project(value) {
  const root = await projectRoot(value);
  return { root, pf: await handleOf(root) };
}

/** The tag list of one filter cell: comma-separated, empty words dropped. */
export function splitTags(text) {
  return String(text).split(',').map((tag) => tag.trim()).filter((tag) => tag !== '');
}

/** A count cell (`--parallel`, `--limit`): the number as written, `off` as the default. */
export function readCount(text) {
  if (text === 'off') return 1;
  const value = Number(text);
  return Number.isFinite(value) ? value : text;
}

/** A policy value as the record takes it: `on` / `off` become booleans, numbers become numbers. */
export function readPolicyValue(text) {
  if (text === 'on') return true;
  if (text === 'off') return null;
  if (text !== '' && Number.isFinite(Number(text))) return Number(text);
  return text;
}