'use strict';
const nodeFs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

// The one atomic-write primitive in the project.
//
// Four near-copies of this used to exist — runtime/paths.mjs, desktop/main.cjs,
// desktop/ui-state-store.cjs and lib/resource-store.mjs — with different
// durability, so which guarantee you got depended on which file you happened to
// write. This one keeps the strongest behaviour of each: an exclusive temporary
// file, an fsync before the rename, and the retry that Windows needs when an
// indexer or antivirus briefly holds the target.
//
// It lives in lib/ because that is the bottom of the dependency order: runtime/,
// desktop/ and the rest of lib/ all already depend on it. It must stay
// dependency-free so that remains true.
//
// CommonJS on purpose: desktop/main.cjs and desktop/ui-state-store.cjs are
// CommonJS and need a synchronous primitive, and runtime/lib ESM modules load it
// through createRequire.

// Three immediate tries, matching what the previous runtime/paths.mjs did and
// what tests/paths-atomic.test.mjs asserts. A sharing violation this transient
// clears on its own; anything longer is a real problem worth surfacing.
const RENAME_RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES'];
const RENAME_ATTEMPTS = 3;

function temporaryPathFor(file) {
  return file + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
}

function atomicWriteSync(file, bytes, { fs = nodeFs, mkdir = true } = {}) {
  if (mkdir) fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = temporaryPathFor(file);
  let descriptor, created = false;
  try {
    descriptor = fs.openSync(temp, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // The target is never deleted: a failed replacement leaves the previous
    // complete file in place.
    for (let attempt = 1; ; attempt++) {
      try { fs.renameSync(temp, file); return; }
      catch (error) {
        if (attempt >= RENAME_ATTEMPTS || !RENAME_RETRY_CODES.includes(error.code)) throw error;
      }
    }
  } catch (error) {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
    if (created) { try { fs.unlinkSync(temp); } catch {} }
    throw error;
  }
}

function writeJsonSync(file, data, options = {}) {
  atomicWriteSync(file, JSON.stringify(data, null, 2), options);
}

module.exports = { atomicWriteSync, writeJsonSync, temporaryPathFor, RENAME_RETRY_CODES, RENAME_ATTEMPTS };
