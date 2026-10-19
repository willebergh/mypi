// Prepared source only; not executed as part of this change.
import assert from 'node:assert/strict';
import test from 'node:test';
const { selectTodoDisplay } = await import('../src/shared/todo-display.ts');
const todo = (id, completed = false, completedAt) => ({
  id, text: `Task ${id}`, completed, ...(completedAt === undefined ? {} : { completedAt }),
});
const ids = display => display.rows.map(row => row.id);

test('dashboard and minimal give pending tasks all available rows before history', () => {
  const items = [todo(1, true), todo(2, true), ...[3, 4, 5, 6, 7, 8].map(id => todo(id))];
  const dashboard = selectTodoDisplay(items, 5);
  assert.deepEqual(ids(dashboard), [3, 4, 5, 6, 7]);
  assert.deepEqual(dashboard.counts, { total: 8, pending: 6, completed: 2 });
  assert.deepEqual(dashboard.hidden, { pending: 1, completed: 2 });
  assert.deepEqual(ids(selectTodoDisplay(items, 3)), [3, 4, 5]);
});

test('pending selection uses ascending numeric IDs regardless of input order or timestamps', () => {
  const items = [todo(9), todo(2, true, 999), todo(6, false, 123), todo(3)];
  const display = selectTodoDisplay(items, 3);
  assert.deepEqual(ids(display), [3, 6, 9]);
  assert.deepEqual(display.rows.map(row => row.isNextPending), [true, false, false]);
  assert.equal(display.rows[0].completed, false);
  assert.equal(display.rows[1].completed, false, 'a timestamp does not mean completed');
  assert.equal(display.rows[0].label, '#3 Task 3');
  assert.deepEqual(ids(selectTodoDisplay(items, 2)), [3, 6]);
});

test('spare rows include only the highest-ID completion, ignoring timestamps', () => {
  const display = selectTodoDisplay([
    todo(1, true, 400), todo(2, true, 200), todo(3), todo(4, true, 300), todo(5, true, 100),
  ], 3);
  assert.deepEqual(ids(display), [3, 5]);
  assert.deepEqual(display.rows.map(row => row.completed), [false, true]);
  assert.deepEqual(display.counts, { total: 5, pending: 1, completed: 4 });
  assert.deepEqual(display.hidden, { pending: 0, completed: 3 });
});

test('all-complete and legacy data show only the highest ID, not the latest timestamp', () => {
  assert.deepEqual(ids(selectTodoDisplay([todo(3, true), todo(1, true), todo(2, true)], 2)), [3]);
  const items = [todo(1, true, 0), todo(2, true), todo(3, true, 0), todo(4, true)];
  const display = selectTodoDisplay(items, 2);
  assert.deepEqual(ids(display), [4]);
  assert.ok(display.rows.every(row => row.completed && !row.isNextPending));
  assert.deepEqual(ids(selectTodoDisplay(items, 1)), [4]);
});

test('full input keeps pending IDs beyond the old producer prefix and counts hidden history', () => {
  const items = Array.from({ length: 55 }, (_, index) => todo(index + 1, index < 48));
  const display = selectTodoDisplay(items, 5);
  assert.deepEqual(ids(display), [49, 50, 51, 52, 53]);
  assert.deepEqual(display.counts, { total: 55, pending: 7, completed: 48 });
  assert.deepEqual(display.hidden, { pending: 2, completed: 48 });
  assert.equal(selectTodoDisplay(items.slice(0, 48), 5).counts.pending, 0,
    'renderer cannot recover tasks already dropped by the producer');
});

test('selection uses the current full snapshot, not a cached first subset', () => {
  const before = [todo(1, true), todo(2), todo(3)];
  assert.deepEqual(ids(selectTodoDisplay(before, 2)), [2, 3]);
  const after = [todo(1, true), todo(2, true, 100), todo(3), todo(4)];
  assert.deepEqual(ids(selectTodoDisplay(after, 2)), [3, 4]);
  assert.deepEqual(selectTodoDisplay([], 2).counts, { total: 0, pending: 0, completed: 0 });
});

test('zero/large budgets keep truthful counts; invalid budgets are explicit errors', () => {
  const items = [todo(1), todo(2, true)];
  const display = selectTodoDisplay(items, 0);
  assert.deepEqual(display.rows, []);
  assert.deepEqual(display.counts, { total: 2, pending: 1, completed: 1 });
  assert.deepEqual(display.hidden, { pending: 1, completed: 1 });
  assert.deepEqual(ids(selectTodoDisplay(items, 100)), [1, 2]);
  for (const value of [-1, 1.5, NaN, Infinity, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => selectTodoDisplay(items, value), RangeError);
  }
});

test('selection never mutates tool state, rows are detached, and no fields are invented or leaked', () => {
  const items = Object.freeze([
    Object.freeze({ ...todo(1, true, 100), privateExtra: 'must not propagate' }),
    Object.freeze(todo(2)),
  ]);
  const display = selectTodoDisplay(items, 2);
  assert.deepEqual(ids(display), [1, 2]);
  assert.equal(display.rows[0].completedAt, 100);
  assert.equal(display.rows[1].completedAt, undefined);
  assert.equal(display.rows[0].privateExtra, undefined);
  assert.deepEqual(display.rows.map(row => row.isNextPending), [false, true]);
  assert.equal(display.rows[0].priority, undefined);
  display.rows[0].text = 'Detached';
  assert.equal(items[0].text, 'Task 1');
  assert.deepEqual(items.map(item => item.id), [1, 2]);
});
