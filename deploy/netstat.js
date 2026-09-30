#!/usr/bin/env node
/**
 * netstat.js — per-player netcode counters, printed as a table.
 *
 * Lives ON the VPS so the command you type has no nested quoting:
 *     ssh -i ~/.ssh/evio_vps gameserver@<host> "node netstat.js"
 *     ssh -i ~/.ssh/evio_vps gameserver@<host> "node netstat.js 10"   # sample twice, 10s apart
 *
 * idleSends is CUMULATIVE since the player joined, so the rate matters more than the value. Pass a
 * number of seconds to take two samples and report the per-second rate directly.
 *
 * What the columns mean:
 *   idleSends  packets the send-rate gate SKIPPED. Each skip gives that client a 100ms gap instead
 *              of 50ms, which is server-manufactured jitter. If this climbs, try rateMatchSends=off
 *              — it costs no latency, it only sends more often.
 *   queued     input batches waiting to be drained. Should sit at inputBufferDepth.
 *   lag        lastClientTick - processedClientTick: how far ahead the client is predicting.
 *   look/appl  fraction of the client's rotation that reached the sim (1.0 = nothing lost).
 *   simErrors  this player's sim threw and was contained. Should be 0.
 */
'use strict';

const http = require('http');
const PORT = process.env.EVIO_ADMIN_PORT || 8081;
const TOKEN = process.env.EVIO_ADMIN_TOKEN || '';

function fetchStatus() {
  return new Promise((resolve, reject) => {
    const headers = TOKEN ? { 'x-evio-admin-token': TOKEN } : {};
    http.get({ host: '127.0.0.1', port: PORT, path: '/api/status', headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function table(st, prev, secs) {
  console.log('\ntick ' + st.tickRate + '/' + st.targetTickRate + ' Hz'
    + '   players ' + st.playerCount
    + '   tickErrors ' + st.tickErrors + '   simErrors ' + st.simErrors);
  if (!st.players.length) return console.log('no players connected');

  const head = ['player', 'idleSends', prev ? '/sec' : '', 'queued', 'lag',
    'carried', prev ? 'carr/s' : '', 'look', 'appl', 'errs'].filter(Boolean);
  console.log('\n' + head.map((h, i) => h.padEnd(i === 0 ? 20 : 11)).join(''));
  for (const p of st.players) {
    const before = prev && prev.find((q) => q.sessionId === p.sessionId);
    const rate = before ? ((p.idleSends - before.idleSends) / secs).toFixed(2) : null;
    const lag = (p.lastClientTick != null && p.processedClientTick != null)
      ? (p.lastClientTick - p.processedClientTick) : '-';
    const carrRate = before ? ((p.lookCarried - before.lookCarried) / secs).toFixed(3) : null;
    const row = [
      String(p.name || p.sessionId).slice(0, 19),
      String(p.idleSends),
      ...(prev ? [String(rate)] : []),
      String(p.queuedInputs),
      String(lag),
      String(p.lookCarried ?? '-'),
      ...(prev ? [String(carrRate)] : []),
      p.lookKept == null ? '-' : String(p.lookKept),
      p.lookApplied == null ? '-' : String(p.lookApplied),
      String(p.simErrors),
    ];
    console.log(row.map((c, i) => c.padEnd(i === 0 ? 20 : 11)).join(''));
  }
  if (prev) {
    console.log('\nidleSends/sec near 0 -> the send gate is idle, nothing to gain.');
    console.log('climbing            -> sends are being skipped; try rateMatchSends=off (no latency cost).');
    console.log('carr/s near 0        -> inputBufferDepth 0 is free for this client.');
    console.log('carr/s significant   -> ticks are split across packets often; each carried frame');
    console.log('                        lands a tick late, and with reconcile ON that can correct.');
    console.log('                        Compare feel against inputBufferDepth 1.');
  }
}

(async () => {
  const secs = Number(process.argv[2]);
  try {
    const first = await fetchStatus();
    if (!Number.isFinite(secs) || secs <= 0) return table(first);
    console.log('sampling for ' + secs + 's ...');
    await new Promise((r) => setTimeout(r, secs * 1000));
    table(await fetchStatus(), first.players, secs);
  } catch (e) {
    console.error('could not read the admin API: ' + e.message);
    console.error('(is the server running? EVIO_ADMIN=0 disables the dashboard entirely)');
    process.exit(1);
  }
})();
