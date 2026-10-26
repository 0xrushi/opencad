import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redoTarget, undoTarget, type HistoryRow } from './cadHistory.ts';

let clock = 0;
const row = (id: string, parent: string | null, role: 'user' | 'assistant'): HistoryRow => ({
  id,
  parent_message_id: parent,
  role,
  created_at: String(++clock).padStart(4, '0'),
});
const isVersion = (r: HistoryRow) => r.role === 'assistant';

// u1 -> a1 -> u2 -> a2 -> u3 -> a3
const chain = [
  row('u1', null, 'user'),
  row('a1', 'u1', 'assistant'),
  row('u2', 'a1', 'user'),
  row('a2', 'u2', 'assistant'),
  row('u3', 'a2', 'user'),
  row('a3', 'u3', 'assistant'),
];

describe('undoTarget', () => {
  it('steps back one version at a time and stops at the first', () => {
    assert.equal(undoTarget(chain, 'a3', isVersion)?.id, 'a2');
    assert.equal(undoTarget(chain, 'a2', isVersion)?.id, 'a1');
    assert.equal(undoTarget(chain, 'a1', isVersion), null);
  });

  it('drops a trailing request that produced nothing', () => {
    const rows = [...chain, row('u4', 'a3', 'user')];
    assert.equal(undoTarget(rows, 'u4', isVersion)?.id, 'a3');
  });

  it('has nothing to undo with no versions', () => {
    assert.equal(undoTarget([row('x', null, 'user')], 'x', isVersion), null);
  });
});

describe('redoTarget', () => {
  it('moves forward through the saved versions', () => {
    assert.equal(redoTarget(chain, 'a1', isVersion)?.id, 'a2');
    assert.equal(redoTarget(chain, 'a2', isVersion)?.id, 'a3');
    assert.equal(redoTarget(chain, 'a3', isVersion), null);
  });

  it('prefers the newest branch after a new request following an undo', () => {
    const branched = [...chain, row('u5', 'a1', 'user'), row('a5', 'u5', 'assistant')];
    // From a1 the newest branch is a5, not a2.
    assert.equal(redoTarget(branched, 'a1', isVersion)?.id, 'a5');
    // On the new branch tip there is nothing to redo.
    assert.equal(redoTarget(branched, 'a5', isVersion), null);
  });

  it('skips a failed request that has no version', () => {
    const rows = [row('u1', null, 'user'), row('a1', 'u1', 'assistant'), row('uFail', 'a1', 'user')];
    assert.equal(redoTarget(rows, 'a1', isVersion), null);
  });
});
