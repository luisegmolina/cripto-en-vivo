// Servidor Cripto en Vivo — Node + Express (JavaScript simple, sin TypeScript)
// Idea clave: el NAVEGADOR nunca llama directo a Coinbase/Kraken/Binance.
// Es este servidor (en localhost:3001) el que llama a los exchanges y le
// devuelve al frontend un JSON limpio. Así se evita el "Failed to fetch"
// que salía en el teléfono de Luis con la página estática.
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

const ASSETS = [
  { symbol: 'BTC', name: 'Bitcoin',   coingecko: 'bitcoin',  kraken: 'XBT',  binance: 'BTC' },
  { symbol: 'ETH', name: 'Ethereum',  coingecko: 'ethereum', kraken: 'ETH',  binance: 'ETH' },
  { symbol: 'SOL', name: 'Solana',    coingecko: 'solana',   kraken: 'SOL',  binance: 'SOL' },
  { symbol: 'XRP', name: 'XRP',       coingecko: 'ripple',   kraken: 'XRP',  binance: 'XRP' },
  { symbol: 'ADA', name: 'Cardano',   coingecko: 'cardano',  kraken: 'ADA',  binance: 'ADA' },
  { symbol: 'DOGE', name: 'Dogecoin', coingecko: 'dogecoin', kraken: 'DOGE', binance: 'DOGE' },
  { symbol: 'AVAX', name: 'Avalanche',coingecko: 'avalanche-2', kraken: 'AVAX', binance: 'AVAX' },
  { symbol: 'LINK', name: 'Chainlink',coingecko: 'chainlink',kraken: 'LINK', binance: 'LINK' },
  { symbol: 'LTC', name: 'Litecoin',  coingecko: 'litecoin', kraken: 'LTC',  binance: 'LTC' },
  { symbol: 'DOT', name: 'Polkadot',  coingecko: 'polkadot', kraken: 'DOT',  binance: 'DOT' },
];
const assetOf = (s) => ASSETS.find((a) => a.symbol === s.toUpperCase());
const CURRENCIES = ['USD', 'EUR', 'GBP'];
const normCurrency = (c) => CURRENCIES.includes(String(c || '').toUpperCase()) ? String(c).toUpperCase() : 'USD';

// ---- util: fetch con timeout de 5 s ----
async function fetchJSON(url, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'cripto-en-vivo/1.0' } });
    if (!r.ok) { const e = new Error(`HTTP ${r.status} en ${url}`); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---- Backoff para 429 (límite de la API) + anti-spam de logs ----
// Si una fuente devuelve 429, no se reintenta durante 60 s. Se loguea la
// primera vez y luego solo cuando se recupera (o 1 vez por minuto para
// otros errores). Sin esto, CoinGecko 429 se logueaba cada 5 s en bucle.
const cooldownUntil = new Map(); // fuente -> timestamp ms hasta el que no se reintenta
const rateLimitedSources = new Set(); // fuentes que están/estuvieron en 429
const lastFailLogAt = new Map(); // "fuente|qué" -> timestamp del último log
function isCoolingDown(name) { return (cooldownUntil.get(name) || 0) > Date.now(); }
function cooldownLeftSec(name) { return Math.max(0, Math.ceil(((cooldownUntil.get(name) || 0) - Date.now()) / 1000)); }
function isRateLimit(err) { return !!err && (err.status === 429 || /429/.test(String(err.message || ''))); }
function noteRateLimit(name, err) {
  if (!isRateLimit(err)) return false;
  if (!isCoolingDown(name)) {
    cooldownUntil.set(name, Date.now() + 60000);
    rateLimitedSources.add(name);
    const hora = new Date().toLocaleTimeString('es-US', { hour12: false });
    console.log(`[${hora}] ⏸️ ${name} devolvió 429 (límite): pausa 60 s, no se reintentará hasta que pase.`);
  }
  return true;
}
function markSuccess(name) {
  if (rateLimitedSources.has(name)) {
    rateLimitedSources.delete(name);
    cooldownUntil.delete(name);
    const hora = new Date().toLocaleTimeString('es-US', { hour12: false });
    console.log(`[${hora}] ✅ ${name} se recuperó (ya no devuelve 429).`);
  }
}

// Log con hora cada vez que una fuente falla, para verlo en la terminal de npm run dev.
// - 429: solo la primera vez (noteRateLimit), luego silencio 60 s.
// - Otros errores: como mucho 1 vez por minuto por fuente+qué.
function logSourceFail(source, what, err) {
  if (isRateLimit(err)) { noteRateLimit(source, err); return; }
  const key = `${source}|${what}`;
  const now = Date.now();
  if ((lastFailLogAt.get(key) || 0) > now - 60000) return;
  lastFailLogAt.set(key, now);
  const hora = new Date().toLocaleTimeString('es-US', { hour12: false });
  console.log(`[${hora}] ⚠️ ${source} falló (${what}): ${err && err.message ? err.message : err}`);
}

// ---- cache en memoria: 2 s ticker, 15 s markets, 5 s velas ----
const cache = new Map();
function getCache(key, ttlMs) {
  const e = cache.get(key);
  if (e && Date.now() - e.at < ttlMs) return e.data;
  return null;
}
function setCache(key, data) { cache.set(key, { at: Date.now(), data }); }

// ---- Fuentes: ticker (precio + 24h) ----
// Cada función devuelve {price, open24h, high24h, low24h, volume24h, change24h} o lanza.
async function tickerCoinbase(asset, cur) {
  const pair = `${asset.symbol}-${cur}`;
  // BUG CORREGIDO: antes ticker y stats iban en un Promise.all; si stats
  // fallaba, se perdía el precio aunque el ticker sí había respondido.
  // Ahora el precio manda: stats es opcional, si falla se usan nulls.
  const t = await fetchJSON(`https://api.exchange.coinbase.com/products/${pair}/ticker`);
  const price = Number(t.price);
  if (!price) throw new Error('Coinbase sin precio');
  let s = null;
  try {
    s = await fetchJSON(`https://api.exchange.coinbase.com/products/${pair}/stats`);
  } catch (e) {
    logSourceFail('Coinbase stats', pair, e);
    s = null;
  }
  const open = s ? Number(s.open) : null;
  return {
    price,
    open24h: open || null,
    high24h: s ? Number(s.high) || null : null,
    low24h: s ? Number(s.low) || null : null,
    volume24h: s ? Number(s.volume) || null : null,
    change24h: open ? ((price - open) / open) * 100 : null,
  };
}
async function tickerKraken(asset, cur) {
  // Kraken: XBT en vez de BTC; par tipo XXBTZUSD / XETHZEUR
  const base = asset.kraken === 'XBT' ? 'XXBT' : 'X' + asset.kraken;
  const pair = base + 'Z' + cur;
  const j = await fetchJSON(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
  const k = Object.keys(j.result || {})[0];
  if (!k) throw new Error('Kraken sin par');
  const r = j.result[k];
  const price = Number(r.c[0]);
  if (!price) throw new Error('Kraken sin precio');
  return { price, open24h: Number(r.o), high24h: Number(r.h[1]), low24h: Number(r.l[1]), volume24h: Number(r.v[1]), change24h: r.o ? ((price - Number(r.o)) / Number(r.o)) * 100 : null };
}
async function tickerBinanceUS(asset) {
  // Binance US solo cotiza en USDT (equivale a USD). Solo se usa con USD.
  const j = await fetchJSON(`https://api.binance.us/api/v3/ticker/24hr?symbol=${asset.binance}USDT`);
  const price = Number(j.lastPrice);
  if (!price) throw new Error('Binance US sin precio');
  return { price, open24h: Number(j.openPrice), high24h: Number(j.highPrice), low24h: Number(j.lowPrice), volume24h: Number(j.volume), change24h: Number(j.priceChangePercent) };
}
async function tickerCoinGecko(asset, cur) {
  const j = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${asset.coingecko}&vs_currencies=${cur.toLowerCase()}&include_24hr_change=true&include_24hr_vol=true&include_24hr_high_low=true`);
  const d = j[asset.coingecko];
  const price = Number(d && d[cur.toLowerCase()]);
  if (!price) throw new Error('CoinGecko sin precio');
  return { price, open24h: null, high24h: Number(d[`${cur.toLowerCase()}_24h_high`]) || null, low24h: Number(d[`${cur.toLowerCase()}_24h_low`]) || null, volume24h: Number(d[`${cur.toLowerCase()}_24h_vol`]) || null, change24h: Number(d[`${cur.toLowerCase()}_24h_change`]) || null };
}
async function getTicker(asset, cur) {
  const key = `ticker:${asset.symbol}:${cur}`;
  const hit = getCache(key, 2000);
  if (hit) return hit;
  const chain = [
    ['Coinbase', () => tickerCoinbase(asset, cur)],
    ['Kraken', () => tickerKraken(asset, cur)],
    ...(cur === 'USD' ? [['Binance US', () => tickerBinanceUS(asset)]] : []),
    ['CoinGecko', () => tickerCoinGecko(asset, cur)],
  ];
  const errors = [];
  for (const [name, fn] of chain) {
    if (isCoolingDown(name)) { errors.push(`${name}: en pausa por 429 (${cooldownLeftSec(name)} s restantes)`); continue; }
    try {
      const d = await fn();
      markSuccess(name);
      const out = { symbol: asset.symbol, name: asset.name, currency: cur, source: name, updatedAt: new Date().toISOString(), ...d };
      setCache(key, out);
      return out;
    } catch (e) { logSourceFail(name, `ticker ${asset.symbol}-${cur}`, e); errors.push(`${name}: ${e.message}`); }
  }
  const err = new Error('Todas las fuentes fallaron: ' + errors.join(' | '));
  err.sources = errors;
  throw err;
}

// ---- Markets: primaria Kraken batch (1 sola llamada para los 10) ----
// Kraken acepta varios pares en una sola petición Ticker y no tiene el
// límite bajo de CoinGecko gratis (5-15 llamadas/min). Por eso CoinGecko
// YA NO es la vía primaria de markets: solo queda como ÚLTIMO recurso.
// Pares verificados con curl (los nombres de Kraken son inconsistentes:
// DOGE es XDG, XRP es XXRP, LTC en EUR se pide LTCEUR pero responde
// XLTCZEUR, y AVAX NO tiene par en GBP — ese hueco lo cubre Coinbase).
// Formato por activo: [par que se pide, clave con la que responde].
const KRAKEN_PAIR = {
  USD: {
    BTC: ['XXBTZUSD', 'XXBTZUSD'], ETH: ['XETHZUSD', 'XETHZUSD'],
    SOL: ['SOLUSD', 'SOLUSD'],     XRP: ['XXRPZUSD', 'XXRPZUSD'],
    ADA: ['ADAUSD', 'ADAUSD'],     DOGE: ['XDGUSD', 'XDGUSD'],
    AVAX: ['AVAXUSD', 'AVAXUSD'],  LINK: ['LINKUSD', 'LINKUSD'],
    LTC: ['XLTCZUSD', 'XLTCZUSD'], DOT: ['DOTUSD', 'DOTUSD'],
  },
  EUR: {
    BTC: ['XXBTZEUR', 'XXBTZEUR'], ETH: ['XETHZEUR', 'XETHZEUR'],
    SOL: ['SOLEUR', 'SOLEUR'],     XRP: ['XXRPZEUR', 'XXRPZEUR'],
    ADA: ['ADAEUR', 'ADAEUR'],     DOGE: ['XDGEUR', 'XDGEUR'],
    AVAX: ['AVAXEUR', 'AVAXEUR'],  LINK: ['LINKEUR', 'LINKEUR'],
    LTC: ['LTCEUR', 'XLTCZEUR'],   DOT: ['DOTEUR', 'DOTEUR'],
  },
  GBP: {
    BTC: ['XXBTZGBP', 'XXBTZGBP'], ETH: ['XETHZGBP', 'XETHZGBP'],
    SOL: ['SOLGBP', 'SOLGBP'],     XRP: ['XRPGBP', 'XRPGBP'],
    ADA: ['ADAGBP', 'ADAGBP'],     DOGE: ['XDGGBP', 'XDGGBP'],
    AVAX: [null, null],            LINK: ['LINKGBP', 'LINKGBP'],
    LTC: ['LTCGBP', 'LTCGBP'],     DOT: ['DOTGBP', 'DOTGBP'],
  },
};
async function marketsKrakenBatch(cur) {
  if (isCoolingDown('Kraken')) throw new Error(`Kraken en pausa por 429 (${cooldownLeftSec('Kraken')} s restantes)`);
  const table = KRAKEN_PAIR[cur];
  const pairs = ASSETS.map((a) => table[a.symbol][0]).filter(Boolean);
  const j = await fetchJSON(`https://api.kraken.com/0/public/Ticker?pair=${pairs.join(',')}`);
  if (j.error && j.error.length) throw new Error('Kraken: ' + j.error.join(', '));
  const result = j.result || {};
  return ASSETS.map((a) => {
    const key = table[a.symbol][1];
    const r = key ? result[key] : null;
    if (!r) return null;
    const price = Number(r.c[0]);
    if (!price) return null;
    const open = Number(r.o);
    return {
      symbol: a.symbol, name: a.name, currency: cur, source: 'Kraken (batch)',
      updatedAt: new Date().toISOString(), price,
      open24h: open || null,
      high24h: Number(r.h[1]) || null,
      low24h: Number(r.l[1]) || null,
      volume24h: Number(r.v[1]) || null,
      change24h: open ? ((price - open) / open) * 100 : null,
    };
  });
}
// Fallback de markets: los 10 tickers de Coinbase EN PARALELO (límite alto).
async function marketsCoinbaseParallel(cur) {
  if (isCoolingDown('Coinbase')) throw new Error(`Coinbase en pausa por 429 (${cooldownLeftSec('Coinbase')} s restantes)`);
  const settled = await Promise.allSettled(ASSETS.map((a) => tickerCoinbase(a, cur)));
  return settled.map((r, i) => {
    if (r.status !== 'fulfilled') return null;
    return { ...r.value, symbol: ASSETS[i].symbol, name: ASSETS[i].name, currency: cur, source: 'Coinbase', updatedAt: new Date().toISOString() };
  });
}
// CoinGecko batch: SOLO ÚLTIMO recurso para markets (límite gratis bajo:
// 5-15 llamadas/min por IP; si devuelve 429 entra en pausa de 60 s).
async function marketsCoinGeckoBatch(cur) {
  if (isCoolingDown('CoinGecko')) throw new Error(`CoinGecko en pausa por 429 (${cooldownLeftSec('CoinGecko')} s restantes)`);
  const ids = ASSETS.map((a) => a.coingecko).join(',');
  const lc = cur.toLowerCase();
  const j = await fetchJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${lc}&include_24hr_change=true&include_24hr_vol=true&include_24hr_high_low=true`);
  return ASSETS.map((a) => {
    const d = j[a.coingecko];
    const price = Number(d && d[lc]);
    if (!price) return null;
    return {
      symbol: a.symbol, name: a.name, currency: cur, source: 'CoinGecko (batch)',
      updatedAt: new Date().toISOString(), price,
      open24h: null,
      high24h: Number(d[`${lc}_24h_high`]) || null,
      low24h: Number(d[`${lc}_24h_low`]) || null,
      volume24h: Number(d[`${lc}_24h_vol`]) || null,
      change24h: Number(d[`${lc}_24h_change`]) || null,
    };
  });
}

// ---- Fuentes: velas OHLC ----
const GRAN = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 };
async function candlesCoinbase(asset, cur, interval) {
  const pair = `${asset.symbol}-${cur}`;
  const j = await fetchJSON(`https://api.exchange.coinbase.com/products/${pair}/candles?granularity=${GRAN[interval]}`);
  if (!Array.isArray(j) || !j.length) throw new Error('Coinbase sin velas');
  // Coinbase: [time, low, high, open, close, volume], orden descendente -> subir a ascendente
  return j.slice().reverse().map((c) => ({ time: c[0], open: c[3], high: c[2], low: c[1], close: c[4], volume: c[5] }));
}
async function candlesBinanceUS(asset, interval) {
  const map = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '6h': '6h', '1d': '1d' };
  const j = await fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${asset.binance}USDT&interval=${map[interval]}&limit=200`);
  if (!Array.isArray(j) || !j.length) throw new Error('Binance US sin velas');
  return j.map((c) => ({ time: Math.floor(c[0] / 1000), open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] }));
}
async function candlesKraken(asset, cur, interval) {
  const minutes = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '6h': 240, '1d': 1440 }[interval]; // Kraken no tiene 6h: se usa 4h (240)
  const base = asset.kraken === 'XBT' ? 'XXBT' : 'X' + asset.kraken;
  const pair = base + 'Z' + cur;
  const j = await fetchJSON(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${minutes}`);
  const k = Object.keys(j.result || {}).find((x) => x !== 'last');
  const arr = j.result && j.result[k];
  if (!Array.isArray(arr) || !arr.length) throw new Error('Kraken sin velas');
  return arr.map((c) => ({ time: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[6] }));
}
async function candlesCoinGecko(asset, cur, interval) {
  const days = interval === '1d' ? 30 : interval === '6h' ? 7 : interval === '1h' ? 7 : 2;
  const j = await fetchJSON(`https://api.coingecko.com/api/v3/coins/${asset.coingecko}/ohlc?vs_currency=${cur.toLowerCase()}&days=${days}`);
  if (!Array.isArray(j) || !j.length) throw new Error('CoinGecko sin velas');
  // CoinGecko: [time_ms, open, high, low, close] — sin volumen
  return j.map((c) => ({ time: Math.floor(c[0] / 1000), open: c[1], high: c[2], low: c[3], close: c[4], volume: 0 }));
}
async function getCandles(asset, cur, interval) {
  const key = `candles:${asset.symbol}:${cur}:${interval}`;
  const hit = getCache(key, 5000);
  if (hit) return hit;
  const chain = [
    ['Coinbase', () => candlesCoinbase(asset, cur, interval)],
    ...(cur === 'USD' ? [['Binance US', () => candlesBinanceUS(asset, interval)]] : []),
    ['Kraken', () => candlesKraken(asset, cur, interval)],
    ['CoinGecko', () => candlesCoinGecko(asset, cur, interval)],
  ];
  const errors = [];
  for (const [name, fn] of chain) {
    if (isCoolingDown(name)) { errors.push(`${name}: en pausa por 429 (${cooldownLeftSec(name)} s restantes)`); continue; }
    try {
      const candles = await fn();
      markSuccess(name);
      const out = { symbol: asset.symbol, currency: cur, interval, source: name, updatedAt: new Date().toISOString(), candles };
      setCache(key, out);
      return out;
    } catch (e) { logSourceFail(name, `velas ${asset.symbol}-${cur} ${interval}`, e); errors.push(`${name}: ${e.message}`); }
  }
  throw new Error('Todas las fuentes de velas fallaron: ' + errors.join(' | '));
}

// ---- Rutas ----
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'cripto-en-vivo-server', time: new Date().toISOString(), port: PORT }));
// ---- Diagnóstico: prueba cada fuente para BTC/USD y dice cuál funciona ----
// Luis puede abrir http://localhost:3001/api/debug en el navegador.
app.get('/api/debug', async (req, res) => {
  const cur = normCurrency(req.query.currency);
  const asset = assetOf(req.query.symbol || 'BTC') || assetOf('BTC');
  const tests = [
    ['Coinbase', () => tickerCoinbase(asset, cur)],
    ['Kraken', () => tickerKraken(asset, cur)],
    ...(cur === 'USD' ? [['Binance US', () => tickerBinanceUS(asset)]] : []),
    ['CoinGecko', () => tickerCoinGecko(asset, cur)],
  ];
  const results = await Promise.allSettled(tests.map(async ([name, fn]) => {
    const t0 = Date.now();
    if (isCoolingDown(name)) return { name, ok: false, ms: Date.now() - t0, error: `En pausa por 429 (${cooldownLeftSec(name)} s restantes)` };
    try {
      const d = await fn();
      markSuccess(name);
      return { name, ok: true, ms: Date.now() - t0, price: d.price, source: name };
    } catch (e) {
      logSourceFail(name, `debug ${asset.symbol}-${cur}`, e);
      return { name, ok: false, ms: Date.now() - t0, error: String(e.message || e) };
    }
  }));
  res.json({
    ok: true, symbol: asset.symbol, currency: cur, time: new Date().toISOString(),
    sources: results.map((r) => r.value || { name: '?', ok: false, error: 'Error interno del test' }),
  });
});
app.get('/api/markets', async (req, res) => {
  const cur = normCurrency(req.query.currency);
  const key = `markets:${cur}`;
  const hit = getCache(key, 15000); // caché 15 s: el cliente sondea cada 10 s, así la mayoría de polls salen de caché y no queman APIs
  if (hit) return res.json(hit);
  try {
    // 1) Primaria: una sola llamada batch a Kraken para los 10 activos.
    let items = ASSETS.map(() => null);
    try {
      const batch = await marketsKrakenBatch(cur);
      markSuccess('Kraken');
      items = batch;
    } catch (e) { logSourceFail('Kraken (batch)', `markets ${cur}`, e); }
    // 2) Huecos: los 10 tickers de Coinbase en paralelo.
    let missing = ASSETS.filter((a, i) => !items[i]);
    if (missing.length) {
      try {
        const cb = await marketsCoinbaseParallel(cur);
        markSuccess('Coinbase');
        items = ASSETS.map((a, i) => items[i] || cb[i]);
      } catch (e) { logSourceFail('Coinbase', `markets ${cur}`, e); }
    }
    // 3) ÚLTIMO recurso: batch de CoinGecko (límite gratis bajo; si da
    // 429 entra en pausa de 60 s y se salta, no se reintenta en bucle).
    missing = ASSETS.filter((a, i) => !items[i]);
    if (missing.length) {
      try {
        const batch = await marketsCoinGeckoBatch(cur);
        markSuccess('CoinGecko');
        const bySymbol = {};
        batch.forEach((b) => { if (b) bySymbol[b.symbol] = b; });
        items = ASSETS.map((a, i) => items[i] || bySymbol[a.symbol] || null);
      } catch (e) { logSourceFail('CoinGecko (batch)', `markets ${cur}`, e); }
    }
    // 4) Lo que siga faltando: por activo en paralelo (respeta pausas 429).
    missing = ASSETS.filter((a, i) => !items[i]);
    if (missing.length) {
      const settled = await Promise.allSettled(missing.map((a) => getTicker(a, cur)));
      const bySymbol = {};
      settled.forEach((r, i) => {
        bySymbol[missing[i].symbol] = r.status === 'fulfilled' ? r.value
          : { symbol: missing[i].symbol, name: missing[i].name, currency: cur, source: null, updatedAt: new Date().toISOString(), price: null, error: String(r.reason && r.reason.message ? r.reason.message : r.reason) };
      });
      items = ASSETS.map((a, i) => items[i] || bySymbol[a.symbol]);
    }
    const out = { currency: cur, updatedAt: new Date().toISOString(), markets: items };
    setCache(key, out);
    res.json(out);
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});
app.get('/api/ticker', async (req, res) => {
  const a = assetOf(req.query.symbol || 'BTC');
  if (!a) return res.status(400).json({ error: 'Símbolo no válido. Usa BTC, ETH, SOL, XRP, ADA, DOGE, AVAX, LINK, LTC o DOT.' });
  try { res.json(await getTicker(a, normCurrency(req.query.currency))); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});
app.get('/api/candles', async (req, res) => {
  const a = assetOf(req.query.symbol || 'BTC');
  const interval = GRAN[req.query.interval] ? req.query.interval : '1m';
  if (!a) return res.status(400).json({ error: 'Símbolo no válido.' });
  try { res.json(await getCandles(a, normCurrency(req.query.currency), interval)); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// ---- En producción (Vercel), los archivos estáticos los sirve Vercel ----
// desde client/dist (outputDirectory). Solo en local (no Vercel) el
// servidor Express sirve client/dist, para que `npm start` funcione.
if (!process.env.VERCEL) {
  const dist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(dist, 'index.html'), (err) => { if (err) next(); });
  });
}

module.exports = app;
