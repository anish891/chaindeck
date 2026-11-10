// Manual live check of the Upstox Market Data Feed v3 WebSocket (needs network and UPSTOX_ACCESS_TOKEN; not part of
// `npm test`):
//
//   node scripts/check-upstox-stream.js [SYMBOL]
//
// Authorizes with the token, opens the feed, subscribes to the index (full), India VIX (ltpc) and one near-the-money
// option of the nearest expiry (full), then prints what arrives for a few seconds. It answers three questions:
//   1. does this token work on the feed (the Analytics Token page only says "Websocket")?
//   2. do the protobuf messages decode with the bundled MarketDataFeed.proto?
//   3. which fields does an option carry in `full` mode (OI, IV, greeks, depth)?
// Outside market hours the feed still sends the market status and one snapshot of the last values.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env.local'), quiet: true });
const protobuf = require('protobufjs');
const upstox = require('../api/services/providers/upstox');
const instruments = require('../api/services/providers/instruments');

const SYMBOL = (process.argv[2] || 'NIFTY').toUpperCase();
const LISTEN_MS = 8000;
const VIX_KEY = 'NSE_INDEX|India VIX';
const PROTO = path.join(__dirname, '../api/services/stream/MarketDataFeed.proto');

const frame = (method, mode, instrumentKeys) =>
  Buffer.from(JSON.stringify({ guid: `check-${Date.now()}-${method}-${mode}`, method, data: { mode, instrumentKeys } }));

(async () => {
  const cfg = instruments.getIndex(SYMBOL);
  const root = await protobuf.load(PROTO);
  const FeedResponse = root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');

  // One option to subscribe to: nearest expiry, strike closest to the middle of the listed range.
  const contracts = await upstox.get('/v2/option/contract', { instrument_key: cfg.underlyingKey });
  const nearest = contracts.map(c => c.expiry).sort()[0];
  const calls = contracts.filter(c => c.expiry === nearest && c.instrument_type === 'CE').sort((a, b) => a.strike_price - b.strike_price);
  const option = calls[Math.floor(calls.length / 2)];
  console.log(`contracts: ${contracts.length} listed, nearest expiry ${nearest} has ${calls.length} strikes; using ${option.trading_symbol}`);

  const auth = await upstox.get('/v3/feed/market-data-feed/authorize');
  if (!auth || !/^wss:\/\//.test(auth.authorized_redirect_uri || '')) throw new Error('authorize did not return a wss:// URL');
  console.log('authorize: ok (token accepted by the feed)');

  const ws = new WebSocket(auth.authorized_redirect_uri);
  ws.binaryType = 'arraybuffer';
  const seen = { messages: 0, types: {}, keys: new Map() };
  let marketInfo = null;

  ws.addEventListener('open', () => {
    console.log('socket: open');
    ws.send(frame('sub', 'full', [cfg.underlyingKey, option.instrument_key]));
    ws.send(frame('sub', 'ltpc', [VIX_KEY]));
  });
  ws.addEventListener('message', ev => {
    if (typeof ev.data === 'string') { console.log('text frame:', ev.data.slice(0, 200)); return; }
    const msg = FeedResponse.toObject(FeedResponse.decode(new Uint8Array(ev.data)), { longs: Number, enums: String, defaults: false });
    seen.messages += 1;
    seen.types[msg.type || 'initial_feed'] = (seen.types[msg.type || 'initial_feed'] || 0) + 1;
    if (msg.marketInfo) marketInfo = msg.marketInfo;
    for (const [key, feed] of Object.entries(msg.feeds || {})) seen.keys.set(key, feed);
  });
  ws.addEventListener('error', ev => console.error('socket error:', (ev && ev.message) || 'unknown'));
  ws.addEventListener('close', ev => console.log(`socket: closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})`));

  await new Promise(r => setTimeout(r, LISTEN_MS));
  ws.close(1000);

  console.log(`\nmessages: ${seen.messages}`, seen.types);
  if (marketInfo) console.log('segment status:', marketInfo.segmentStatus);
  for (const [key, feed] of seen.keys) console.log(`\n${key}\n${JSON.stringify(feed, null, 1)}`);
  if (!seen.keys.size) { console.error('\nNo feed data arrived.'); process.exitCode = 1; }
})().catch(err => {
  console.error(`FAILED: ${err.code || ''} ${err.message}`);
  process.exitCode = 1;
});
