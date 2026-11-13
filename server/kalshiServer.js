// Cliente Kalshi SOLO LECTURA (v12).
// Kalshi es un mercado de predicciones regulado (CFTC). Su API v2:
//  - Datos públicos (mercados, precios): sin autenticación.
//  - Datos de cuenta (posiciones, saldo, operaciones): con API Key +
//    firma RSA-PSS o Ed25519 en cada petición (KALSHI-ACCESS-KEY,
//    KALSHI-ACCESS-SIGNATURE, KALSHI-ACCESS-TIMESTAMP).
// REGLA DURA: este módulo solo hace GET y solo a las rutas de la
// lista READ_ONLY_PATHS. No existe aquí ninguna llamada POST/PUT/
// DELETE a Kalshi, ni a /orders, ni a ningún endpoint de escritura.
// Si alguien añade una, las rutas del servidor la rechazan igual
// (ver routes.js: kalshiGet solo acepta GET + allowlist).
const crypto = require('crypto');

const BASE = (process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com').replace(/\/$/, '');
const READ_ONLY_PATHS = new Set([
  '/trade-api/v2/portfolio/positions',
  '/trade-api/v2/portfolio/balance',
  '/trade-api/v2/portfolio/fills',
]);

// Detecta el tipo de clave privada (Kalshi genera Ed25519 por
// defecto desde oct-2026; RSA sigue existiendo para claves viejas).
function parsePrivateKey(pem) {
  const text = String(pem || '').trim();
  if (!text.includes('PRIVATE KEY')) throw new Error('La clave privada no parece un archivo .pem válido (falta "PRIVATE KEY").');
  let key;
  try { key = crypto.createPrivateKey(text); } catch { throw new Error('La clave privada .pem no se pudo leer. Revisa que copiaste el archivo completo.'); }
  if (key.asymmetricKeyType === 'ed25519') return { key, type: 'ed25519' };
  if (key.asymmetricKeyType === 'rsa') return { key, type: 'rsa' };
  throw new Error(`Tipo de clave no soportado: ${key.asymmetricKeyType}. Kalshi usa Ed25519 o RSA.`);
}

function signHeaders({ keyId, privateKeyPem, method, path }) {
  const { key, type } = parsePrivateKey(privateKeyPem);
  const timestamp = String(Date.now());
  // La firma es sobre timestamp + MÉTODO + ruta (sin query string).
  const message = timestamp + method.toUpperCase() + path;
  let signature;
  if (type === 'ed25519') {
    signature = crypto.sign(null, Buffer.from(message, 'utf8'), key);
  } else {
    signature = crypto.sign('sha256', Buffer.from(message, 'utf8'), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
  }
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
  };
}

// GET autenticado a Kalshi. Solo rutas de la allowlist, solo GET.
async function kalshiGet(path, { keyId, privateKeyPem }) {
  if (!READ_ONLY_PATHS.has(path)) throw new Error(`Ruta de Kalshi no permitida (solo lectura): ${path}`);
  const headers = signHeaders({ keyId, privateKeyPem, method: 'GET', path });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(BASE + path, { signal: ctrl.signal, headers: { Accept: 'application/json', ...headers } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(j.message || j.error || `Kalshi HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return j;
  } finally { clearTimeout(t); }
}

async function fetchJSONPublic(url, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Precio actual de un contrato (público, sin auth): yes_bid/yes_ask.
const marketCache = new Map();
async function marketPrice(ticker) {
  const hit = marketCache.get(ticker);
  if (hit && Date.now() - hit.at < 10000) return hit.data;
  try {
    const j = await fetchJSONPublic(`${BASE}/trade-api/v2/markets/${encodeURIComponent(ticker)}`);
    const m = j.market || j;
    const data = { yesBid: m.yes_bid != null ? Number(m.yes_bid) : null, yesAsk: m.yes_ask != null ? Number(m.yes_ask) : null, title: m.title || null, status: m.status || null };
    marketCache.set(ticker, { at: Date.now(), data });
    return data;
  } catch { return { yesBid: null, yesAsk: null, title: null, status: null }; }
}

// Posiciones + saldo de un usuario, con precio actual y P&L estimado.
// Los precios de Kalshi son en centavos (1-99). P&L en $:
//   lado yes: (precioActual - precioMedio) * cantidad / 100
//   lado no:  ((100 - precioActual) - precioMedioNo) * cantidad / 100
// El precio medio se saca de las operaciones (fills) ponderado por
// cantidad; si no hay fills, se usa el campo que devuelva positions.
// v13: explica una posición en claro en vez de mostrar 0¢ y guiones.
// Causa del bug del video (12-nov): en el cliente, Number(null) es 0,
// así que una posición sin precio medio o sin precio actual se veía
// como "0¢". Aquí la posición lleva su `note` cuando algo falta:
// cantidad 0 = cerrada/vencida; sin precio medio = no hay fills para
// calcularlo; sin precio actual = mercado cerrado/vencido o sin
// cotización. Función pura, probada en Node.
function describePosition(p) {
  const count = p.count;
  if (count === 0) return 'Posición cerrada o sin cantidad abierta: Kalshi devuelve esta posición con cantidad 0 (puede estar liquidada o vencida). No hay nada que cobrar ni salir.';
  if (p.avgPrice == null) return 'Sin precio medio: no hay operaciones (fills) registradas para calcular a qué precio entraste.';
  if (p.currentPrice == null) return 'Sin precio actual: el mercado está cerrado, vencido o sin cotización en este momento.';
  return null;
}

async function getPositions({ keyId, privateKeyPem }) {
  const creds = { keyId, privateKeyPem };
  const [posJson, balJson] = await Promise.all([
    kalshiGet('/trade-api/v2/portfolio/positions', creds),
    kalshiGet('/trade-api/v2/portfolio/balance', creds).catch(() => null),
  ]);
  const raw = posJson.market_positions || posJson.positions || [];
  let fills = [];
  try {
    const f = await kalshiGet('/trade-api/v2/portfolio/fills', creds);
    fills = f.fills || [];
  } catch { fills = []; }
  // Precio medio ponderado por ticker+lado, desde los fills.
  const avgByKey = new Map();
  for (const f of fills) {
    const k = `${f.ticker}|${String(f.side || '').toLowerCase()}`;
    const price = Number(f.price);
    const count = Number(f.count || f.quantity || 0);
    if (!price || !count) continue;
    const cur = avgByKey.get(k) || { total: 0, count: 0 };
    cur.total += price * count;
    cur.count += count;
    avgByKey.set(k, cur);
  }
  const positions = [];
  for (const p of raw) {
    const ticker = p.ticker;
    if (!ticker) continue;
    const count = Number(p.position || p.count || 0);
    const side = count < 0 ? 'no' : 'yes';
    const absCount = Math.abs(count);
    const avg = avgByKey.get(`${ticker}|${side}`);
    const avgPrice = avg && avg.count ? +(avg.total / avg.count).toFixed(2) : (Number(p.avg_price) || null);
    const mk = await marketPrice(ticker);
    const yesPrice = mk.yesBid != null ? mk.yesBid : mk.yesAsk;
    const curPrice = side === 'yes' ? yesPrice : (yesPrice != null ? 100 - yesPrice : null);
    const pnl = (avgPrice != null && curPrice != null && absCount) ? +(((curPrice - avgPrice) * absCount) / 100).toFixed(2) : null;
    const posOut = {
      ticker, side, title: mk.title || p.title || ticker, count: absCount,
      avgPrice, currentPrice: curPrice, pnl, status: mk.status || p.status || null,
      marketExposure: p.market_exposure != null ? Number(p.market_exposure) / 100 : null,
      realizedPnl: p.realized_pnl != null ? Number(p.realized_pnl) / 100 : null,
    };
    posOut.note = describePosition(posOut);
    positions.push(posOut);
  }
  const balance = balJson ? { balance: balJson.balance != null ? Number(balJson.balance) / 100 : null, portfolioValue: balJson.portfolio_value != null ? Number(balJson.portfolio_value) / 100 : null } : null;
  return { positions, balance, fetchedAt: new Date().toISOString() };
}

// Prueba las credenciales con una llamada de solo lectura.
async function testCredentials(creds) {
  await kalshiGet('/trade-api/v2/portfolio/balance', creds);
  return true;
}

module.exports = { BASE, READ_ONLY_PATHS, parsePrivateKey, signHeaders, kalshiGet, getPositions, testCredentials, marketPrice, describePosition };
