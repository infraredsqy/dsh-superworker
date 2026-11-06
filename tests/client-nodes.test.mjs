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

test('短写：恰八字原样，第九个字起截，超长身份也只留头八字', () => {
  assert.equal(shortId('abcdefgh'), 'abcdefgh', '恰八字的不截')
  assert.equal(shortId('abcdefghi'), 'abcdefgh', '第九个字起截掉')
  assert.equal(shortId('f47ac10b-58cc-4372-a567-0e02b2c3d479'), 'f47ac10b', '超长身份只留头八字')
})

test('一格的名字：记录写了标题就用标题，没写才轮到身份短写', () => {
  assert.equal(nodeName(aNode('n1', '批E 收尾')), '批E 收尾', '写了标题用标题')
  assert.equal(nodeName(aNode('n123456789', undefined)), 'n1234567', '没写标题落身份短写，不露全长身份')
  assert.equal(nodeName(aNode('n1', '')), '', '写了空标题也算写了，不落回短写')
})

test('截名字：按调用方给的宽度截，截了才带省略号，恰好的不截', () => {
  assert.equal(nameWithin('批E 收尾', 12), '批E 收尾', '装得下就原样')
  assert.equal(nameWithin('abcdefghijkl', 12), 'abcdefghijkl', '恰好一样宽：不截也不加省略号')
  assert.equal(nameWithin('abcdefghijklm', 12), 'abcdefghijkl…', '多一个字：截到宽度并说明没印完')
  assert.equal(nameWithin('abcdefghijklm', 5), 'abcde…', '宽度是调用方的事，这里只负责按它截')
})

test('悬停：全名后跟八字把手，名字本身就是那八个字时不重复', () => {
  assert.equal(nodeHover(aNode('n123456789', undefined)), 'n1234567', '没写标题就只有短把手')
  assert.equal(nodeHover(aNode('abcdefgh', 'abcdefgh')), 'abcdefgh', '标题恰是八字把手，单段')
  assert.equal(nodeHover(aNode('abcdefgh-rest', 'abcdefgh')), 'abcdefgh', '标题等于截出来的把手，也不重复')
  assert.equal(nodeHover(aNode('n1', '批E 收尾')), '批E 收尾 · n1', '短身份时全名后跟全把手')
  assert.equal(nodeHover(aNode('f47ac10b-58cc-4372-a567-0e02b2c3d479', '批E 收尾')), '批E 收尾 · f47ac10b', '长身份时把手截到八字')
})
