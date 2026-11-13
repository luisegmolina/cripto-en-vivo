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
    // Precios en centavos. Kalshi renombró campos en 2026: yes_bid/
    // yes_ask (centavos) pasaron a yes_bid_dollars/yes_ask_dollars
    // (dólares en texto, ej. "0.45"). Se aceptan los dos formatos.
    const dollarsToCents = (v) => (v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 100));
    const centsOrNull = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
    const data = { yesBid: m.yes_bid_dollars != null ? dollarsToCents(m.yes_bid_dollars) : centsOrNull(m.yes_bid), yesAsk: m.yes_ask_dollars != null ? dollarsToCents(m.yes_ask_dollars) : centsOrNull(m.yes_ask), title: m.title || null, status: m.status || null, closeTime: m.close_time || null, expirationTime: m.expiration_time || null };
    marketCache.set(ticker, { at: Date.now(), data });
    return data;
  } catch { return { yesBid: null, yesAsk: null, title: null, status: null, closeTime: null, expirationTime: null }; }
}

// v13.2 — Deduce la dirección de una posición desde ticker+título+lado.
// "BTC price up in next 15 mins?" + SÍ = SUBE; + NO = BAJA.
// "BTC price down in next 15 mins?" + SÍ = BAJA; + NO = SUBE.
// Igual con above/below ("BTC above $70,000?" + SÍ = SUBE).
// Se usan \b (límite de palabra) para que "up" no case dentro de
// "group" ni "down" dentro de otra palabra. Si el título no dice
// hacia dónde va el mercado, devuelve null (no se inventa).
// Función pura, probada en Node. El cliente tiene la misma lógica
// como respaldo por si el servidor no la devuelve.
const UP_PATTERNS = [/\bprice up\b/, /\bgo(es)? up\b/, /\brise(s)?\b/, /\babove\b/, /\bup\b/, /\bpor encima\b/, /\barriba\b/, /\bsube\b/, /\bsubir\b/, /\bal alza\b/];
const DOWN_PATTERNS = [/\bprice down\b/, /\bgo(es)? down\b/, /\bfall(s)?\b/, /\bbelow\b/, /\bdown\b/, /\bpor debajo\b/, /\babajo\b/, /\bbaja\b/, /\bbajar\b/, /\ba la baja\b/];
function deriveDirection({ ticker, title, marketTitle, side }) {
  const text = [ticker, title, marketTitle].filter(Boolean).join(' ').toLowerCase();
  const hasUp = UP_PATTERNS.some((re) => re.test(text));
  const hasDown = DOWN_PATTERNS.some((re) => re.test(text));
  let marketDir = null;
  if (hasUp && !hasDown) marketDir = 'up';
  else if (hasDown && !hasUp) marketDir = 'down';
  if (!marketDir) return null;
  const s = String(side || '').toLowerCase();
  if (s === 'yes') return marketDir;
  if (s === 'no') return marketDir === 'up' ? 'down' : 'up';
  return null; // lado desconocido: no se inventa una dirección
}

// v13.2 — Ventana de un ticker Kalshi tipo KXBTC15M-26NOV122115-15.
// CORRECCIÓN tras comprobarlo en vivo contra la API pública: la hora
// del ticker es el CIERRE de la ventana, no el inicio. Verificado:
// KXBTC15M-26NOV122115-15 tiene open 02:00Z y close 02:15Z (21:00–
// 21:15 ET), y KXBTC15M-26NOV122145-45 open 02:30Z close 02:45Z.
// El sufijo (-15, -30, -45, -00) es el minuto de cierre. La duración
// es siempre 15 min (KXBTC15M). La hora del ticker es hora de Nueva
// York (ET), así que se convierte a UTC con Intl (con DST).
// Devuelve {startMs, endMs} o null si el ticker no trae fecha.
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function etWallToUtcMs(y, mo, d, h, mi) {
  let guess = Date.UTC(y, mo, d, h, mi);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
    guess += Date.UTC(y, mo, d, h, mi) - asUtc;
  }
  return guess;
}
function parseTickerWindow(ticker) {
  const m = String(ticker || '').match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{2})(\d{2})-(\d+)$/i);
  if (!m) return null;
  const year = 2000 + Number(m[1]);
  const month = MONTHS[m[2].toUpperCase()];
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const closeMs = etWallToUtcMs(year, month, day, hour, minute);
  return { startMs: closeMs - 15 * 60 * 1000, endMs: closeMs };
}

// v13.2 — MERCADO ACTUAL KXBTC15M DESDE LA API PÚBLICA DE KALSHI
// (sin clave, sin autenticación). Verificado en vivo 12-nov-2026:
// el mercado activo KXBTC15M-26NOV122145-45 devuelve
//   title: "BTC price up in next 15 mins?"
//   yes_sub_title: "Target Price: $70,487.89"  (no_sub_title: "TBD")
//   floor_strike: 70487.89
//   yes_bid_dollars/yes_ask_dollars: "0.2300"/"0.2400" (23¢/24¢)
//   no_bid_dollars/no_ask_dollars: "0.7600"/"0.7700"
//   status: "active", close_time, open_time.
// El precio objetivo es el precio contra el que se liquida la
// ventana: NO es un strike fijo que Kalshi publique aparte, es el
// floor_strike (y el mismo número va en yes_sub_title). La
// liquidación usa el índice CF Benchmarks BRTI (promedio de 60
// segundos, 7 exchanges), NO Coinbase — por eso el precio de
// Coinbase puede diferir del de liquidación (lo dicen las propias
// reglas del mercado: rules_secondary).
// Kalshi NO es un exchange: no da spot ni velas de SOL, XRP, ADA,
// DOGE, AVAX, LINK, LTC ni DOT. Esto es solo BTC 15 min.
// Si la API pública falla o no trae el mercado actual, se devuelve
// null y el cliente cae a Coinbase con aviso, nunca en blanco.
const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function dollarsToCents(v) {
  if (v == null || v === '' || Number.isNaN(Number(v))) return null;
  return Math.round(Number(v) * 100);
}
function parseTargetPrice(market) {
  if (!market) return null;
  if (market.floor_strike != null && Number.isFinite(Number(market.floor_strike))) return Number(market.floor_strike);
  const m = String(market.yes_sub_title || '').match(/target price:\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
  if (m) return Number(m[1].replace(/,/g, ''));
  return null; // "Target price: TBD" o sin dato: no se inventa
}
// Ticker de la ventana 15m en curso: la hora del ticker es el CIERRE.
// Ej.: 21:40 ET -> ventana 21:30–21:45 -> KXBTC15M-26NOV122145-45.
function buildCurrentTicker(nowMs = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  const y = Number(parts.year);
  const mo = Number(parts.month) - 1;
  const d = Number(parts.day);
  const h = Number(parts.hour) % 24;
  const mi = Number(parts.minute);
  // Minutos de pared ET como fecha UTC (para poder sumar y formatear).
  const base = Date.UTC(y, mo, d, h, mi);
  const wallMin = h * 60 + mi;
  const endWallMin = (Math.floor(wallMin / 15) + 1) * 15;
  const end = new Date(base + (endWallMin - wallMin) * 60 * 1000);
  const yy = String(end.getUTCFullYear() % 100).padStart(2, '0');
  const mon = MONTH_ABBR[end.getUTCMonth()];
  const dd = String(end.getUTCDate()).padStart(2, '0');
  const hh = String(end.getUTCHours()).padStart(2, '0');
  const mm = String(end.getUTCMinutes()).padStart(2, '0');
  return `KXBTC15M-${yy}${mon}${dd}${hh}${mm}-${mm}`;
}
function normalizeKalshiMarket(m) {
  return {
    source: 'kalshi',
    ticker: m.ticker || null,
    title: m.title || null,
    targetPrice: parseTargetPrice(m),
    yesBidCents: dollarsToCents(m.yes_bid_dollars ?? m.yes_bid),
    yesAskCents: dollarsToCents(m.yes_ask_dollars ?? m.yes_ask),
    noBidCents: dollarsToCents(m.no_bid_dollars ?? m.no_bid),
    noAskCents: dollarsToCents(m.no_ask_dollars ?? m.no_ask),
    lastPriceCents: dollarsToCents(m.last_price_dollars ?? m.last_price),
    status: m.status || null,
    closeTime: m.close_time || null,
    openTime: m.open_time || null,
    fetchedAt: new Date().toISOString(),
  };
}
let kalshiMarketCache = { at: 0, data: null };
async function getCurrentKalshiMarket({ nowMs = Date.now(), fetchFn = fetchJSONPublic, skipCache = false } = {}) {
  if (!skipCache && kalshiMarketCache.data && Date.now() - kalshiMarketCache.at < 15000) return kalshiMarketCache.data;
  const candidates = [buildCurrentTicker(nowMs), buildCurrentTicker(nowMs - 15 * 60 * 1000)];
  for (const ticker of candidates) {
    try {
      const j = await fetchFn(`${BASE}/trade-api/v2/markets/${encodeURIComponent(ticker)}`);
      const m = (j && (j.market || j)) || null;
      if (!m || !m.ticker) continue;
      const out = normalizeKalshiMarket(m);
      if (out.targetPrice == null) continue; // "Target price: TBD": aún no hay objetivo
      kalshiMarketCache = { at: Date.now(), data: out };
      return out;
    } catch { /* siguiente candidato */ }
  }
  return null;
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
  if (count === 0) {
    const sideTxt = p.side === 'yes' ? 'SÍ' : p.side === 'no' ? 'NO' : 'desconocido';
    const srcTxt = p.sideSource === 'fill' ? ' (lado recuperado de tus operaciones, porque la posición cerrada ya no trae lado)' : p.sideSource === 'position' ? '' : ' (sin lado en la API ni en tus operaciones)';
    return `Posición cerrada o sin cantidad abierta: Kalshi devuelve esta posición con cantidad 0 (puede estar liquidada o vencida). No hay nada que cobrar ni salir. Lado: ${sideTxt}${srcTxt}.`;
  }
  if (p.avgPrice == null) return 'Sin precio medio: no hay operaciones (fills) registradas para calcular a qué precio entraste.';
  if (p.currentPrice == null) return 'Sin precio actual: el mercado está cerrado, vencido o sin cotización en este momento.';
  return null;
}

// v13.2 — FUENTE DE VERDAD DEL LADO (SÍ/NO) en /portfolio/positions.
// Verificado contra la documentación de la API de Kalshi:
//  - La respuesta trae market_positions[] con UN SOLO campo de
//    dirección: `position` (entero con signo) o, desde el cambio de
//    nombres de 2026, `position_fp` (texto con decimales, ej. "-22.00"
//    = 22 contratos NO, "5.00" = 5 contratos SÍ). NO hay ningún campo
//    `side` ni `position_side` en este endpoint.
//  - Convención de signo: position > 0 = contratos SÍ (YES),
//    position < 0 = contratos NO, position == 0 = sin posición neta.
//  - EL BUG DE LA CAPTURA DE LUIS (12-nov): la posición cerrada
//    KXBTC15M-26NOV122130-30 venía con position == 0, y el código
//    hacía `count < 0 ? 'no' : 'yes'`, así que una cantidad 0 se
//    mostraba como SÍ aunque Luis había apostado a la BAJA. Un 0 no
//    tiene signo: no dice nada del lado.
//  - Por eso el lado se resuelve en este orden y NUNCA se inventa:
//    1. campo explícito side/position_side, si algún día lo hay;
//    2. signo de position/position_fp (solo si es distinto de 0);
//    3. el lado del último fill de ese ticker (las operaciones SÍ
//       traen side 'yes'/'no'): es el único rastro que queda de una
//       posición ya cerrada;
//    4. null = lado desconocido, y la UI lo muestra como tal para
//       que Luis lo verifique en Kalshi, no como un SÍ inventado.
// Función pura, probada en Node.
function signedPosition(p) {
  const v = p.position_fp ?? p.position ?? p.count ?? 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function resolvePositionSide({ rawPosition, explicitSide, latestFillSide }) {
  const ex = String(explicitSide || '').toLowerCase();
  if (ex === 'yes' || ex === 'no') return { side: ex, sideSource: 'explicit' };
  if (rawPosition > 0) return { side: 'yes', sideSource: 'position' };
  if (rawPosition < 0) return { side: 'no', sideSource: 'position' };
  const lf = String(latestFillSide || '').toLowerCase();
  if (lf === 'yes' || lf === 'no') return { side: lf, sideSource: 'fill' };
  return { side: null, sideSource: 'unknown' };
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
  // Precio medio ponderado por ticker+lado, desde los fills. Los
  // fills también traen el lado de cada operación (side 'yes'/'no'):
  // se guarda el último fill por ticker, que es el único rastro del
  // lado cuando la posición ya está en 0 (ver resolvePositionSide).
  // Campos renombrados en 2026: count -> count_fp, price en dólares
  // como price_dollars; se aceptan los dos formatos.
  const avgByKey = new Map();
  const latestFillByTicker = new Map();
  for (const f of fills) {
    const fSide = String(f.side || '').toLowerCase();
    const fPrice = f.price_dollars != null ? Number(f.price_dollars) * 100 : Number(f.price);
    const fCount = Number(f.count_fp ?? f.count ?? f.quantity ?? 0);
    if (!f.ticker) continue;
    const prev = latestFillByTicker.get(f.ticker);
    const t = f.created_time ? new Date(f.created_time).getTime() : 0;
    if (!prev || t >= prev.at) latestFillByTicker.set(f.ticker, { side: fSide, at: t });
    if (!fPrice || !fCount) continue;
    const k = `${f.ticker}|${fSide}`;
    const cur = avgByKey.get(k) || { total: 0, count: 0 };
    cur.total += fPrice * fCount;
    cur.count += fCount;
    avgByKey.set(k, cur);
  }
  const positions = [];
  for (const p of raw) {
    const ticker = p.ticker;
    if (!ticker) continue;
    // v13.2: position_fp (texto, "-22.00") o position (entero con
    // signo). NUNCA `p.position || p.count`: un 0 es un valor válido
    // (sin posición neta) y `||` lo habría convertido en otra cosa.
    const signedPos = signedPosition(p);
    const absCount = Math.abs(signedPos);
    const { side, sideSource } = resolvePositionSide({
      rawPosition: signedPos,
      explicitSide: p.side || p.position_side || null,
      latestFillSide: latestFillByTicker.get(ticker)?.side || null,
    });
    const avg = side ? avgByKey.get(`${ticker}|${side}`) : null;
    // Precio medio: fills ponderados; si no hay, total_traded /
    // cantidad (campo total_traded_dollars en dólares desde 2026).
    let avgPrice = avg && avg.count ? +(avg.total / avg.count).toFixed(2) : null;
    if (avgPrice == null && absCount > 0 && p.total_traded_dollars != null) {
      avgPrice = +((Number(p.total_traded_dollars) * 100) / absCount).toFixed(2);
    }
    if (avgPrice == null && p.avg_price != null) avgPrice = Number(p.avg_price) || null;
    const mk = await marketPrice(ticker);
    const yesPrice = mk.yesBid != null ? mk.yesBid : mk.yesAsk;
    const curPrice = side === 'yes' ? yesPrice : side === 'no' ? (yesPrice != null ? 100 - yesPrice : null) : null;
    const pnl = (avgPrice != null && curPrice != null && absCount) ? +(((curPrice - avgPrice) * absCount) / 100).toFixed(2) : null;
    // v13.2: la dirección SÍ se deduce del ticker+título+lado (antes
    // la UI decía que no se podía deducir, cuando en realidad lo que
    // faltaba era el precio para decidir). La ventana de cierre sale
    // del close_time de Kalshi o del ticker (KXBTC15M-…HHMM-duración).
    const direction = deriveDirection({ ticker, title: mk.title || p.title || ticker, side });
    const win = parseTickerWindow(ticker);
    const windowEndsAt = mk.closeTime || mk.expirationTime || (win ? new Date(win.endMs).toISOString() : null);
    const windowClosed = ['settled', 'closed'].includes(String(mk.status || p.status || '').toLowerCase())
      || (windowEndsAt ? Date.now() > new Date(windowEndsAt).getTime() : false);
    const posOut = {
      ticker, side, sideSource, title: mk.title || p.title || ticker, count: absCount,
      avgPrice, currentPrice: curPrice, pnl, status: mk.status || p.status || null,
      marketExposure: p.market_exposure_dollars != null ? Number(p.market_exposure_dollars) : (p.market_exposure != null ? Number(p.market_exposure) / 100 : null),
      realizedPnl: p.realized_pnl_dollars != null ? Number(p.realized_pnl_dollars) : (p.realized_pnl != null ? Number(p.realized_pnl) / 100 : null),
      direction, directionLabel: direction === 'up' ? 'SUBE' : direction === 'down' ? 'BAJA' : null,
      windowEndsAt, windowClosed,
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

module.exports = { BASE, READ_ONLY_PATHS, parsePrivateKey, signHeaders, kalshiGet, getPositions, testCredentials, marketPrice, describePosition, deriveDirection, parseTickerWindow, resolvePositionSide, signedPosition, parseTargetPrice, buildCurrentTicker, getCurrentKalshiMarket };
