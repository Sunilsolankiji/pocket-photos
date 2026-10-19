'use strict';
const fs = require('fs');
const fsp = fs.promises;

/** Tiny JSON-file database with debounced, atomic (write-tmp + rename) saves. */
class Store {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, items: {}, albums: {}, users: {}, sessions: {}, settings: {} };
    this.timer = null;
    this.chain = Promise.resolve();
  }

  load() {
    for (const f of [this.file, this.file + '.tmp']) {
      try {
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        Object.assign(this.data, d);
        return;
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[store] could not read ${f}: ${e.message}`);
      }
    }
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((e) => console.error('[store] save failed:', e.message));
    }, 1000);
  }

  flush() {
    const json = JSON.stringify(this.data);
    this.chain = this.chain.then(async () => {
      const tmp = this.file + '.tmp';
      await fsp.writeFile(tmp, json);
      await fsp.rename(tmp, this.file);
    });
    return this.chain;
  }

  async close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}

module.exports = { Store };
