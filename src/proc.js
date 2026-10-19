'use strict';
const { spawn } = require('child_process');

/** Concurrency-limited job queue with two priorities (interactive vs background). */
class Queue {
  constructor(concurrency) {
    this.n = Math.max(1, concurrency | 0);
    this.active = 0;
    this.hi = [];
    this.lo = [];
  }
  run(fn, priority = 'high') {
    return new Promise((resolve, reject) => {
      (priority === 'low' ? this.lo : this.hi).push({ fn, resolve, reject });
      this._next();
    });
  }
  _next() {
    while (this.active < this.n && (this.hi.length || this.lo.length)) {
      const job = this.hi.length ? this.hi.shift() : this.lo.shift();
      this.active++;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          this._next();
        });
    }
  }
  get size() {
    return this.hi.length + this.lo.length + this.active;
  }
}

function run(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return reject(e);
    }
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => {
      if (err.length < 8000) err += d;
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited with ${code}: ${err.trim().slice(-500)}`));
    });
  });
}

async function hasTool(cmd) {
  try {
    await run(cmd, ['-version'], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

module.exports = { Queue, run, hasTool };
