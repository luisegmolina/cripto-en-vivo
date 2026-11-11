import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, LineStyle } from 'lightweight-charts';
import { analyze, emaSeries, bollingerSeries, rsiSeries } from './analysis.js';
import { updateLastCandle, candlesSignature, mergeServerCandles } from './liveCandle.js';
import { fearGreedEstimate, heatToday, isoWeekKey, rivalsForWeek } from './marketPro.js';
import { backtestSignal } from './backtest.js';
import { multiTfVerdict, reasonsFor, tradePlan, signalHistory, VERDICT_TFS } from './verdict.js';
import { MISSIONS, levelForXp, xpIntoLevel, XP_PER_LEVEL } from './missions.js';
import { screenOpportunities } from './screener.js';
import { shouldFireAlert, ALERT_COOLDOWN_MS } from './alerts.js';
import { shareText, whatsappUrl, drawShareCard, APP_URL } from './shareCard.js';

const ASSETS = [
  { symbol: 'BTC', name: 'Bitcoin' }, { symbol: 'ETH', name: 'Ethereum' },
  { symbol: 'SOL', name: 'Solana' }, { symbol: 'XRP', name: 'XRP' },
  { symbol: 'ADA', name: 'Cardano' }, { symbol: 'DOGE', name: 'Dogecoin' },
  { symbol: 'AVAX', name: 'Avalanche' }, { symbol: 'LINK', name: 'Chainlink' },
  { symbol: 'LTC', name: 'Litecoin' }, { symbol: 'DOT', name: 'Polkadot' },
];
const INTERVALS = ['1m', '5m', '15m', '1h', '6h', '1d'];
const CUR = { USD: '$', EUR: '€', GBP: '£' };
const START_CASH = 10000;
const VERSION_LABEL = 'v9 — Señal al frente, sin entrada si es ESPERAR';

const ACHIEVEMENTS = [
  { id: 'primera_operacion', name: 'Primera operación virtual', desc: 'Compra o vende por primera vez con dinero virtual.' },
  { id: 'primera_alerta', name: 'Primera alerta de precio', desc: 'Crea tu primera alerta de precio.' },
  { id: 'racha_3', name: 'Racha de 3 días', desc: 'Abre la app 3 días seguidos.' },
  { id: 'en_verde', name: 'En verde +2%', desc: 'Tu cartera virtual supera los 10.200.' },
  { id: 'cazador_top', name: 'Cazador del top', desc: 'Compra el activo que más sube en 24 h.' },
  { id: 'explorador', name: 'Explorador', desc: 'Mira los gráficos de 5 activos distintos.' },
];

async function api(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(path, { signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status} en ${path}`);
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Sin respuesta del servidor en 10 s en ${path} (¿el servidor está corriendo?)`);
    throw e;
  } finally { clearTimeout(t); }
}
function fmt(n, cur) {
  if (n == null || Number.isNaN(n)) return '—';
  const dec = n < 10 ? 4 : n < 1000 ? 2 : 2;
  return new Intl.NumberFormat('es-US', { style: 'currency', currency: cur, minimumFractionDigits: dec, maximumFractionDigits: dec }).format(n);
}
function fmtNum(n, dec = 2) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('es-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function loadLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function saveLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function localDay(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000);
  return d.toLocaleDateString('en-CA');
}
function marketsSignature(markets) {
  if (!markets || !markets.length) return 'empty';
  return markets.map((m) => `${m.symbol}:${m.price}:${m.change24h}`).join('|');
}
function sameTicker(a, b) {
  if (!a || !b) return false;
  return a.price === b.price && a.source === b.source && a.updatedAt === b.updatedAt
    && a.high24h === b.high24h && a.low24h === b.low24h && a.open24h === b.open24h
    && a.volume24h === b.volume24h && a.change24h === b.change24h;
}
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
// Notificación: si hay service worker activo, la muestra él (llega
// aunque la pestaña esté en segundo plano); si no, la clásica del
// navegador. Push real con servidor VAPID NO hay (ver README).
function notify(title, body) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, { body, icon: '/icons/icon.svg' })).catch(() => {
      try { new Notification(title, { body }); } catch {}
    });
  } else {
    try { new Notification(title, { body }); } catch {}
  }
}

// Mini gráfico (sparkline) con los últimos precios recogidos en vivo.
function Sparkline({ values, width = 120, height = 28 }) {
  if (!values || values.length < 2) return <span className="spark-empty">—</span>;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - 3 - ((v - min) / range) * (height - 6)}`).join(' ');
  const up = values[values.length - 1] >= values[0];
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={up ? '#22c55e' : '#ef4444'} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

export default function App() {
  const [symbol, setSymbol] = useState('BTC');
  const [currency, setCurrency] = useState('USD');
  // OJO: el estado se llama candleInterval (NO "interval") a propósito.
  // Antes se llamaba [interval, setInterval] y eso eclipsaba el
  // setInterval global y causaba el bucle "Maximum update depth exceeded".
  // Nunca nombrar un setter setInterval.
  // v9: el intervalo por defecto es 1h, no 1m. El 1m es ruido: la señal
  // acierta poco ahí (en la medición del 10-nov, BTC 1m acertó 2 de 10)
  // y el historial/backtest con 1m ponían el peor ejemplo al frente.
  const [candleInterval, setCandleInterval] = useState('1h');
  const [markets, setMarkets] = useState([]);
  const [ticker, setTicker] = useState(null);
  const [candles, setCandles] = useState([]);
  const [source, setSource] = useState('');
  const [updatedAt, setUpdatedAt] = useState('');
  const [error, setError] = useState('');
  const [marketsError, setMarketsError] = useState('');
  const [candlesError, setCandlesError] = useState('');
  const [serverStatus, setServerStatus] = useState('Comprobando…');
  const [testResult, setTestResult] = useState('');
  const [debugInfo, setDebugInfo] = useState('');
  const [flash, setFlash] = useState('');
  const [alerts, setAlerts] = useState([]);
  const [notif, setNotif] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [latencyMs, setLatencyMs] = useState(null);
  const prevPrice = useRef(null);
  const alertedKey = useRef('');
  const lastTicker = useRef(null);
  const lastMarketsSig = useRef('');
  const lastCandlesSig = useRef('');
  const lastChartSig = useRef('');
  const lastChartTime = useRef(null);
  const chartRef = useRef(null);
  const chartObj = useRef(null);
  const candleSeries = useRef(null);
  const volumeSeries = useRef(null);
  const ema20Series = useRef(null);
  const ema50Series = useRef(null);
  const bbUpperSeries = useRef(null);
  const bbMiddleSeries = useRef(null);
  const bbLowerSeries = useRef(null);
  const relSeries = useRef(null);
  const rsiChartRef = useRef(null);
  const rsiChartObj = useRef(null);
  const rsiLineSeries = useRef(null);
  const rsiHiSeries = useRef(null);
  const rsiLoSeries = useRef(null);
  const candlesRef = useRef([]);

  // --- Gráfico PRO: indicadores con toggle, comparar con BTC, pantalla completa ---
  const [showEma, setShowEma] = useState(true);
  const [showBoll, setShowBoll] = useState(true);
  const [showRsi, setShowRsi] = useState(false);
  const [compareBtc, setCompareBtc] = useState(false);
  const [chartFull, setChartFull] = useState(false);
  const [btcCandles, setBtcCandles] = useState([]);

  // --- Enganche: cartera virtual, alertas de precio, racha, logros ---
  const [portfolio, setPortfolio] = useState(() => loadLS('cev_portfolio_v1', { cash: START_CASH, holdings: {}, trades: [] }));
  const [paperAmount, setPaperAmount] = useState('100');
  const [paperMsg, setPaperMsg] = useState('');
  const [priceAlerts, setPriceAlerts] = useState(() => loadLS('cev_price_alerts_v1', []));
  const [alertTarget, setAlertTarget] = useState('');
  const [alertDir, setAlertDir] = useState('above');
  const [streak, setStreak] = useState(() => loadLS('cev_streak_v1', { days: 0, totalDays: 0, lastVisit: '' }));
  const [achievements, setAchievements] = useState(() => loadLS('cev_achievements_v1', []));
  const [sparkHist, setSparkHist] = useState({});
  const priceAlertsRef = useRef(priceAlerts);
  priceAlertsRef.current = priceAlerts;
  // v9: anti-duplicados de alertas. Cada alerta que suena queda anotada
  // por clave símbolo|moneda|dirección|precio con su hora; si el mismo
  // precio vuelve a cruzarse antes de 1 h, NO vuelve a sonar ni a
  // duplicarse en la lista (en el PDF del 10-nov la misma alerta de
  // $73.53 sonó 4 veces). Persistido en localStorage.
  const alertCooldownRef = useRef(loadLS('cev_alert_cooldown_v1', {}));

  // --- Perfil local (sin login, sin servidor): solo un apodo ---
  const [nickname, setNickname] = useState(() => (loadLS('cev_profile_v1', {}).nickname || ''));
  const [nicknameInput, setNicknameInput] = useState(nickname);
  const [profileMsg, setProfileMsg] = useState('');

  // --- Liga semanal (demo/local) + liga privada con código ---
  const weekKey = isoWeekKey();
  const [leagueWeek, setLeagueWeek] = useState(() => loadLS('cev_league_week_v1', null));
  const [privateLeague, setPrivateLeague] = useState(() => loadLS('cev_private_league_v1', null));
  const [leagueNameInput, setLeagueNameInput] = useState('');
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [leagueMsg, setLeagueMsg] = useState('');

  // --- Misiones diarias y XP ---
  const [missionDay, setMissionDay] = useState(() => {
    const s = loadLS('cev_missions_v1', null);
    return s && s.date === localDay(0) ? s : { date: localDay(0), done: {} };
  });
  const [xpTotal, setXpTotal] = useState(() => loadLS('cev_xp_v1', 0));
  const [visitedToday, setVisitedToday] = useState(() => {
    const s = loadLS('cev_visited_today_v1', null);
    return s && s.date === localDay(0) ? s : { date: localDay(0), symbols: [] };
  });

  // --- Screener / compartir ---
  const [screenRows, setScreenRows] = useState({ opportunities: [], rest: [] });
  const [screenLoading, setScreenLoading] = useState(false);
  const [screenError, setScreenError] = useState('');
  const [screenUpdatedAt, setScreenUpdatedAt] = useState('');
  const [shareMsg, setShareMsg] = useState('');
  const shareCanvasRef = useRef(null);

  const unlock = (id) => {
    setAchievements((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      saveLS('cev_achievements_v1', next);
      return next;
    });
  };
  useEffect(() => { saveLS('cev_portfolio_v1', portfolio); }, [portfolio]);
  useEffect(() => { saveLS('cev_price_alerts_v1', priceAlerts); }, [priceAlerts]);

  const completeMission = (id) => {
    const today = localDay(0);
    const base = missionDay.date === today ? missionDay : { date: today, done: {} };
    if (base.done[id]) return;
    const m = MISSIONS.find((x) => x.id === id);
    const next = { date: today, done: { ...base.done, [id]: true } };
    saveLS('cev_missions_v1', next);
    setMissionDay(next);
    if (m) setXpTotal((xp) => { const n = xp + m.xp; saveLS('cev_xp_v1', n); return n; });
  };

  // Racha de días abriendo la app (solo local, sin cuentas).
  useEffect(() => {
    const today = localDay(0), yesterday = localDay(-1);
    const prev = loadLS('cev_streak_v1', { days: 0, totalDays: 0, lastVisit: '' });
    if (prev.lastVisit === today) { setStreak(prev); return; }
    const next = prev.lastVisit === yesterday
      ? { days: prev.days + 1, totalDays: prev.totalDays + 1, lastVisit: today }
      : { days: 1, totalDays: prev.totalDays + 1, lastVisit: today };
    saveLS('cev_streak_v1', next);
    setStreak(next);
    if (next.days >= 3) unlock('racha_3');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Activos distintos visitados (logro Explorador + misión diaria).
  useEffect(() => {
    const visited = loadLS('cev_visited_v1', []);
    if (!visited.includes(symbol)) {
      const next = [...visited, symbol];
      saveLS('cev_visited_v1', next);
      if (next.length >= 5) unlock('explorador');
    }
    const today = localDay(0);
    const vt = loadLS('cev_visited_today_v1', null);
    const base = vt && vt.date === today ? vt : { date: today, symbols: [] };
    if (!base.symbols.includes(symbol)) {
      const next = { date: today, symbols: [...base.symbols, symbol] };
      saveLS('cev_visited_today_v1', next);
      setVisitedToday(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const analysis = useMemo(() => analyze(candles), [candles]);
  // El backtest solo se recalcula cuando llega una vela nueva (no con
  // cada tick), porque es el cálculo más pesado de la app.
  const lastCandleKey = candles.length ? `${candles.length}:${candles[candles.length - 1].time}` : 'empty';
  const backtest = useMemo(() => backtestSignal(candles), [lastCandleKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- v8: VEREDICTO multi-timeframe (1m, 5m, 15m, 1h) ---
  const [mtfCandles, setMtfCandles] = useState({});
  const mtfAnalysis = useMemo(() => {
    const out = {};
    for (const tf of VERDICT_TFS) {
      const list = tf === candleInterval ? candles : mtfCandles[tf];
      if (list && list.length >= 30) out[tf] = analyze(list);
    }
    return out;
  }, [mtfCandles, candles, candleInterval]);
  const mtfVerdict = useMemo(() => multiTfVerdict(mtfAnalysis), [mtfAnalysis]);
  const verdictReasons = useMemo(() => reasonsFor(analysis), [analysis]);
  const plan = useMemo(() => tradePlan(priceNowForPlan(), candles, mtfVerdict.verdict.key), [ticker, candles, mtfVerdict.verdict.key]);
  const histSignals = useMemo(() => signalHistory(candles, 10), [lastCandleKey]); // eslint-disable-line react-hooks/exhaustive-deps
  function priceNowForPlan() {
    return ticker?.price ?? markets.find((m) => m.symbol === symbol)?.price ?? null;
  }
  // v9: capitalización total y dominio de BTC REALES, de /api/global
  // (CoinGecko). Se refrescan cada 5 min. Si CoinGecko falla o da 429,
  // globalData queda en null y la UI muestra "No disponible", nunca un
  // número inventado (el proxy precio × volumen se eliminó).
  const [globalData, setGlobalData] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const g = await api('/api/global');
        if (alive && g && g.available) setGlobalData(g);
        else if (alive) setGlobalData(null);
      } catch { if (alive) setGlobalData(null); }
    };
    load();
    const t = setInterval(load, 300000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const capText = globalData && globalData.totalMarketCapUsd
    ? `$${(globalData.totalMarketCapUsd / 1e12).toFixed(2)} billones`
    : 'No disponible';
  const domText = globalData && globalData.btcDominance != null
    ? `${Number(globalData.btcDominance).toFixed(1)}%`
    : 'No disponible';
  const fearGreed = useMemo(() => fearGreedEstimate(markets, analysis.rsi), [markets, analysis.rsi]);
  const heat = useMemo(() => heatToday(markets), [markets]);

  // --- Datos: polling AL SERVIDOR (localhost:3001), nunca a los exchanges ---
  useEffect(() => {
    let alive = true;
    const loadTicker = async () => {
      try {
        const t0 = performance.now();
        const t = await api(`/api/ticker?symbol=${symbol}&currency=${currency}`);
        if (!alive) return;
        setLatencyMs(Math.round(performance.now() - t0));
        if (prevPrice.current != null && t.price !== prevPrice.current) {
          const dir = t.price > prevPrice.current ? 'up' : 'down';
          setFlash((f) => (f === dir ? f : dir));
        }
        prevPrice.current = t.price;
        // *** GRÁFICO EN VIVO: cada tick mueve la última vela ***
        const live = updateLastCandle(candlesRef.current, t.price, candleInterval);
        if (live && live !== candlesRef.current) {
          const last = live[live.length - 1];
          candlesRef.current = live;
          try {
            candleSeries.current?.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
            volumeSeries.current?.update({ time: last.time, value: last.volume || 0, color: last.close >= last.open ? 'rgba(34,197,94,.5)' : 'rgba(239,68,68,.5)' });
          } catch {}
          lastCandlesSig.current = candlesSignature(live);
          setCandles(live);
        }
        if (!sameTicker(lastTicker.current, t)) {
          lastTicker.current = t;
          setTicker(t);
          setSource((prev) => (prev === t.source ? prev : t.source));
          setUpdatedAt((prev) => (prev === t.updatedAt ? prev : t.updatedAt));
        }
        setError((prev) => (prev === '' ? prev : ''));
        setServerStatus((prev) => (prev === 'OK — responde' ? prev : 'OK — responde'));
      } catch (e) { if (alive) { setError(String(e.message || e)); setServerStatus('FALLO — no responde'); } }
    };
    const loadMarkets = async () => {
      try {
        const m = await api(`/api/markets?currency=${currency}`);
        if (!alive) return;
        const list = m.markets || [];
        const sig = marketsSignature(list);
        if (sig !== lastMarketsSig.current) {
          lastMarketsSig.current = sig;
          setMarkets(list);
          // Historial para los sparklines de cada pestaña (últimos 24 precios).
          setSparkHist((prev) => {
            const next = { ...prev };
            for (const item of list) {
              if (item.price == null) continue;
              next[item.symbol] = [...(prev[item.symbol] || []), item.price].slice(-24);
            }
            return next;
          });
        }
        setMarketsError((prev) => (prev === '' ? prev : ''));
      } catch (e) { if (alive) setMarketsError(String(e.message || e)); }
    };
    const loadCandles = async () => {
      try {
        const c = await api(`/api/candles?symbol=${symbol}&currency=${currency}&interval=${candleInterval}`);
        if (!alive) return;
        // El servidor puede venir con retraso (Coinbase 1m): no borrar
        // las velas vivas más nuevas que ya creamos con los ticks.
        const list = mergeServerCandles(c.candles || [], candlesRef.current);
        const sig = candlesSignature(list);
        if (sig !== lastCandlesSig.current) {
          lastCandlesSig.current = sig;
          candlesRef.current = list;
          setCandles(list);
        }
        setCandlesError((prev) => (prev === '' ? prev : ''));
        setSource((s) => s || c.source);
      } catch (e) { if (alive) setCandlesError(String(e.message || e)); }
    };
    loadTicker(); loadMarkets(); loadCandles();
    const t1 = setInterval(loadTicker, 1000);
    const t2 = setInterval(loadMarkets, 10000);
    const t3 = setInterval(loadCandles, 6000);
    return () => { alive = false; clearInterval(t1); clearInterval(t2); clearInterval(t3); };
  }, [symbol, currency, candleInterval]);

  // Al cambiar de activo/moneda/intervalo, la vela en curso es otra.
  useEffect(() => {
    candlesRef.current = [];
    lastCandlesSig.current = '';
    lastChartSig.current = '';
    lastChartTime.current = null;
    prevPrice.current = null;
    setBtcCandles([]);
  }, [symbol, currency, candleInterval]);

  // v8: velas de 1m, 5m, 15m y 1h para la confluencia del veredicto.
  // Se refrescan cada 20 s (no cada segundo: la señal no cambia a cada tick).
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const settled = await Promise.allSettled(VERDICT_TFS.map((tf) => api(`/api/candles?symbol=${symbol}&currency=${currency}&interval=${tf}`)));
      if (!alive) return;
      const next = {};
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value.candles && r.value.candles.length) next[VERDICT_TFS[i]] = r.value.candles;
      });
      setMtfCandles((prev) => {
        const sig = (o) => VERDICT_TFS.map((tf) => (o[tf] ? `${o[tf].length}:${o[tf][o[tf].length - 1]?.time}` : '')).join('|');
        return sig(next) === sig(prev) ? prev : next;
      });
    };
    load();
    const t = setInterval(load, 20000);
    return () => { alive = false; clearInterval(t); };
  }, [symbol, currency]);

  // Velas de BTC para "comparar contra BTC" (solo cuando está activo).
  useEffect(() => {
    if (!compareBtc || symbol === 'BTC') { setBtcCandles([]); return undefined; }
    let alive = true;
    const load = async () => {
      try {
        const c = await api(`/api/candles?symbol=BTC&currency=${currency}&interval=${candleInterval}`);
        if (alive) setBtcCandles(c.candles || []);
      } catch { /* si falla, la comparación simplemente no se dibuja */ }
    };
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, [compareBtc, symbol, currency, candleInterval]);

  // --- Alertas de precio personalizadas: se comprueban con cada tick ---
  useEffect(() => {
    if (!ticker || ticker.price == null) return;
    const price = ticker.price;
    const nowMs = Date.now();
    let fired = false;
    const next = priceAlertsRef.current.map((a) => {
      if (a.triggered || a.symbol !== symbol || a.currency !== currency) return a;
      const hit = a.direction === 'above' ? price >= a.target : price <= a.target;
      if (!hit) return a;
      // v9: cooldown de 1 h por precio objetivo (ver alerts.js): si esta
      // misma alerta ya sonó hace menos de 1 h, se marca como sonada
      // pero NO vuelve a sonar ni a duplicarse en la lista de alertas.
      const res = shouldFireAlert(alertCooldownRef.current, a, nowMs);
      if (!res.fire) {
        return { ...a, triggered: true, triggeredAt: new Date().toISOString() };
      }
      alertCooldownRef.current = res.map;
      saveLS('cev_alert_cooldown_v1', alertCooldownRef.current);
      fired = true;
      const msg = `🔔 ${a.symbol}: llegó a ${fmt(price, currency)} (${a.direction === 'above' ? 'por encima de' : 'por debajo de'} ${fmt(a.target, currency)}) — ${new Date().toLocaleTimeString('es-US')}`;
      setAlerts((prev) => [msg, ...prev].slice(0, 20));
      notify('Cripto en Vivo — alerta de precio', msg);
      return { ...a, triggered: true, triggeredAt: new Date().toISOString() };
    });
    if (fired) setPriceAlerts(next);
  }, [ticker, symbol, currency]);

  // --- v8: ALERTA cuando el VEREDICTO cambia de COMPRAR a VENDER o viceversa ---
  const prevVerdictKey = useRef(null);
  const verdictKeyNow = mtfVerdict.verdict.key;
  useEffect(() => {
    const prev = prevVerdictKey.current;
    prevVerdictKey.current = verdictKeyNow;
    if (!prev) return; // primera carga: no es un cambio, no alertar
    if (prev === verdictKeyNow) return;
    const flips = (prev === 'buy' && verdictKeyNow === 'sell') || (prev === 'sell' && verdictKeyNow === 'buy');
    const msg = flips
      ? `🚨 CAMBIO DE SEÑAL ${symbol}: ${prev === 'buy' ? 'COMPRAR' : 'VENDER'} → ${verdictKeyNow === 'buy' ? 'COMPRAR' : 'VENDER'} (puntuación ${mtfVerdict.score}, confianza ${mtfVerdict.confidence}%) — ${new Date().toLocaleTimeString('es-US')}`
      : `🔔 Señal ${symbol}: ahora ${mtfVerdict.verdict.label} (puntuación ${mtfVerdict.score}) — ${new Date().toLocaleTimeString('es-US')}`;
    setAlerts((a) => [msg, ...a].slice(0, 20));
    notify('Cripto en Vivo — cambio de señal', msg);
    try {
      const hist = JSON.parse(localStorage.getItem('cev_signal_changes_v1') || '[]');
      hist.unshift({ time: new Date().toISOString(), symbol, from: prev, to: verdictKeyNow, score: mtfVerdict.score });
      localStorage.setItem('cev_signal_changes_v1', JSON.stringify(hist.slice(0, 30)));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verdictKeyNow, symbol]);

  // --- Gráfico de velas: creación (una sola vez, con limpieza) ---
  useEffect(() => {
    const el = chartRef.current;
    if (!el) return undefined;
    const chart = createChart(el, {
      width: el.clientWidth, height: 340,
      layout: { background: { color: '#0b0f14' }, textColor: '#cbd5e1' },
      grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    chartObj.current = chart;
    candleSeries.current = chart.addCandlestickSeries({ upColor: '#22c55e', downColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444' });
    volumeSeries.current = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '' });
    ema20Series.current = chart.addLineSeries({ color: '#f59e0b', lineWidth: 1, title: 'EMA 20', priceLineVisible: false, lastValueVisible: false });
    ema50Series.current = chart.addLineSeries({ color: '#38bdf8', lineWidth: 1, title: 'EMA 50', priceLineVisible: false, lastValueVisible: false });
    bbUpperSeries.current = chart.addLineSeries({ color: 'rgba(148,163,184,.7)', lineWidth: 1, title: 'Bollinger sup.', priceLineVisible: false, lastValueVisible: false });
    bbMiddleSeries.current = chart.addLineSeries({ color: 'rgba(148,163,184,.4)', lineWidth: 1, title: 'Bollinger media', priceLineVisible: false, lastValueVisible: false });
    bbLowerSeries.current = chart.addLineSeries({ color: 'rgba(148,163,184,.7)', lineWidth: 1, title: 'Bollinger inf.', priceLineVisible: false, lastValueVisible: false });
    relSeries.current = chart.addLineSeries({ color: '#a78bfa', lineWidth: 2, title: 'vs BTC (índice 100)', priceScaleId: 'rel', priceLineVisible: false });
    try { chart.priceScale('rel').applyOptions({ visible: false }); } catch {}
    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
      chartObj.current = null;
      candleSeries.current = null;
      volumeSeries.current = null;
      ema20Series.current = null;
      ema50Series.current = null;
      bbUpperSeries.current = null;
      bbMiddleSeries.current = null;
      bbLowerSeries.current = null;
      relSeries.current = null;
      lastChartSig.current = '';
    };
  }, []);

  // Pantalla completa del gráfico: redimensionar al entrar/salir.
  useEffect(() => {
    const chart = chartObj.current;
    const el = chartRef.current;
    if (!chart || !el) return;
    chart.applyOptions({ width: el.clientWidth, height: chartFull ? Math.max(300, window.innerHeight - 160) : 340 });
  }, [chartFull]);

  // --- Gráfico de velas: datos (solo cuando cambia la firma de las velas) ---
  useEffect(() => {
    if (!candleSeries.current || !volumeSeries.current || !chartObj.current) return;
    const closes = candles.map((c) => c.close);
    const times = candles.map((c) => c.time);
    const sig = `${candlesSignature(candles)}|${analysis.patterns.map((p) => `${p.time}:${p.name}`).join(',')}|ema:${showEma}|boll:${showBoll}|rsi:${showRsi}|vsbtc:${compareBtc}|btc:${btcCandles.length ? btcCandles[btcCandles.length - 1].time : 0}`;
    if (sig === lastChartSig.current) return;
    lastChartSig.current = sig;
    candleSeries.current.setData(candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
    volumeSeries.current.setData(candles.map((c) => ({ time: c.time, value: c.volume || 0, color: c.close >= c.open ? 'rgba(34,197,94,.5)' : 'rgba(239,68,68,.5)' })));
    candleSeries.current.setMarkers(analysis.patterns.map((p) => ({
      time: p.time, position: p.dir === 'up' ? 'belowBar' : p.dir === 'down' ? 'aboveBar' : 'inBar',
      color: p.dir === 'up' ? '#22c55e' : p.dir === 'down' ? '#ef4444' : '#94a3b8',
      shape: p.dir === 'up' ? 'arrowUp' : p.dir === 'down' ? 'arrowDown' : 'circle', text: p.name,
    })));
    // EMA 20/50 como líneas (toggle).
    const toPoints = (series) => times.map((t, i) => (series[i] == null ? null : { time: t, value: series[i] })).filter(Boolean);
    try {
      ema20Series.current?.setData(toPoints(emaSeries(closes, 20)));
      ema20Series.current?.applyOptions({ visible: showEma });
      ema50Series.current?.setData(toPoints(emaSeries(closes, 50)));
      ema50Series.current?.applyOptions({ visible: showEma });
    } catch {}
    // Bollinger como 3 líneas (toggle).
    try {
      const bb = bollingerSeries(closes);
      const pick = (k) => times.map((t, i) => (bb[i] == null ? null : { time: t, value: bb[i][k] })).filter(Boolean);
      bbUpperSeries.current?.setData(pick('upper'));
      bbMiddleSeries.current?.setData(pick('middle'));
      bbLowerSeries.current?.setData(pick('lower'));
      bbUpperSeries.current?.applyOptions({ visible: showBoll });
      bbMiddleSeries.current?.applyOptions({ visible: showBoll });
      bbLowerSeries.current?.applyOptions({ visible: showBoll });
    } catch {}
    // Comparar contra BTC: índice relativo (100 = igual que al inicio).
    try {
      if (compareBtc && symbol !== 'BTC' && btcCandles.length > 1 && candles.length > 1) {
        const btcByTime = new Map(btcCandles.map((c) => [c.time, c.close]));
        const pairs = [];
        for (let i = 0; i < candles.length; i++) {
          const b = btcByTime.get(candles[i].time);
          if (b != null) pairs.push([candles[i].time, candles[i].close, b]);
        }
        if (pairs.length > 1) {
          const [t0, a0, b0] = pairs[0];
          relSeries.current?.setData(pairs.map(([t, a, b]) => ({ time: t, value: ((a / a0) / (b / b0)) * 100 })));
          relSeries.current?.applyOptions({ visible: true });
          chartObj.current.priceScale('rel').applyOptions({ visible: true });
        } else {
          relSeries.current?.applyOptions({ visible: false });
        }
      } else {
        relSeries.current?.applyOptions({ visible: false });
        try { chartObj.current.priceScale('rel').applyOptions({ visible: false }); } catch {}
      }
    } catch {}
    // RSI como panel inferior (toggle; el mini gráfico se crea al activarlo).
    if (showRsi && rsiChartRef.current) {
      try {
        if (!rsiChartObj.current) {
          const rc = createChart(rsiChartRef.current, {
            width: rsiChartRef.current.clientWidth, height: 120,
            layout: { background: { color: '#0b0f14' }, textColor: '#cbd5e1' },
            grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
            timeScale: { timeVisible: true, secondsVisible: false },
            rightPriceScale: { visible: true },
          });
          rsiChartObj.current = rc;
          rsiLineSeries.current = rc.addLineSeries({ color: '#f59e0b', lineWidth: 2, title: 'RSI 14', priceLineVisible: false });
          rsiHiSeries.current = rc.addLineSeries({ color: '#64748b', lineWidth: 1, lineStyle: LineStyle.Dashed, title: '70', priceLineVisible: false, lastValueVisible: false });
          rsiLoSeries.current = rc.addLineSeries({ color: '#64748b', lineWidth: 1, lineStyle: LineStyle.Dashed, title: '30', priceLineVisible: false, lastValueVisible: false });
        }
        rsiChartObj.current.applyOptions({ width: rsiChartRef.current.clientWidth });
        const rs = rsiSeries(closes);
        rsiLineSeries.current?.setData(toPoints(rs));
        const span = times.length ? [{ time: times[0], value: 70 }, { time: times[times.length - 1], value: 70 }] : [];
        const span30 = times.length ? [{ time: times[0], value: 30 }, { time: times[times.length - 1], value: 30 }] : [];
        rsiHiSeries.current?.setData(span);
        rsiLoSeries.current?.setData(span30);
      } catch {}
    }
    const lastTime = candles.length ? candles[candles.length - 1].time : null;
    if (lastTime !== lastChartTime.current) {
      lastChartTime.current = lastTime;
      chartObj.current.timeScale().scrollToRealTime();
    }
  }, [candles, analysis, showEma, showBoll, showRsi, compareBtc, btcCandles]);

  const testServer = async () => {
    setTestResult('Probando…');
    setDebugInfo('');
    try {
      const t0 = Date.now();
      const h = await api('/api/health');
      const ms = Date.now() - t0;
      setServerStatus('OK — responde');
      setTestResult(`✅ Servidor OK en ${ms} ms`);
    } catch (e) {
      setServerStatus('FALLO — no responde');
      setTestResult(`❌ Servidor NO responde: ${e.message || e}. ¿Corriste "npm run dev" en la carpeta raíz? ¿Dice la terminal "servidor en http://localhost:3001"?`);
      return;
    }
    try {
      const d = await api('/api/debug');
      const lines = (d.sources || []).map((s) => s.ok ? `✅ ${s.name}: $${s.price} en ${s.ms} ms` : `❌ ${s.name}: ${s.error} (${s.ms} ms)`);
      setDebugInfo(lines.join('\n'));
    } catch (e) { setDebugInfo(`No se pudo correr /api/debug: ${e.message || e}`); }
  };
  const askNotif = async () => {
    if (!('Notification' in window)) return;
    const p = await Notification.requestPermission();
    setNotif(p);
  };

  // --- Cartera virtual (dinero de mentira, solo localStorage) ---
  const priceNow = ticker?.price ?? markets.find((m) => m.symbol === symbol)?.price ?? null;
  const holdingsValue = Object.entries(portfolio.holdings || {}).reduce((sum, [sym, qty]) => {
    const p = sym === symbol ? priceNow : markets.find((m) => m.symbol === sym)?.price;
    return sum + (p ? qty * p : 0);
  }, 0);
  const totalValue = (portfolio.cash || 0) + holdingsValue;
  const pnl = totalValue - START_CASH;
  const pnlPct = (pnl / START_CASH) * 100;
  useEffect(() => { if (totalValue >= START_CASH * 1.02) unlock('en_verde'); }, [totalValue]);
  const topGainer = markets.length ? [...markets].sort((a, b) => (b.change24h ?? -999) - (a.change24h ?? -999))[0] : null;
  const topLoser = markets.length ? [...markets].sort((a, b) => (a.change24h ?? 999) - (b.change24h ?? 999))[0] : null;

  // --- Liga semanal: inicio de semana guardado, rivales demo deterministas ---
  useEffect(() => {
    const stored = loadLS('cev_league_week_v1', null);
    const cur = stored || leagueWeek;
    if (!cur || cur.weekKey !== weekKey) {
      const next = { weekKey, startValue: totalValue > 0 ? totalValue : START_CASH };
      saveLS('cev_league_week_v1', next);
      setLeagueWeek(next);
    } else if (totalValue > 0 && totalValue < cur.startValue * 0.6) {
      // La cartera se reinició: la semana empieza desde el valor actual.
      const next = { ...cur, startValue: totalValue };
      saveLS('cev_league_week_v1', next);
      setLeagueWeek(next);
    } else if (!leagueWeek || leagueWeek.weekKey !== cur.weekKey || leagueWeek.startValue !== cur.startValue) {
      setLeagueWeek(cur);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekKey, totalValue]);
  const weekStart = leagueWeek && leagueWeek.weekKey === weekKey ? leagueWeek.startValue : totalValue;
  const myWeeklyReturn = weekStart > 0 ? ((totalValue - weekStart) / weekStart) * 100 : 0;
  const myWeeklyPnl = totalValue - weekStart;
  const rivals = useMemo(() => rivalsForWeek(weekKey), [weekKey]);
  const standings = useMemo(() => {
    const rows = [
      ...rivals.map((r) => ({ name: r.name, ret: r.weeklyReturn, demo: true, me: false })),
      { name: nickname ? `${nickname} (tú)` : 'Tú', ret: myWeeklyReturn, demo: false, me: true },
    ];
    return rows.sort((a, b) => b.ret - a.ret).map((r, i) => ({ ...r, rank: i + 1 }));
  }, [rivals, myWeeklyReturn, nickname]);
  const myRank = standings.find((s) => s.me)?.rank || null;
  const isSunday = new Date().getDay() === 0;
  const weekWinner = isSunday && standings.length ? standings[0] : null;

  // --- Misiones: comprobación automática de las que se pueden detectar ---
  useEffect(() => {
    const today = localDay(0);
    if ((portfolio.trades || []).some((tr) => new Date(tr.time).toLocaleDateString('en-CA') === today)) completeMission('primera_operacion');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolio.trades]);
  useEffect(() => {
    const today = localDay(0);
    if (priceAlerts.some((a) => new Date(a.createdAt).toLocaleDateString('en-CA') === today)) completeMission('poner_alerta');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceAlerts]);
  useEffect(() => {
    if ((visitedToday.symbols || []).length >= 3) completeMission('explorar_3');
    if (totalValue > START_CASH) completeMission('en_verde');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitedToday, totalValue]);
  const level = levelForXp(xpTotal);
  const xpInLevel = xpIntoLevel(xpTotal);
  const missionsDoneToday = MISSIONS.filter((m) => missionDay.done[m.id]).length;

  const doTrade = (side) => {
    const amount = Number(paperAmount);
    if (!priceNow || priceNow <= 0) { setPaperMsg('Todavía no llegó el precio en vivo. Espera un segundo.'); return; }
    if (!amount || amount <= 0) { setPaperMsg('Pon una cantidad mayor que 0.'); return; }
    const qty = amount / priceNow;
    if (side === 'buy') {
      if (amount > (portfolio.cash || 0)) { setPaperMsg(`No te alcanza: tienes ${fmt(portfolio.cash, currency)} virtuales.`); return; }
      setPortfolio((prev) => ({
        cash: prev.cash - amount,
        holdings: { ...prev.holdings, [symbol]: (prev.holdings[symbol] || 0) + qty },
        trades: [{ id: Date.now(), time: new Date().toISOString(), symbol, side: 'buy', qty, price: priceNow, total: amount, currency }, ...(prev.trades || [])].slice(0, 50),
      }));
      setPaperMsg(`Compraste ${fmtNum(qty, 6)} ${symbol} por ${fmt(amount, currency)} (virtual).`);
      unlock('primera_operacion');
      if (topGainer && topGainer.symbol === symbol) unlock('cazador_top');
    } else {
      const held = portfolio.holdings[symbol] || 0;
      if (held <= 0) { setPaperMsg(`No tienes ${symbol} para vender.`); return; }
      const sellQty = Math.min(held, qty);
      const proceeds = sellQty * priceNow;
      const nextHoldings = { ...portfolio.holdings };
      if (held - sellQty < 1e-9) delete nextHoldings[symbol]; else nextHoldings[symbol] = held - sellQty;
      setPortfolio((prev) => ({
        cash: prev.cash + proceeds,
        holdings: nextHoldings,
        trades: [{ id: Date.now(), time: new Date().toISOString(), symbol, side: 'sell', qty: sellQty, price: priceNow, total: proceeds, currency }, ...(prev.trades || [])].slice(0, 50),
      }));
      setPaperMsg(`Vendiste ${fmtNum(sellQty, 6)} ${symbol} por ${fmt(proceeds, currency)} (virtual).`);
      unlock('primera_operacion');
    }
  };
  const resetPortfolio = () => {
    setPortfolio({ cash: START_CASH, holdings: {}, trades: [] });
    setPaperMsg('Cartera reiniciada a 10.000 virtuales.');
  };
  const addPriceAlert = () => {
    const target = Number(alertTarget);
    if (!target || target <= 0) { setPaperMsg('Pon un precio objetivo mayor que 0 para la alerta.'); return; }
    // v9: no crear la misma alerta dos veces. Si ya existe una activa
    // con el mismo activo, moneda, dirección y precio, no se duplica.
    const dup = priceAlerts.some((a) => !a.triggered && a.symbol === symbol && a.currency === currency && a.direction === alertDir && Number(a.target) === target);
    if (dup) { setPaperMsg(`Ya tienes esa alerta activa: ${symbol} ${alertDir === 'above' ? 'por encima de' : 'por debajo de'} ${fmt(target, currency)}. No se creó otra igual.`); return; }
    const alert = { id: Date.now(), symbol, currency, target, direction: alertDir, createdAt: new Date().toISOString(), triggered: false };
    setPriceAlerts((prev) => [alert, ...prev].slice(0, 20));
    unlock('primera_alerta');
    setPaperMsg(`Alerta creada: ${symbol} ${alertDir === 'above' ? 'por encima de' : 'por debajo de'} ${fmt(target, currency)}.`);
  };

  // --- Screener: se calcula bajo demanda (10 llamadas a /api/candles, 1h) ---
  const runScreener = async () => {
    setScreenLoading(true);
    setScreenError('');
    try {
      const settled = await Promise.allSettled(ASSETS.map((a) => api(`/api/candles?symbol=${a.symbol}&currency=${currency}&interval=1h`)));
      const analyses = {};
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value.candles && r.value.candles.length) analyses[ASSETS[i].symbol] = analyze(r.value.candles);
      });
      setScreenRows(screenOpportunities(markets, analyses));
      setScreenUpdatedAt(new Date().toLocaleTimeString('es-US'));
    } catch (e) { setScreenError(String(e.message || e)); }
    finally { setScreenLoading(false); }
  };

  // --- Perfil local + liga privada + compartir ---
  const saveNickname = () => {
    const nick = nicknameInput.trim().slice(0, 20);
    saveLS('cev_profile_v1', { nickname: nick });
    setNickname(nick);
    setProfileMsg(nick ? `Apodo guardado: ${nick}. Se usa en la liga y en la tarjeta para compartir.` : 'Apodo borrado.');
  };
  const createPrivateLeague = () => {
    const name = leagueNameInput.trim().slice(0, 30) || 'Mi liga';
    const code = genCode();
    const lg = { code, name, members: [nickname || 'Tú'], createdAt: new Date().toISOString() };
    saveLS('cev_private_league_v1', lg);
    setPrivateLeague(lg);
    setLeagueMsg(`Liga "${name}" creada. Código: ${code}. Compártelo con tus amigos. Es local/demo: el código solo existe en este navegador.`);
  };
  const joinPrivateLeague = () => {
    const code = joinCodeInput.trim().toUpperCase();
    if (!code) { setLeagueMsg('Escribe un código para unirte.'); return; }
    if (privateLeague && privateLeague.code === code) { setLeagueMsg('Ya estás en esa liga.'); return; }
    const lg = { code, name: `Liga ${code}`, members: [nickname || 'Tú'], createdAt: new Date().toISOString(), joined: true };
    saveLS('cev_private_league_v1', lg);
    setPrivateLeague(lg);
    setLeagueMsg(`Te uniste a la liga con código ${code}. Es local/demo: solo existe en este navegador, no hay cuentas ni servidor de ligas.`);
  };
  const leavePrivateLeague = () => {
    saveLS('cev_private_league_v1', null);
    setPrivateLeague(null);
    setLeagueMsg('Saliste de la liga privada local.');
  };
  const bestTrade = (portfolio.trades || []).reduce((best, tr) => (!best || tr.total > best.total ? tr : best), null);
  const bestTradeText = bestTrade
    ? `${bestTrade.side === 'buy' ? 'Compró' : 'Vendió'} ${fmtNum(bestTrade.qty, 4)} ${bestTrade.symbol} por ${fmt(bestTrade.total, bestTrade.currency || currency)}`
    : null;
  const shareData = {
    nickname, pnl: myWeeklyPnl, pnlPct: myWeeklyReturn, rank: myRank,
    leagueSize: standings.length, weekLabel: weekKey, bestTrade: bestTradeText, currencySym: CUR[currency],
  };
  const doShareText = async () => {
    const text = shareText(shareData);
    if (navigator.share) {
      try { await navigator.share({ title: 'Cripto en Vivo', text }); setShareMsg('Compartido.'); return; }
      catch { /* el usuario canceló: cae al portapapeles */ }
    }
    try {
      await navigator.clipboard.writeText(text);
      setShareMsg('Texto copiado al portapapeles. Pégalo en WhatsApp.');
    } catch {
      setShareMsg('No se pudo copiar automáticamente. Usa el botón de WhatsApp de abajo.');
    }
  };
  const downloadCard = () => {
    const canvas = shareCanvasRef.current;
    if (!canvas) return;
    drawShareCard(canvas, shareData);
    const a = document.createElement('a');
    a.download = `cripto-en-vivo-${weekKey}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
    setShareMsg('Tarjeta descargada como imagen PNG. Compártela en WhatsApp.');
  };

  const change24 = ticker?.change24h;
  const sigColor = analysis.label === 'Posible subida' ? '#22c55e' : analysis.label === 'Posible bajada' ? '#ef4444' : '#94a3b8';
  const sigPct = Math.round(((analysis.score + 100) / 200) * 100);
  const upCount = markets.filter((m) => (m.change24h ?? 0) >= 0).length;
  const downCount = markets.length - upCount;
  const avgChange = markets.length ? markets.reduce((s, m) => s + (m.change24h ?? 0), 0) / markets.length : null;
  const mood = !markets.length ? 'Esperando datos…'
    : upCount >= 8 && (avgChange ?? 0) > 1 ? 'Euforia: casi todo sube'
    : upCount >= 6 ? 'Optimista: la mayoría sube'
    : downCount >= 8 && (avgChange ?? 0) < -1 ? 'Pánico: casi todo baja'
    : downCount >= 6 ? 'Pesimista: la mayoría baja'
    : 'Neutral: el mercado no se decide';
  const fgColor = !fearGreed ? '#94a3b8' : fearGreed.value <= 24 ? '#ef4444' : fearGreed.value <= 44 ? '#f97316' : fearGreed.value <= 55 ? '#eab308' : fearGreed.value <= 75 ? '#84cc16' : '#22c55e';

  return (
    <div className="app">
      {/* Ticker tape superior: los 10 precios en vivo, en movimiento */}
      <div className="tape" aria-label="Precios en vivo">
        <div className="tape-track">
          {[0, 1].map((dup) => (
            <span key={dup} className="tape-group">
              {markets.length ? markets.map((m) => (
                <span key={`${dup}-${m.symbol}`} className="tape-item">
                  <b>{m.symbol}</b> {m.price ? fmt(m.price, currency) : '—'}
                  <span className={(m.change24h ?? 0) >= 0 ? 'up' : 'down'}> {(m.change24h ?? 0) >= 0 ? '▲' : '▼'} {m.change24h != null ? `${Math.abs(m.change24h).toFixed(2)}%` : '—'}</span>
                </span>
              )) : <span className="tape-item">Esperando precios en vivo…</span>}
            </span>
          ))}
        </div>
      </div>

      <header>
        <div><h1>₿ Cripto en Vivo</h1><p>Precios reales desde el servidor · React + Node · {VERSION_LABEL}</p></div>
        <div className="badge">{source ? `Fuente: ${source}` : 'Conectando…'} · {updatedAt ? new Date(updatedAt).toLocaleTimeString('es-US') : ''}{latencyMs != null ? ` · latencia ${latencyMs} ms` : ''}</div>
      </header>

      <p className="warn">⚠️ Prueba educativa con dinero VIRTUAL. Nada de esto es una recomendación de inversión, no hay dinero real ni registro obligatorio. Tu cartera, liga, misiones y alertas viven solo en este navegador.</p>

      {error && <div className="error">No se pudo cargar desde el servidor: {error}. Revisa que el servidor esté corriendo (npm run dev en la carpeta raíz).</div>}

      <section className="card">
        <h2>Mercados</h2>
        <p className="muted">Toca un activo para ver su gráfico y su señal. El mini gráfico es el precio de los últimos minutos en vivo.</p>
        <div className="cur">
          {Object.keys(CUR).map((c) => <button key={c} className={currency === c ? 'on' : ''} onClick={() => setCurrency(c)}>{c} {CUR[c]}</button>)}
        </div>
        <div className="tabs">
          {ASSETS.map((a) => {
            const m = markets.find((x) => x.symbol === a.symbol);
            return (
              <button key={a.symbol} className={symbol === a.symbol ? 'tab on' : 'tab'} onClick={() => setSymbol(a.symbol)}>
                <b>{a.symbol} / {currency}</b><span>{a.name}</span>
                <span className="price">{m?.price ? fmt(m.price, currency) : '—'}</span>
                <Sparkline values={sparkHist[a.symbol] || []} />
                <span className={m?.change24h >= 0 ? 'up' : 'down'}>{m?.change24h != null ? `${m.change24h >= 0 ? '+' : ''}${m.change24h.toFixed(2)}%` : '—'}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* v8: VEREDICTO — lo primero que ve el usuario: ¿compro o vendo? */}
      <section className={`card verdict-card verdict-${mtfVerdict.verdict.key} ${mtfVerdict.conflict ? 'verdict-conflict' : ''}`} aria-label="Veredicto de trading">
        <p className="verdict-kicker">SEÑAL PARA {symbol} · CONFLUENCIA 1m / 5m / 15m / 1h · EDUCATIVO, NO ES RECOMENDACIÓN</p>
        <div className="verdict-main">
          <div className="verdict-word">{mtfVerdict.verdict.icon} {mtfVerdict.verdict.label}</div>
          <div className="verdict-meta">
            <span>Puntuación: <b>{mtfVerdict.score}</b> / −100 a +100</span>
            <span>Fuerza: <b>{mtfVerdict.verdict.key === 'wait' && !mtfVerdict.conflict ? 'Débil' : mtfVerdict.score >= 60 || mtfVerdict.score <= -60 ? 'Muy fuerte' : Math.abs(mtfVerdict.score) >= 40 ? 'Fuerte' : Math.abs(mtfVerdict.score) >= 25 ? 'Moderada' : 'Débil'}</b></span>
            <span>Confianza (confluencia): <b>{mtfVerdict.confidence}%</b></span>
          </div>
        </div>
        {mtfVerdict.conflict ? (
          <p className="conflict-banner">⚠️ SEÑALES EN CONFLICTO: unos timeframes dicen COMPRAR y otros VENDER. No hay acuerdo — esperar es la decisión prudente.</p>
        ) : (
          <p className="muted">Confianza = índice de confluencia (fuerza de la señal + cuántos timeframes coinciden). NO es una probabilidad de ganar: un 90% no significa que ganes el 90% de las veces.</p>
        )}
        <div className="score-bar" aria-hidden="true"><div style={{ width: `${Math.round(((mtfVerdict.score + 100) / 200) * 100)}%`, background: mtfVerdict.verdict.key === 'buy' ? '#22c55e' : mtfVerdict.verdict.key === 'sell' ? '#ef4444' : '#94a3b8' }} /></div>
        <div className="verdict-price">Precio ahora: <b>{ticker?.price ? fmt(ticker.price, currency) : '—'}</b>{change24 != null ? <span className={change24 >= 0 ? 'up' : 'down'}> {change24 >= 0 ? '▲' : '▼'} {change24.toFixed(2)}% 24h</span> : null}</div>

        <h3>¿Por qué dice esto?</h3>
        {verdictReasons.length > 0 ? (
          <ul className="reasons">
            {verdictReasons.map((r, i) => (
              <li key={i} className={`reason-${r.dir}`}><b>{r.icon}</b> {r.text}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">Cargando indicadores para explicar la señal…</p>
        )}

        <h3>Plan de operación — sugerido, educativo</h3>
        {plan ? (
          <div>
            {plan.entry ? (
              <div className="stats plan-stats">
                <div><span>Entrada sugerida</span><b>{fmt(plan.entry, currency)}</b></div>
                <div><span>Stop loss sugerido</span><b>{fmt(plan.stopLoss, currency)}</b></div>
                <div><span>Take profit sugerido</span><b>{fmt(plan.takeProfit, currency)}</b></div>
                <div><span>Ratio riesgo/beneficio</span><b>1 : {plan.rr}</b></div>
              </div>
            ) : (
              <div className="stats plan-stats">
                <div><span>Entrada sugerida</span><b>Sin entrada</b></div>
                <div><span>Se activa si sube a</span><b>{fmt(plan.activationUp, currency)}</b></div>
                <div><span>Se activa si baja a</span><b>{fmt(plan.activationDown, currency)}</b></div>
                <div><span>Volatilidad (ATR)</span><b>{fmt(plan.atr, currency)}</b></div>
              </div>
            )}
            <p className="muted">{plan.note} {plan.entry ? `Stop a 1 ATR (${fmt(plan.atr, currency)}) y objetivo a 2 ATR, calculados con la volatilidad real de las últimas 14 velas.` : `Los niveles de activación están a 1 ATR (${fmt(plan.atr, currency)}) del precio actual: si el precio los rompe con señal clara, ahí se activa el plan.`} Esto es un ejemplo educativo con dinero virtual: si operas con dinero real, el riesgo es tuyo y puedes perderlo todo.</p>
            <div className="row">
              <button onClick={() => { if (mtfVerdict.verdict.key === 'buy') doTrade('buy'); else if (mtfVerdict.verdict.key === 'sell') doTrade('sell'); else setPaperMsg('El veredicto es ESPERAR: no hay operación sugerida ahora.'); }}>Operar según la señal (virtual)</button>
              <button onClick={() => { setAlertTarget(String(Math.round((ticker?.price || 0) * (mtfVerdict.verdict.key === 'sell' ? 0.98 : 1.02)))); setPaperMsg('Precio objetivo puesto en el formulario de alertas de abajo: complétalo y pulsa "Añadir alerta".'); }}>Crear alerta de este precio</button>
            </div>
          </div>
        ) : (
          <p className="muted">Calculando el plan con la volatilidad reciente…</p>
        )}

        <h3>Confluencia entre temporalidades</h3>
        <table className="league-table mtf-table">
          <thead><tr><th>Temporalidad</th><th>Señal</th><th>Puntuación</th></tr></thead>
          <tbody>
            {mtfVerdict.rows.map((r) => (
              <tr key={r.tf}>
                <td><b>{r.tf}</b></td>
                <td className={r.key === 'buy' ? 'up' : r.key === 'sell' ? 'down' : ''}><b>{r.key === 'buy' ? '▲ COMPRAR' : r.key === 'sell' ? '▼ VENDER' : r.key === 'wait' ? '● ESPERAR' : '— Sin datos'}</b></td>
                <td>{r.score != null ? r.score : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">La temporalidad de 1h pesa más que la de 1m en el veredicto final. Si se contradicen, el veredicto es ESPERAR.</p>
      </section>

      {/* v8: HISTORIAL DE SEÑALES — ¿sirvió la señal? */}
      <section className="card">
        <h2>📜 Historial de señales — {symbol} ({candleInterval})</h2>
        <p className="muted">Las últimas señales claras y lo que pasó en la vela siguiente. Si la señal decía COMPRAR y el precio subió, cuenta como acierto. El pasado no predice el futuro.</p>
        {candleInterval === '1m' && <p className="warn">⚠️ Estás viendo velas de 1 minuto: 1m es ruido, no apto para decidir. La señal cambia a cada segundo y acierta poco (BTC 1m acertó 2 de 10 en la medición del 10-nov). Para decidir, usa 1h.</p>}
        {histSignals.length > 0 ? (
          <table className="league-table">
            <thead><tr><th>Hora</th><th>Señal</th><th>Precio</th><th>Después</th><th>Resultado</th></tr></thead>
            <tbody>
              {histSignals.map((h, i) => (
                <tr key={i}>
                  <td>{new Date(h.time * 1000).toLocaleTimeString('es-US')}</td>
                  <td className={h.key === 'buy' ? 'up' : 'down'}><b>{h.key === 'buy' ? '▲ COMPRAR' : '▼ VENDER'}</b> ({h.score})</td>
                  <td>{fmt(h.price, currency)}</td>
                  <td className={h.changePct >= 0 ? 'up' : 'down'}>{h.changePct >= 0 ? '+' : ''}{h.changePct.toFixed(2)}%</td>
                  <td><b>{h.won ? '✅ Acertó' : '❌ Falló'}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">Cargando velas para el historial de señales…</p>
        )}
      </section>

      <section className={`card ${chartFull ? 'chart-full' : ''}`}>
        <div className="row"><h2>Precio actual · {symbol}-{currency}</h2>
          <span className={flash === 'up' ? 'flash up' : flash === 'down' ? 'flash down' : 'flash'}>{change24 != null ? `${change24 >= 0 ? '▲' : '▼'} ${change24.toFixed(2)}% 24h` : 'Esperando datos…'}</span>
          <button onClick={() => setChartFull((f) => !f)}>{chartFull ? '⤢ Salir de pantalla completa' : '⛶ Pantalla completa'}</button>
        </div>
        <div className={`big ${flash === 'up' ? 'price-up' : flash === 'down' ? 'price-down' : ''}`} key={ticker?.price}>{ticker?.price ? fmt(ticker.price, currency) : '—'}</div>
        <div className="stats">
          <div><span>Máximo 24h</span><b>{fmt(ticker?.high24h, currency)}</b></div>
          <div><span>Mínimo 24h</span><b>{fmt(ticker?.low24h, currency)}</b></div>
          <div><span>Apertura 24h</span><b>{fmt(ticker?.open24h, currency)}</b></div>
          <div><span>Volumen 24h</span><b>{ticker?.volume24h ? ticker.volume24h.toLocaleString('es-US') : '—'}</b></div>
        </div>
        <div className="intervals">
          {INTERVALS.map((i) => <button key={i} className={candleInterval === i ? 'on' : ''} onClick={() => setCandleInterval(i)}>{i === '1h' ? '1H' : i === '1d' ? '1D' : i}</button>)}
        </div>
        <div className="row toggles">
          <button className={showEma ? 'on' : ''} onClick={() => setShowEma((v) => !v)}>EMA 20/50 {showEma ? '✓' : ''}</button>
          <button className={showBoll ? 'on' : ''} onClick={() => setShowBoll((v) => !v)}>Bollinger {showBoll ? '✓' : ''}</button>
          <button className={showRsi ? 'on' : ''} onClick={() => setShowRsi((v) => !v)}>RSI (panel) {showRsi ? '✓' : ''}</button>
          <button className={compareBtc ? 'on' : ''} onClick={() => setCompareBtc((v) => !v)} disabled={symbol === 'BTC'}>Comparar vs BTC {compareBtc ? '✓' : ''}</button>
        </div>
        <div ref={chartRef} className="chart" />
        {showRsi && <div ref={rsiChartRef} className="chart rsi-chart" />}
        <p className="muted">Actualización: precio cada 1 s, última vela se mueve con cada tick, velas completas cada 6 s, desde el servidor (Coinbase → Kraken → Binance US → CoinGecko). Latencia del último fetch: {latencyMs != null ? `${latencyMs} ms` : '—'}. {compareBtc && symbol !== 'BTC' ? 'La línea morada es el índice relativo vs BTC (100 = igual que al inicio del gráfico; sube si el activo rinde mejor que BTC).' : ''}</p>
      </section>

      <section className="card">
        <h2>Análisis en vivo · Prueba educativa</h2>
        <p className="warn">⚠️ Esto es solo una prueba educativa. Ningún patrón ni indicador predice el precio. NO es una recomendación de inversión.</p>
        <div className={`signal ${analysis.label === 'Posible subida' ? 'signal-up' : analysis.label === 'Posible bajada' ? 'signal-down' : ''}`} style={{ borderColor: sigColor }}>
          <b style={{ color: sigColor }}>{analysis.label === 'Posible subida' ? '▲ Posible subida' : analysis.label === 'Posible bajada' ? '▼ Posible bajada' : '● Sin señal clara'}</b>
          <span>Puntuación: {analysis.score} / 100 · {analysis.strength || ''}</span>
          <div className="score-bar" aria-hidden="true"><div style={{ width: `${sigPct}%`, background: sigColor }} /></div>
        </div>
        <p className="muted">{analysis.detail}</p>
        <div className="stats">
          <div><span>RSI (14)</span><b>{analysis.rsi != null ? analysis.rsi.toFixed(1) : '—'}</b></div>
          <div><span>MACD hist.</span><b>{analysis.macd ? analysis.macd.histogram.toFixed(2) : '—'}</b></div>
          <div><span>EMA 20 / 50</span><b>{analysis.ema20 ? `${analysis.ema20.toFixed(2)} / ${analysis.ema50?.toFixed(2)}` : '—'}</b></div>
          <div><span>Bollinger %B</span><b>{analysis.bollinger ? analysis.bollinger.pctB.toFixed(2) : '—'}</b></div>
        </div>
        {analysis.patterns.length > 0 && (
          <ul>{analysis.patterns.map((p, i) => <li key={i}><b>{p.dir === 'up' ? '▲' : p.dir === 'down' ? '▼' : '●'} {p.name}:</b> {p.text}</li>)}</ul>
        )}
        <div className="row">
          <button onClick={askNotif}>{notif === 'granted' ? '✓ Notificaciones activas' : 'Activar notificaciones del navegador'}</button>
          <button onClick={() => setAlerts([])}>Limpiar alertas</button>
          <button onClick={() => completeMission('leer_senal')}>{missionDay.done.leer_senal ? '✓ Señal de hoy leída (+10 XP)' : 'Marcar señal como leída (+10 XP)'}</button>
        </div>
        {alerts.length > 0 && <ul className="alerts">{alerts.map((a, i) => <li key={i}>🔔 {a}</li>)}</ul>}
      </section>

      {/* Backtest de señales */}
      <section className="card">
        <h2>🧪 Backtest de señales — {symbol} ({candleInterval})</h2>
        <p className="warn">⚠️ Prueba educativa sobre velas pasadas. Que una señal acertara antes NO significa que acierte mañana. Sin promesas.</p>
        {candleInterval === '1m' && <p className="warn">⚠️ Backtest en 1 minuto: 1m es ruido, no apto para decidir. El backtest por defecto es 1h, donde la señal acierta más.</p>}
        {backtest.total > 0 ? (
          <div>
            <p className="big-backtest">La señal acertó <b>{backtest.wins} de {backtest.total}</b> veces ({backtest.pct}%)</p>
            <div className="stats">
              <div><span>Señales de subida</span><b>{backtest.upWins} de {backtest.upTotal} ({backtest.upTotal ? Math.round((backtest.upWins / backtest.upTotal) * 100) : '—'}%)</b></div>
              <div><span>Señales de bajada</span><b>{backtest.downWins} de {backtest.downTotal} ({backtest.downTotal ? Math.round((backtest.downWins / backtest.downTotal) * 100) : '—'}%)</b></div>
              <div><span>Ventanas analizadas</span><b>{backtest.total} con señal clara</b></div>
            </div>
            <p className="muted">Método: en cada ventana de velas se calculó la señal con los mismos indicadores del análisis en vivo y se comprobó si la vela siguiente fue en la dirección sugerida. Solo cuentan las ventanas con señal clara.</p>
          </div>
        ) : (
          <p className="muted">{backtest.note || 'Cargando velas para el backtest…'}</p>
        )}
      </section>

      {/* Screener / Oportunidades del día */}
      <section className="card">
        <h2>🔍 Oportunidades del día</h2>
        <p className="muted">Solo cuentan como oportunidad las señales CLARAS (puntuación ≥ 25 de compra o ≤ −25 de venta, velas de 1h). Las débiles van abajo como "sin oportunidad clara", sin número. Toca "Actualizar" para calcularlo con datos frescos.</p>
        <div className="row">
          <button onClick={runScreener} disabled={screenLoading}>{screenLoading ? 'Calculando…' : 'Actualizar screener'}</button>
          {screenUpdatedAt && <span className="muted">Actualizado a las {screenUpdatedAt}</span>}
        </div>
        {screenError && <p className="errtext">{screenError}</p>}
        {screenRows.opportunities.length > 0 ? (
          <ol className="screener">
            {screenRows.opportunities.map((r, i) => (
              <li key={r.symbol} onClick={() => setSymbol(r.symbol)} title="Toca para ver su gráfico">
                <b>#{i + 1} {r.symbol}</b> — {r.price ? fmt(r.price, currency) : '—'}
                <span className={r.change24h >= 0 ? 'up' : 'down'}> {r.change24h >= 0 ? '+' : ''}{r.change24h.toFixed(2)}% 24h</span>
                <span className="muted"> · RSI {r.rsi != null ? r.rsi.toFixed(0) : '—'} · señal {r.score != null ? r.score : '—'} · {r.points} pts</span>
                <br /><span className="muted">{r.opportunity === 'buy' ? '▲ Oportunidad de compra: ' : '▼ Oportunidad de venta: '}{r.reason}</span>
              </li>
            ))}
          </ol>
        ) : (
          screenRows.rest.length > 0 && <p className="muted">Hoy no hay oportunidades claras: ninguna señal llega a ±25. Abajo, las débiles.</p>
        )}
        {screenRows.rest.length > 0 && (
          <div>
            <h3>Sin oportunidad clara</h3>
            <ul className="screener-rest">
              {screenRows.rest.map((r) => (
                <li key={r.symbol} onClick={() => setSymbol(r.symbol)} title="Toca para ver su gráfico">
                  <b>{r.symbol}</b> — {r.price ? fmt(r.price, currency) : '—'}
                  <span className={r.change24h >= 0 ? 'up' : 'down'}> {r.change24h >= 0 ? '+' : ''}{r.change24h.toFixed(2)}% 24h</span>
                  <span className="muted"> · RSI {r.rsi != null ? r.rsi.toFixed(0) : '—'} · señal {r.score != null ? r.score : '—'} · {r.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {screenRows.opportunities.length === 0 && screenRows.rest.length === 0 && !screenLoading && <p className="muted">Todavía no hay screener: pulsa "Actualizar screener".</p>}
      </section>

      {/* Cartera virtual */}
      <section className="card">
        <h2>💰 Cartera virtual — dinero de mentira</h2>
        <p className="warn">⚠️ Esto es un juego con $10.000 virtuales. NO es dinero real, no se conecta a ningún exchange y no se puede retirar nada.</p>
        <div className="stats">
          <div><span>Efectivo virtual</span><b>{fmt(portfolio.cash, currency)}</b></div>
          <div><span>En criptos</span><b>{fmt(holdingsValue, currency)}</b></div>
          <div><span>Valor total</span><b>{fmt(totalValue, currency)}</b></div>
          <div><span>Ganancia / pérdida</span><b className={pnl >= 0 ? 'up' : 'down'}>{pnl >= 0 ? '+' : ''}{fmt(pnl, currency)} ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)</b></div>
        </div>
        {Object.keys(portfolio.holdings || {}).length > 0 && (
          <ul>{Object.entries(portfolio.holdings).map(([sym, qty]) => {
            const p = sym === symbol ? priceNow : markets.find((m) => m.symbol === sym)?.price;
            return <li key={sym}><b>{sym}:</b> {fmtNum(qty, 6)} · vale {p ? fmt(qty * p, currency) : '—'}</li>;
          })}</ul>
        )}
        <div className="row">
          <label>Cantidad ({CUR[currency]}): <input type="number" min="1" step="10" value={paperAmount} onChange={(e) => setPaperAmount(e.target.value)} /></label>
          <button onClick={() => doTrade('buy')}>Comprar {symbol}</button>
          <button onClick={() => doTrade('sell')}>Vender {symbol}</button>
          <button onClick={() => { setPaperAmount('100'); doTrade('buy'); }}>Compra rápida $100</button>
          <button onClick={resetPortfolio}>Reiniciar a 10.000</button>
        </div>
        <p className="muted">Precio de la operación: {priceNow ? fmt(priceNow, currency) : '—'} por {symbol}. Se guarda en este navegador, aunque cierres la app.</p>
        {paperMsg && <p className="errtext" style={{ color: '#e2e8f0' }}>{paperMsg}</p>}
        {(portfolio.trades || []).length > 0 && (
          <div>
            <h3>Historial de operaciones (virtual)</h3>
            <ul>{portfolio.trades.slice(0, 10).map((tr) => (
              <li key={tr.id}>{new Date(tr.time).toLocaleTimeString('es-US')} — {tr.side === 'buy' ? 'Compró' : 'Vendió'} {fmtNum(tr.qty, 6)} {tr.symbol} a {fmt(tr.price, tr.currency || currency)} · total {fmt(tr.total, tr.currency || currency)}</li>
            ))}</ul>
          </div>
        )}
      </section>

      {/* Liga semanal (demo/local) */}
      <section className="card no-print">
        <h2>🏆 Liga semanal — {weekKey}</h2>
        <p className="warn">⚠️ Liga DEMO y local: tus rivales son jugadores simulados de ejemplo (no personas reales ni cuentas) y tu puesto vive solo en este navegador. Todos empiezan el lunes con $10.000 virtuales; la liga se reinicia cada lunes.</p>
        {weekWinner && (
          <p className="winner">🏆 Ganador de la semana ({weekKey}): <b>{weekWinner.name}</b> con {weekWinner.ret >= 0 ? '+' : ''}{weekWinner.ret.toFixed(2)}% {weekWinner.me ? '— ¡eres tú!' : ''}</p>
        )}
        <p className="muted">Tu semana: {myWeeklyPnl >= 0 ? '+' : ''}{fmt(myWeeklyPnl, currency)} ({myWeeklyReturn >= 0 ? '+' : ''}{myWeeklyReturn.toFixed(2)}%) desde {fmt(weekStart, currency)} · Puesto {myRank} de {standings.length}{isSunday ? ' · Hoy domingo se cierra la semana.' : ' · La semana termina el domingo.'}</p>
        <table className="league-table">
          <thead><tr><th>#</th><th>Jugador</th><th>Rendimiento semanal</th></tr></thead>
          <tbody>
            {standings.map((s) => (
              <tr key={s.name} className={s.me ? 'me' : ''}>
                <td>{s.rank === 1 ? '🥇' : s.rank === 2 ? '🥈' : s.rank === 3 ? '🥉' : s.rank}</td>
                <td><b>{s.name}</b>{s.demo ? ' <span className="muted">(demo)</span>' : ''}</td>
                <td className={s.ret >= 0 ? 'up' : 'down'}>{s.ret >= 0 ? '+' : ''}{s.ret.toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Liga privada con código */}
      <section className="card no-print">
        <h2>🔐 Liga privada con código</h2>
        <p className="muted">Crea una liga con un código y compártelo con tus amigos, o únete con un código que te den. Es local/demo: la liga y sus miembros solo existen en este navegador; no hay cuentas ni servidor de ligas.</p>
        {privateLeague ? (
          <div>
            <p>Estás en la liga privada <b>"{privateLeague.name}"</b> · código <b className="code">{privateLeague.code}</b> · miembros locales: {privateLeague.members.join(', ')}</p>
            <div className="row"><button onClick={leavePrivateLeague}>Salir de la liga privada</button></div>
          </div>
        ) : (
          <div className="row">
            <label>Nombre de tu liga: <input type="text" maxLength={30} value={leagueNameInput} placeholder="Ej.: Liga de Luis" onChange={(e) => setLeagueNameInput(e.target.value)} /></label>
            <button onClick={createPrivateLeague}>Crear liga con código</button>
            <label>Código para unirse: <input type="text" maxLength={10} value={joinCodeInput} placeholder="Ej.: K7X2Q9" onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())} /></label>
            <button onClick={joinPrivateLeague}>Unirse con código</button>
          </div>
        )}
        {leagueMsg && <p className="muted">{leagueMsg}</p>}
      </section>

      {/* Misiones diarias y XP */}
      <section className="card no-print">
        <h2>🎯 Misiones diarias y XP — Nivel {level}</h2>
        <p className="muted">XP total: <b>{xpTotal}</b> · Nivel {level} · {xpInLevel}/{XP_PER_LEVEL} XP para el nivel {level + 1} · Hoy llevas {missionsDoneToday} de {MISSIONS.length} misiones.</p>
        <div className="score-bar" aria-hidden="true"><div style={{ width: `${(xpInLevel / XP_PER_LEVEL) * 100}%`, background: '#f59e0b' }} /></div>
        <div className="achievements">
          {MISSIONS.map((m) => (
            <div key={m.id} className={missionDay.done[m.id] ? 'ach unlocked' : 'ach locked'}>
              <b>{missionDay.done[m.id] ? '✓' : '○'} {m.name} · +{m.xp} XP</b><span>{m.desc}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Compartir por WhatsApp */}
      <section className="card no-print">
        <h2>📣 Compartir mi semana por WhatsApp</h2>
        <p className="muted">Comparte tu P&L virtual de la semana, tu puesto en la liga y tu mejor operación. Solo se comparte lo que tú pulses; nada sale solo de tu navegador.</p>
        <div className="row">
          <button onClick={doShareText}>Compartir texto</button>
          <a className="btn-link" href={whatsappUrl(shareText(shareData))} target="_blank" rel="noreferrer">Abrir en WhatsApp</a>
          <button onClick={downloadCard}>Descargar tarjeta como imagen</button>
        </div>
        {shareMsg && <p className="muted">{shareMsg}</p>}
        <canvas ref={shareCanvasRef} style={{ display: 'none' }} aria-hidden="true" />
      </section>

      {/* Alertas de precio */}
      <section className="card">
        <h2>🔔 Alertas de precio</h2>
        <p className="muted">Te aviso en pantalla (y con notificación si la activaste) cuando {symbol} cruce tu precio objetivo.</p>
        <div className="row">
          <label>Precio objetivo ({CUR[currency]}): <input type="number" min="0" step="1" value={alertTarget} placeholder={priceNow ? String(Math.round(priceNow * 1.05)) : ''} onChange={(e) => setAlertTarget(e.target.value)} /></label>
          <select value={alertDir} onChange={(e) => setAlertDir(e.target.value)}>
            <option value="above">Sube por encima de</option>
            <option value="below">Baja por debajo de</option>
          </select>
          <button onClick={addPriceAlert}>Añadir alerta para {symbol}</button>
        </div>
        {priceAlerts.length > 0 && (
          <ul>{priceAlerts.map((a) => (
            <li key={a.id}>
              <b>{a.symbol}</b> {a.direction === 'above' ? 'por encima de' : 'por debajo de'} {fmt(a.target, a.currency)} — {a.triggered ? `✅ sonó ${a.triggeredAt ? new Date(a.triggeredAt).toLocaleTimeString('es-US') : ''}` : 'activa'}
              <button onClick={() => setPriceAlerts((prev) => prev.filter((x) => x.id !== a.id))}>Quitar</button>
            </li>
          ))}</ul>
        )}
      </section>

      {/* Logros */}
      <section className="card no-print">
        <h2>🏆 Logros y racha</h2>
        <p className="muted">Todo queda solo en tu navegador. Racha actual: <b>{streak.days} día{streak.days === 1 ? '' : 's'}</b>.</p>
        <div className="achievements">
          {ACHIEVEMENTS.map((a) => (
            <div key={a.id} className={achievements.includes(a.id) ? 'ach unlocked' : 'ach locked'}>
              <b>{achievements.includes(a.id) ? '✓' : '○'} {a.name}</b><span>{a.desc}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Perfil local: apodo sin cuentas */}
      <section className="card profile no-print">
        <h2>👤 Tu perfil local {nickname ? `— ${nickname}` : ''}</h2>
        <p className="muted">Sin registro ni contraseña: solo un apodo guardado en este navegador, que se usa en la liga semanal y en la tarjeta para compartir. Nada se envía a ningún servidor.</p>
        <div className="row">
          <label>Apodo: <input type="text" maxLength={20} value={nicknameInput} placeholder="Ej.: Luis" onChange={(e) => setNicknameInput(e.target.value)} /></label>
          <button onClick={saveNickname}>Guardar apodo</button>
          {profileMsg && <span className="muted">{profileMsg}</span>}
        </div>
      </section>


      {/* Panel de mercado PRO */}
      <section className="card">
        <h2>📊 Panel de mercado PRO</h2>
        <div className="stats">
          <div><span>Dominio de BTC (CoinGecko)</span><b>{domText}</b></div>
          <div><span>Capitalización total (CoinGecko)</span><b>{capText}</b></div>
          <div><span>Miedo y codicia (estimado propio)</span><b style={{ color: fgColor }}>{fearGreed ? `${fearGreed.value} / 100 · ${fearGreed.label}` : '—'}</b></div>
          <div><span>Qué está caliente hoy</span><b className={heat.length && heat[0].change24h >= 0 ? 'up' : 'down'}>{heat.length ? `▲ ${heat[0].symbol} +${heat[0].change24h.toFixed(2)}%` : '—'}</b></div>
        </div>
        <p className="muted">Capitalización total y dominio de BTC: datos reales de CoinGecko (servidor, /api/global, se refresca cada 5 min). Si CoinGecko está en pausa por límite (429), se muestra "No disponible" en vez de un número inventado. El índice de miedo y codicia es un estimado propio con amplitud, impulso y RSI; NO es el índice oficial de alternative.me.</p>
        {heat.length > 0 && (
          <div className="heatmap" aria-label="Mapa de calor de las 10 criptos">
            {heat.map((m) => {
              const v = m.change24h ?? 0;
              const intensity = Math.min(1, Math.abs(v) / 6);
              const bg = v >= 0 ? `rgba(34,197,94,${0.15 + intensity * 0.65})` : `rgba(239,68,68,${0.15 + intensity * 0.65})`;
              return (
                <button key={m.symbol} className="heat-cell" style={{ background: bg }} onClick={() => setSymbol(m.symbol)} title={`${m.symbol}: ${v >= 0 ? '+' : ''}${v.toFixed(2)}% en 24 h — toca para ver su gráfico`}>
                  <b>{m.symbol}</b><span>{v >= 0 ? '+' : ''}{v.toFixed(2)}%</span>
                </button>
              );
            })}
          </div>
        )}
      </section>


      {/* Racha + ánimo del mercado */}
      <section className="card mood">
        <div className="mood-row">
          <div><span className="muted">Racha abriendo la app</span><b className="streak">🔥 {streak.days} día{streak.days === 1 ? '' : 's'} · {streak.totalDays} días en total</b></div>
          <div><span className="muted">Ánimo del mercado (10 criptos, 24 h)</span><b>{mood}</b></div>
          <div><span className="muted">Suben / bajan</span><b><span className="up">{upCount} ▲</span> / <span className="down">{downCount} ▼</span>{avgChange != null ? ` · media ${avgChange >= 0 ? '+' : ''}${avgChange.toFixed(2)}%` : ''}</b></div>
        </div>
        <div className="mood-bar" aria-hidden="true">
          <div className="mood-up" style={{ width: `${markets.length ? (upCount / markets.length) * 100 : 50}%` }} />
        </div>
        {(topGainer || topLoser) && (
          <p className="muted">Top del día: <b className="up">▲ {topGainer.symbol} {topGainer.change24h != null ? `+${topGainer.change24h.toFixed(2)}%` : ''}</b> · Peor del día: <b className="down">▼ {topLoser.symbol} {topLoser.change24h != null ? `${topLoser.change24h.toFixed(2)}%` : ''}</b></p>
        )}
      </section>


      <section className="card status">
        <h2>Estado del servidor</h2>
        <div className="stats">
          <div><span>Servidor</span><b className={serverStatus.startsWith('OK') ? 'up' : serverStatus.startsWith('FALLO') ? 'down' : ''}>{serverStatus}</b></div>
          <div><span>Última actualización</span><b>{updatedAt ? new Date(updatedAt).toLocaleTimeString('es-US') : '— (nunca llegó un precio)'}</b></div>
          <div><span>Fuente del precio</span><b>{source || '—'}</b></div>
          <div><span>Latencia del último fetch</span><b>{latencyMs != null ? `${latencyMs} ms` : '—'}</b></div>
        </div>
        {(error || marketsError || candlesError) && (
          <p className="errtext">Último error exacto — precio: {error || 'ninguno'} · pestañas: {marketsError || 'ninguno'} · velas: {candlesError || 'ninguno'}</p>
        )}
        <div className="row">
          <button onClick={testServer}>Probar servidor</button>
          <span className="muted">Comprueba que el servidor responde y de dónde viene el precio.</span>
        </div>
        {testResult && <p className="errtext">{testResult}</p>}
        {(debugInfo || testResult) && (
          <details className="tech-details">
            <summary>Detalles técnicos (para diagnosticar)</summary>
            {debugInfo ? <pre className="errtext">{debugInfo}</pre> : <p className="muted">Pulsa "Probar servidor" para ver el estado de cada fuente (Coinbase, Kraken, Binance US, CoinGecko).</p>}
          </details>
        )}
      </section>


      <footer>Fuente de datos: APIs públicas de Coinbase, Kraken, Binance US y CoinGecko, consultadas por el servidor. Precios en vivo, no inventados. El simulador, la liga, las misiones y las alertas usan dinero virtual y son solo una prueba educativa. {APP_URL}</footer>
    </div>
  );
}
