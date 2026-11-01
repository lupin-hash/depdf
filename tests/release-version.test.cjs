const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chooseVersion } = require('../.github/scripts/release-version.cjs');
const tag = (name, commit = 'previous') => ({ name, commit });
const choose = options => chooseVersion({ packageVersion: '1.0.0', commit: 'current', ...options });

test('first release uses the package version', () => assert.deepEqual(choose({}), { version: '1.0.0', tag: 'v1.0.0' }));
test('ordinary commit bumps the latest patch', () => assert.deepEqual(choose({ tags: [tag('v1.0.6')] }), { version: '1.0.7', tag: 'v1.0.7' }));
test('tag ordering is numeric, not alphabetical', () => assert.equal(choose({ tags: [tag('v1.0.9'), tag('v1.0.10')] }).version, '1.0.11'));
test('a newer package version sets the exact next release', () => assert.deepEqual(choose({ packageVersion: '1.0.6', tags: [tag('v1.0.5')] }), { version: '1.0.6', tag: 'v1.0.6' }));
test('manual workflow version is used exactly', () => assert.deepEqual(choose({ requested: '1.0.6', tags: [tag('v1.0.3')] }), { version: '1.0.6', tag: 'v1.0.6' }));
test('a tag already on this commit is reused without another bump', () => assert.deepEqual(choose({ tags: [tag('v1.0.6', 'current')] }), { version: '1.0.6', tag: 'v1.0.6' }));
test('unprefixed version tags are preserved', () => assert.deepEqual(choose({ tags: [tag('1.0.6', 'current')] }), { version: '1.0.6', tag: '1.0.6' }));
test('annotated/prefixed and unprefixed aliases cannot retag another commit', () => assert.throws(() => choose({ requested: 'v1.0.6', tags: [tag('1.0.6')] }), /already tags another commit/));
test('requested versions cannot go backwards on a new release', () => assert.throws(() => choose({ requested: '1.0.5', tags: [tag('v1.0.6')] }), /older/));
test('retrying an older tagged commit reuses its version after a newer release', () => assert.equal(choose({ tags: [tag('v1.0.6', 'current'), tag('v1.0.7', 'newer')] }).version, '1.0.6'));
test('non-release tags are ignored', () => assert.equal(choose({ tags: [tag('archive'), tag('v1.0.5-beta'), tag('v1.0.5')] }).version, '1.0.6'));
test('malformed and unsafe inputs are rejected', () => {
  for (const requested of ['1.0', '1.00.6', '1.0.6\nother=value', '1.0.6; echo secret', '1.0.6-beta', '9007199254740992.0.0']) assert.throws(() => choose({ requested }));
});
test('CLI reads real annotated tags and writes GitHub outputs without changing the checkout', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'depdf-version-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Version test'); git('config', 'user.email', 'version-test@example.invalid');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"version":"1.0.0"}\n');
  git('add', 'package.json'); git('commit', '-qm', 'Initial'); git('tag', '-a', 'v1.0.6', '-m', 'Version 1.0.6');
  git('commit', '--allow-empty', '-qm', 'Next change');
  const output = path.join(cwd, '.git', 'github-output');
  const script = path.resolve(__dirname, '../.github/scripts/release-version.cjs');
  const run = requested => {
    fs.writeFileSync(output, '');
    execFileSync(process.execPath, [script], { cwd, env: { ...process.env, GITHUB_OUTPUT: output, RELEASE_VERSION: requested } });
    return fs.readFileSync(output, 'utf8');
  };
  assert.equal(run(''), 'version=1.0.7\ntag=v1.0.7\n');
  assert.equal(run('1.1.0'), 'version=1.1.0\ntag=v1.1.0\n');
  git('tag', '1.0.7');
  assert.equal(run(''), 'version=1.0.7\ntag=1.0.7\n');
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('tag', '--list'), '1.0.7\nv1.0.6');
});
