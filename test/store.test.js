'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Store } = require('../src/store');

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pocket-photos-store-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('store recovers from an invalid primary database using the interrupted-write file', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'db.json');
    const recovered = { version: 1, items: { photo: { id: 'photo' } }, albums: [] };
    await fs.writeFile(file, 'null');
    await fs.writeFile(file + '.tmp', JSON.stringify(recovered));

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const store = new Store(file);
      store.load();

      assert.equal(store.data.items.photo.id, 'photo');
      assert.equal(Object.getPrototypeOf(store.data.items), null);
      assert.equal(Object.getPrototypeOf(store.data.albums), null);
      assert.equal(warnings.length, 1);
      await store.close();
    } finally {
      console.warn = originalWarn;
    }
  });
});

test('store retries a flush after an earlier write failure', async () => {
  await withTempDir(async (dir) => {
    const nested = path.join(dir, 'not-created');
    const file = path.join(nested, 'db.json');
    const store = new Store(file);
    store.data.items.photo = { id: 'photo' };

    await assert.rejects(store.flush(), { code: 'ENOENT' });
    await fs.mkdir(nested);
    store.data.items.photo.title = 'Recovered';
    await store.flush();

    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.items.photo.title, 'Recovered');
    assert.equal(await fs.access(file + '.tmp').then(() => true, () => false), false);
  });
});

test('store close cancels the debounce timer and persists pending changes', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'db.json');
    const store = new Store(file);
    store.data.users.alice = { id: 'alice' };
    store.save();

    await store.close();

    assert.equal(store.timer, null);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).users, { alice: { id: 'alice' } });
  });
});
