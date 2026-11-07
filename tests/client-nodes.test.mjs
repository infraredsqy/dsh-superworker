/* A cell's name and handles: eight-char short id, titleless nodes fall back to the short id,
 * hover shows "full name · short handle" and does not repeat the name when it already equals
 * the handle, and a name cut to a place's own width is cut the same way everywhere.
 *
 * These literals live in src/client/nodes.ts — pure functions, loadable in Node; how a card
 * and a row pair the name with the handle is a rendering concern, walked by hand,
 * while this file locks the criteria themselves: the long/short bounds of truncation, missing vs
 * empty-string titles, both hover outcomes, and the one cut-with-ellipsis spelling.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { shortId, nameWithin, nodeName, nodeHover } from '../src/client/nodes.ts'

function aNode(id, title) {
  return { id, title }
}

test('short id: exactly eight chars kept, cut from the ninth, an overlong id keeps only the first eight', () => {
  assert.equal(shortId('abcdefgh'), 'abcdefgh', 'exactly eight is not cut')
  assert.equal(shortId('abcdefghi'), 'abcdefgh', 'cut from the ninth character')
  assert.equal(shortId('f47ac10b-58cc-4372-a567-0e02b2c3d479'), 'f47ac10b', 'an overlong id keeps only the first eight')
})

test('a cell\'s name: a title written in the record is used, only without one does the short id apply', () => {
  assert.equal(nodeName(aNode('n1', 'batch E close')), 'batch E close', 'a written title is used')
  assert.equal(nodeName(aNode('n123456789', undefined)), 'n1234567', 'no title falls back to the short id, the full id is never shown')
  assert.equal(nodeName(aNode('n1', '')), '', 'an empty title still counts as written, it does not fall back')
})

test('cutting a name: cut to the width the caller gives, the ellipsis only when cut, an exact fit is not cut', () => {
  assert.equal(nameWithin('batch E close', 13), 'batch E close', 'fits, so kept as is')
  assert.equal(nameWithin('abcdefghijkl', 12), 'abcdefghijkl', 'exactly the same width: no cut, no ellipsis')
  assert.equal(nameWithin('abcdefghijklm', 12), 'abcdefghijkl…', 'one char over: cut to the width with the ellipsis saying it is not whole')
  assert.equal(nameWithin('abcdefghijklm', 5), 'abcde…', 'the width is the caller\'s business, this only cuts to it')
})

test('hover: the full name followed by the eight-char handle, not repeated when the name already is those eight', () => {
  assert.equal(nodeHover(aNode('n123456789', undefined)), 'n1234567', 'no title, so only the short handle')
  assert.equal(nodeHover(aNode('abcdefgh', 'abcdefgh')), 'abcdefgh', 'the title is exactly the eight-char handle, one segment')
  assert.equal(nodeHover(aNode('abcdefgh-rest', 'abcdefgh')), 'abcdefgh', 'the title equals the cut handle, not repeated either')
  assert.equal(nodeHover(aNode('n1', 'batch E close')), 'batch E close · n1', 'with a short id the full name is followed by the whole handle')
  assert.equal(nodeHover(aNode('f47ac10b-58cc-4372-a567-0e02b2c3d479', 'batch E close')), 'batch E close · f47ac10b', 'with a long id the handle is cut to eight chars')
})
