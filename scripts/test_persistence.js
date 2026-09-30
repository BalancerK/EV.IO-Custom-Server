/**
 * test_persistence.js — settings survive a restart, and env still wins.
 *
 * WHY THIS EXISTS
 * ───────────────
 * deploy/sync.sh restarts the service on every deploy, so before this every knob tuned through the
 * dashboard — and the map chosen from the picker — silently reverted to defaults on the next push.
 * The tuning is the whole point of the dashboard, so losing it is worse than not having it.
 *
 * The three properties that matter, and each has a way of going wrong quietly:
 *
 *   1. env > file > default.  If the file won, a documented EVIO_* variable would stop meaning what
 *      it says, and a bad saved value could not be overridden without hand-editing the file.
 *   2. Only human-set keys are written.  Writing every key would freeze today's defaults into the
 *      file for ever, so improving a default would never reach an existing deployment.
 *   3. Saving one key must not drop the others.  The save rewrites the whole file from an in-memory
 *      set, so a key restored from disk has to be re-registered as saveable at load — otherwise the
 *      first change after a restart wipes every other saved setting.
 *
 * Persistence is normally OFF unless local_ws_server.js is the entry point (so the other 40 test
 * scripts cannot rewrite the operator's live config); EVIO_PERSIST_SETTINGS=1 forces it on here.
 * Each case runs in a CHILD PROCESS against a temp file, because "does it survive a restart" cannot
 * be answered inside one process — the registry is module state that only initialises once.
 *
 * Usage:  node scripts/test_persistence.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

const STORE = path.join(os.tmpdir(), `evio-settings-test-${process.pid}.json`);
const SERVER = path.join(__dirname, '..', 'local_ws_server.js');
const SETTINGS = path.join(__dirname, '..', 'settings.js');

// Load the registry in a child with persistence forced on, run a snippet, print JSON.
function inChild(snippet, env = {}) {
  const code = `
    process.env.EVIO_ADMIN = '0';
    const S = require(${JSON.stringify(SETTINGS)});
    require(${JSON.stringify(SERVER)});     // declares every setting
    const out = (() => { ${snippet} })();
    S.flush();
    process.stdout.write('@@' + JSON.stringify(out) + '@@');
    process.exit(0);
  `;
  const raw = execFileSync(process.execPath, ['-e', code], {
    env: {
      ...process.env,
      EVIO_PERSIST_SETTINGS: '1',
      EVIO_SETTINGS_FILE: STORE,
      EVIO_ADMIN: '0',
      ...env,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
  const m = raw.match(/@@([\s\S]*)@@/);
  if (!m) throw new Error('child produced no result:\n' + raw.slice(-500));
  return JSON.parse(m[1]);
}

const readStore = () => JSON.parse(fs.readFileSync(STORE, 'utf8'));
const clean = () => { try { fs.unlinkSync(STORE); } catch (_) {} };

clean();

console.log('\n── a change survives a restart ──');
{
  const first = inChild(`
    S.set('walkSpeed', 0.42, 'test');
    return { value: S.get('walkSpeed') };
  `);
  ok('the change applies in the running process', first.value === 0.42, String(first.value));
  ok('and reaches disk', fs.existsSync(STORE), STORE);

  const second = inChild(`return { value: S.get('walkSpeed') };`);
  ok('a fresh process starts with the saved value', second.value === 0.42,
    `${second.value} — this is the restart that used to lose it`);
}

console.log('\n── defaults are not frozen into the file ──');
{
  const saved = readStore().settings;
  const keys = Object.keys(saved);
  ok('only the key that was set is stored', keys.length === 1 && keys[0] === 'walkSpeed',
    `stored: ${keys.join(', ')}`);
  ok('the untouched keys are absent', !('tickRate' in saved),
    'writing every key would freeze today defaults into the deployment for ever');
}

console.log('\n── saving one key does not drop the others ──');
{
  // The regression this guards: a key restored from disk is in `values` but, unless it is also
  // re-registered as saveable, the next save rebuilds the file without it.
  const r = inChild(`
    S.set('maxPlayers', 7, 'test');
    return { walk: S.get('walkSpeed'), max: S.get('maxPlayers') };
  `);
  ok('both values are live', r.walk === 0.42 && r.max === 7, JSON.stringify(r));
  const saved = readStore().settings;
  ok('both survive the rewrite', saved.walkSpeed === 0.42 && saved.maxPlayers === 7,
    JSON.stringify(saved));
}

console.log('\n── env still wins ──');
{
  const r = inChild(`return { value: S.get('walkSpeed') };`, { EVIO_SIM_WALK_SPEED: '0.9' });
  ok('an env var overrides the saved value', r.value === 0.9,
    `${r.value} — a documented EVIO_* variable must always mean what it says`);
  // ...and must not be laundered into the file, or unsetting it later would change nothing.
  const saved = readStore().settings;
  ok('the env value is not written to the file', saved.walkSpeed === 0.42,
    `stored ${saved.walkSpeed} — env is a deployment override, not persistent state`);
}

console.log('\n── reset clears the saved value ──');
{
  const r = inChild(`
    S.reset('walkSpeed', 'test');
    return { value: S.get('walkSpeed'), stored: null };
  `);
  const saved = readStore().settings;
  ok('the key is dropped from the file', !('walkSpeed' in saved), JSON.stringify(saved));
  ok('the other key is untouched', saved.maxPlayers === 7, JSON.stringify(saved));
  const after = inChild(`return { value: S.get('walkSpeed') };`);
  ok('a restart now gets the default', after.value !== 0.42, String(after.value));
}

console.log('\n── a corrupt or hostile file cannot stop the server booting ──');
{
  fs.writeFileSync(STORE, '{ this is not json');
  const r = inChild(`return { value: S.get('walkSpeed'), ok: true };`);
  ok('unparseable JSON is survived', r.ok === true, 'the server must not die in a restart loop');

  // Out-of-range values are rejected by the same coercion as any other input; the registry's bounds
  // may well have tightened since the file was written.
  fs.writeFileSync(STORE, JSON.stringify({ settings: { maxPlayers: 999999, walkSpeed: 'abc' } }));
  const r2 = inChild(`return { max: S.get('maxPlayers'), walk: S.get('walkSpeed') };`);
  ok('an out-of-range saved value is ignored', r2.max !== 999999, String(r2.max));
  ok('a non-numeric saved value is ignored', Number.isFinite(r2.walk), String(r2.walk));
}

console.log('\n── the map is remembered too ──');
{
  clean();
  const r = inChild(`
    S.set('startupMap', 'Sanctuary', 'test');
    return { v: S.get('startupMap') };
  `);
  ok('startupMap is a real setting', r.v === 'Sanctuary', String(r.v));
  const after = inChild(`return { v: S.get('startupMap') };`);
  ok('and it survives a restart', after.v === 'Sanctuary', String(after.v));

  const src = fs.readFileSync(SERVER, 'utf8');
  ok('switchMap records the map it switched to',
    /S\.set\("startupMap", loaded\.map\.title/.test(src),
    'without this the picker changes the map but never remembers it');
  ok('the title is stored, not the caller argument',
    !/S\.set\("startupMap", idOrTitle/.test(src),
    'an id would have to resolve identically at next boot');
  // Checks ordering, not exact adjacency: startServer() may legitimately have other one-time
  // post-start calls beside it (e.g. reconcileBotCount() for a saved/env botCount) without
  // affecting the property this actually guards — that loadStartupMap's restore happens BEFORE
  // the socket (startServer) opens, not immediately before some specific following statement.
  const bootBlock = src.slice(src.indexOf('if (require.main === module)'));
  ok('the boot path restores it before the socket opens',
    bootBlock.indexOf('loadStartupMap') < bootBlock.indexOf('startServer();'),
    'restoring after would bootstrap the first players onto the wrong map');
  ok('a missing saved map does not stop the boot',
    /could not restore saved map/.test(src),
    'a delisted map would otherwise be a permanent restart loop');
}

console.log('\n── tests and scripts do not write to the real config ──');
{
  // The safety property behind all of this: `npm test` must never rewrite the operator live server.
  const r = execFileSync(process.execPath, ['-e', `
    process.env.EVIO_ADMIN = '0';
    const S = require(${JSON.stringify(SETTINGS)});
    process.stdout.write('@@' + JSON.stringify(S.persistenceStatus()) + '@@');
  `], { encoding: 'utf8', env: { ...process.env, EVIO_ADMIN: '0' } });
  const st = JSON.parse(r.match(/@@([\s\S]*)@@/)[1]);
  ok('persistence is off when the entry point is not the server', st.enabled === false,
    JSON.stringify(st) + ' — otherwise every test run would clobber the live config');
  ok('this very test process is not persisting',
    require('../settings').persistenceStatus().enabled === false);
}

console.log('\n── the deploy does not clobber the server own file ──');
{
  const sync = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'sync.sh'), 'utf8');
  ok('sync.sh protects settings.local.json', /KEEP_REMOTE=\(settings\.local\.json\)/.test(sync));
  ok('the rsync path excludes it', /KEEP_REMOTE\[@\]}"; do args\+=/.test(sync),
    '--delete would remove a remote file that is absent locally');
  ok('the tar path preserves it', /! -name \$\{f\}/.test(sync),
    'that path rm -rf s the remote directory before unpacking');
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  ok('it is gitignored', /settings\.local\.json/.test(ignore), 'it is per-deployment state');
}

clean();
console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
