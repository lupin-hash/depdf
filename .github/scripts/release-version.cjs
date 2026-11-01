const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function parseVersion(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`Invalid version "${value}". Use MAJOR.MINOR.PATCH, such as 1.0.6.`);
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Version numbers are too large.');
  return parts;
}
const compare = (a, b) => {
  const x = parseVersion(a), y = parseVersion(b);
  return Math.sign(x[0] - y[0]) || Math.sign(x[1] - y[1]) || Math.sign(x[2] - y[2]);
};
const normalize = value => parseVersion(value).join('.');

function chooseVersion({ packageVersion, tags = [], commit, requested = '' }) {
  const base = normalize(packageVersion);
  const versions = tags.filter(t => /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(t.name));
  const ordered = [...versions].sort((a, b) => compare(b.name, a.name));
  const atHead = ordered.filter(t => t.commit === commit);
  let version;
  if (requested.trim()) version = normalize(requested.trim());
  else if (atHead.length) version = normalize(atHead[0].name);
  else if (!ordered.length || compare(base, ordered[0].name) > 0) version = base;
  else {
    const [major, minor, patch] = parseVersion(ordered[0].name);
    if (!Number.isSafeInteger(patch + 1)) throw new Error('Patch version is too large.');
    version = `${major}.${minor}.${patch + 1}`;
  }
  const matches = versions.filter(t => normalize(t.name) === version);
  if (matches.some(t => t.commit !== commit)) throw new Error(`Version ${version} already tags another commit. Choose a new version; existing tags are never moved.`);
  // A retry of an already tagged commit must reuse its version, even if newer
  // commits have since been released. An untagged release cannot go backwards.
  if (!matches.length && ordered.length && compare(version, ordered[0].name) < 0) throw new Error('The requested version is older than the latest version tag.');
  const tag = matches.find(t => t.name === `v${version}`)?.name || matches[0]?.name || `v${version}`;
  return { version, tag };
}

if (require.main === module) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD');
  const names = git('tag', '--list').split('\n').filter(name => /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(name));
  const tags = names.map(name => ({ name, commit: git('rev-parse', '--verify', `refs/tags/${name}^{commit}`) }));
  const result = chooseVersion({ packageVersion: JSON.parse(fs.readFileSync('package.json', 'utf8')).version, tags, commit, requested: process.env.RELEASE_VERSION || '' });
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\ntag=${result.tag}\n`);
  console.log(`App version: ${result.version}; release tag: ${result.tag}`);
}
module.exports = { chooseVersion };
