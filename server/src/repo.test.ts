/**
 * An installed copy's settings and data must never be committed: git would overwrite every school's config.env
 * and database on the next update (the update script refuses such a version, but this catches it earlier).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('config.env, logs/ and server/data/ are not tracked by git', (t) => {
  const result = spawnSync('git', ['ls-files', '--', 'config.env', 'logs', 'server/data'], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    t.skip('not a git checkout');
    return;
  }
  assert.equal(result.stdout.trim(), '', 'remove these from git (git rm --cached) instead of committing them');
});
