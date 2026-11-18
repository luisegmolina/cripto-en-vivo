import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, LineStyle } from 'lightweight-charts';
import { analyze, emaSeries, bollingerSeries, rsiSeries } from './analysis.js';
import { updateLastCandle, candlesSignature, mergeServerCandles } from './liveCandle.js';
import { fearGreedEstimate, heatToday, isoWeekKey, rivalsForWeek } from './marketPro.js';
import { backtestSignal } from './backtest.js';
import { evaluateWindowSignal, backtestWindowSignal } from './windowOutcome.js';
import { isCoinFlip } from './stats.js';
import { multiTfVerdict, reasonsFor, tradePlan, signalHistory, atr, VERDICT_TFS } from './verdict.js';
import { KALSHI_WINDOW_MS, window15m, fmtClock, fmtCountdown, kalshiVerdictForScore, strengthForScore, estimatedProb, adjustProbForRecent, recentWinRate, cashOutDecision, suggestedExitPrice, brtiPositionOutcome, estimateSettlementPnl, liveDecision } from './kalshi.js';
import { MISSIONS, levelForXp, xpIntoLevel, XP_PER_LEVEL } from './missions.js';
import { screenOpportunities } from './screener.js';
import { shouldFireAlert, shouldSignalAlert, ALERT_COOLDOWN_MS, dedupePriceAlerts } from './alerts.js';
import { shareText, whatsappUrl, drawShareCard, APP_URL } from './shareCard.js';
import { getToken, register, login, me, logout, apiAuth } from './auth.js';
import AdminPanel from './AdminPanel.jsx';
import KalshiConnect from './KalshiConnect.jsx';

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
const VERSION_LABEL = 'v15 — Referencia en vivo primero: BRTI, tu posición, decisión, señales, gráfica';

const ACHIEVEMENTS = [
  { id: 'primera_operacion', name: 'Primera operación virtual', desc: 'Compra o vende por primera vez con dinero virtual.' },
  { id: 'primera_alerta', name: 'Primera alerta de precio', desc: 'Crea tu primera alerta de precio.' },
  { id: 'racha_3', name: 'Racha de 3 días', desc: 'Abre la app 3 días seguidos.' },
  { id: 'en_verde', name: 'En verde +2%', desc: 'Tu cartera virtual supera los 10.200.' },
  { id: 'cazador_top', name: 'Cazador del top', desc: 'Compra el activo que más sube en 24 h.' },
  { id: 'explorador', name: 'Explorador', desc: 'Mira los gráficos de 5 activos distintos.' },
];

// v15.2: setInterval que no consulta al servidor con la pestaña oculta y se
// pone al día en cuanto vuelves a ella. Devuelve la función que lo detiene.
function visibleInterval(fn, ms) {
  const t = setInterval(() => { if (!document.hidden) fn(); }, ms);
  const onVisible = () => { if (!document.hidden) fn(); };
  document.addEventListener('visibilitychange', onVisible);
  return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
}

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
  // v10: al entrar, el intervalo es SIEMPRE 1h. No se persiste la
  // selección entre sesiones: si en la sesión anterior se quedó en
  // 1m (o quedó guardado un '1m' viejo), al cargar se vuelve a 1h.
  // El aviso "1m es ruido" solo sale si el usuario cambia a 1m a mano.
  const [candleInterval, setCandleInterval] = useState('15m');

  // v14: UNA SOLA PANTALLA. No hay pestañas: la app es solo Kalshi
  // (BRTI en vivo, precio objetivo, gráfica 15m y señales). activeTab
  // es siempre 'kalshi' y el intervalo de velas es siempre 15m.
  // Las demás secciones (Mercados, Gráfico y señal, Cartera, Liga)
  // ya no se muestran en la vista; el backend, la lógica y los datos
  // siguen intactos (solo se limpió la pantalla).
  const activeTab = 'kalshi';
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const [kalshiPos, setKalshiPos] = useState(() => loadLS('cev_kalshi_position_v1', { entryPrice: '', dir: 'up', amount: '100', entryScore: null }));
  const [kalshiEntryPrice, setKalshiEntryPrice] = useState(kalshiPos.entryPrice || '');
  const [kalshiDir, setKalshiDir] = useState(kalshiPos.dir || 'up');
  const [kalshiAmount, setKalshiAmount] = useState(kalshiPos.amount || '100');
  const [kalshiMsg, setKalshiMsg] = useState('');
  // v13.4: decisiones de las posiciones REALES abiertas, que sube
  // KalshiConnect (onRealDecision) para el banner debajo del
  // veredicto. Se actualiza solo si cambia (comparación por JSON en
  // el setter) para no re-renderizar en bucle con cada tick.
  const [realDecisions, setRealDecisions] = useState([]);
  const handleRealDecisions = (list) => {
    setRealDecisions((prev) => {
      const next = Array.isArray(list) ? list : [];
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
    });
  };
  // v13.2: mercado actual KXBTC15M de la API pública de Kalshi (precio
  // objetivo + precios SÍ/NO). Solo BTC: Kalshi no tiene mercados de
  // 15 min para las demás criptos. null = aún no cargado; source
  // 'coinbase' = Kalshi falló y se cae a Coinbase con aviso.
  const [kalshiMarket, setKalshiMarket] = useState(null);
  // v13.5: valor BRTI en vivo de Kalshi (el número que liquida).
  // null = aún no cargado; source 'coinbase' = sin Kalshi conectado
  // o WS de Kalshi sin dato: se cae a Coinbase con aviso, nunca en
  // blanco. El servidor lo actualiza por WebSocket con tu clave ya
  // conectada; aquí solo se sondea cada 3 s con la pestaña activa.
  const [brti, setBrti] = useState(null);
  useEffect(() => { saveLS('cev_kalshi_position_v1', { entryPrice: kalshiEntryPrice, dir: kalshiDir, amount: kalshiAmount, entryScore: kalshiPos.entryScore }); }, [kalshiEntryPrice, kalshiDir, kalshiAmount]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- v12: USUARIOS + KALSHI SOLO LECTURA (capa encima, no reemplaza nada) ---
  // Sin sesión, la app pública funciona igual que antes: precios, señales,
  // cartera virtual, alertas y liga siguen siendo locales y sin registro.
  const [token, setTokenState] = useState(() => getToken());
  const [user, setUser] = useState(null);
  const [view, setView] = useState(() => (typeof window !== 'undefined' && window.location.hash === '#admin' ? 'admin' : 'app'));
  const [showAuth, setShowAuth] = useState(null); // 'login' | 'register' | null
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authName, setAuthName] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const serverSyncDone = useRef(false);

  // Sincronización opcional cartera/alertas con el servidor: si el servidor
  // tiene datos (trades o posiciones en la cartera, o alertas), se usan;
  // si no tiene nada, se suben los locales. Los errores se ignoran en silencio.
  async function pullOrPushServerData() {
    try {
      const [pf, al] = await Promise.allSettled([
        apiAuth('/api/me/portfolio'),
        apiAuth('/api/me/alerts'),
      ]);
      if (pf.status === 'fulfilled' && pf.value && pf.value.portfolio) {
        const srv = pf.value.portfolio;
        const hasData = (srv.trades && srv.trades.length > 0) || (srv.holdings && Object.keys(srv.holdings).length > 0);
        if (hasData) setPortfolio(srv);
        else apiAuth('/api/me/portfolio', { method: 'PUT', body: { portfolio } }).catch(() => {});
      }
      if (al.status === 'fulfilled' && al.value && al.value.alerts) {
        const srvAlerts = al.value.alerts;
        if (Array.isArray(srvAlerts) && srvAlerts.length > 0) setPriceAlerts(dedupePriceAlerts(srvAlerts));
        else apiAuth('/api/me/alerts', { method: 'PUT', body: { alerts: priceAlerts } }).catch(() => {});
      }
    } catch { /* sincronización opcional: nunca rompe la app */ }
    serverSyncDone.current = true;
  }

  // Al cargar, si hay token guardado, valida la sesión. 401 = token
  // inválido o caducado: se borra y se sigue sin sesión.
  useEffect(() => {
    const t = getToken();
    if (!t) return;
    me().then((u) => { setUser(u); pullOrPushServerData(); }).catch((e) => {
      if (e.status === 401) setTokenState(null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onHash = () => setView(window.location.hash === '#admin' ? 'admin' : 'app');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const goAdmin = () => { window.location.hash = '#admin'; setView('admin'); };
  const goApp = () => { window.location.hash = ''; setView('app'); };

  async function handleAuthSubmit(e) {
    e.preventDefault();
    setAuthError('');
    if (showAuth === 'register') {
      if (!authName.trim()) { setAuthError('Pon tu nombre.'); return; }
      if (authPassword.length < 8) { setAuthError('La contraseña debe tener al menos 8 caracteres.'); return; }
    }
    if (!authEmail.trim() || !authPassword) { setAuthError('Pon tu email y tu contraseña.'); return; }
    setAuthBusy(true);
    try {
      const data = showAuth === 'register'
        ? await register({ email: authEmail.trim(), password: authPassword, name: authName.trim() })
        : await login({ email: authEmail.trim(), password: authPassword });
      setTokenState(getToken());
      setUser(data.user || null);
      setShowAuth(null);
      setAuthPassword('');
      setAuthName('');
      serverSyncDone.current = false;
      pullOrPushServerData();
    } catch (err) { setAuthError(err.message || 'No se pudo entrar.'); }
    finally { setAuthBusy(false); }
  }

  async function handleLogout() {
    await logout();
    setTokenState(null);
    setUser(null);
    serverSyncDone.current = false;
    goApp();
  }

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
  // v13: contador que sube cada vez que se (re)crea el gráfico; el
  // efecto de datos lo usa para repintar aunque las velas no cambien.
  const [chartReady, setChartReady] = useState(0);
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
  // v10: migración al cargar. Las alertas guardadas antes de v9 no
  // tenían cooldown ni anti-duplicados: en el navegador de Luis
  // quedaron 4 entradas de la misma alerta (BTC por encima de $73.53).
  // dedupePriceAlerts deja solo la más reciente por activo+precio+
  // dirección y, si alguna copia ya sonó, la que queda queda sonada.
  const [priceAlerts, setPriceAlerts] = useState(() => dedupePriceAlerts(loadLS('cev_price_alerts_v1', [])));
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
  // v13.1: estas dos refs faltaban en v13 — se usaban en el efecto de
  // alerta de cambio de veredicto (abajo) pero la refactorización a
  // pestañas borró su declaración, y el render rompía con
  // "ReferenceError: prevVerdictKey is not defined" en producción.
  const prevVerdictKey = useRef(null);
  const lastSignalAlertRef = useRef(null);

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

  // v12: sincronización opcional con el servidor cuando hay sesión: al
  // cambiar la cartera o las alertas, se suben con debounce de 1.5 s.
  // Si el servidor responde error, se ignora en silencio (lo local manda).
  useEffect(() => {
    if (!user || !serverSyncDone.current) return;
    const t = setTimeout(() => {
      apiAuth('/api/me/portfolio', { method: 'PUT', body: { portfolio } }).catch(() => {});
      apiAuth('/api/me/alerts', { method: 'PUT', body: { alerts: priceAlerts } }).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [portfolio, priceAlerts, user]);

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
  // El backtest y el historial se definen más abajo, tras mtfCandles:
  // v10: SIEMPRE usan las velas de 1h, no las del intervalo del
  // gráfico. Así, aunque el usuario cambie el gráfico a 1m para mirar
  // velas, el backtest/historial siguen en 1h (el intervalo para
  // decidir) y no vuelven a mostrar el 19% de 1m como ejemplo.
  const lastCandleKey = candles.length ? `${candles.length}:${candles[candles.length - 1].time}` : 'empty';

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
  // v10: backtest e historial SIEMPRE en 1h (velas de la confluencia,
  // que ya se traen cada 20 s; si aún no llegaron, se usan las del
  // gráfico solo cuando el intervalo seleccionado es 1h). Solo se
  // recalculan cuando llega una vela nueva de 1h, no con cada tick.
  const candles1h = (mtfCandles['1h'] && mtfCandles['1h'].length >= 32)
    ? mtfCandles['1h']
    : (candleInterval === '1h' ? candles : []);
  const last1hKey = candles1h.length ? `${candles1h.length}:${candles1h[candles1h.length - 1].time}` : 'empty';
  const backtest = useMemo(() => backtestSignal(candles1h), [last1hKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const histSignals = useMemo(() => signalHistory(candles1h, 10), [last1hKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- v11: cálculos del MODO KALSHI 15 MIN ---
  // (kalshiPrice se define aquí porque priceNow se declara más abajo;
  // usar priceNow aquí daría error de zona temporal muerta.)
  const kalshiPrice = ticker?.price ?? markets.find((m) => m.symbol === symbol)?.price ?? null;
  const kalshiWin = window15m(nowMs);
  const candles15m = (mtfCandles['15m'] && mtfCandles['15m'].length >= 32)
    ? mtfCandles['15m']
    : (candleInterval === '15m' ? candles : []);
  const last15mKey = candles15m.length ? `${candles15m.length}:${candles15m[candles15m.length - 1].time}` : 'empty';
  const analysis15m = useMemo(() => (mtfAnalysis['15m'] || (candles15m.length >= 30 ? analyze(candles15m) : null)), [mtfAnalysis, last15mKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const kalshiScore = analysis15m ? analysis15m.score : 0;
  const kalshiVerdict = kalshiVerdictForScore(kalshiScore);
  const kalshiReasons = useMemo(() => reasonsFor(analysis15m), [analysis15m]);
  const kalshiAgreement = useMemo(() => {
    if (!mtfVerdict || !mtfVerdict.rows) return 0;
    const clear = mtfVerdict.rows.filter((r) => r.key === 'buy' || r.key === 'sell');
    if (!clear.length) return 0;
    const want = kalshiVerdict.key === 'up' ? 'buy' : kalshiVerdict.key === 'down' ? 'sell' : null;
    if (!want) return 0;
    return clear.filter((r) => r.key === want).length / clear.length;
  }, [mtfVerdict, kalshiVerdict.key]);
  const kalshiProb = estimatedProb(kalshiScore, kalshiAgreement);
  const kalshiRefCandle = candles15m.length ? candles15m[candles15m.length - 1] : null;
  const kalshiCandleOpen = kalshiRefCandle ? kalshiRefCandle.open : null;
  // v13.2: el precio de referencia de la ventana es el PRECIO OBJETIVO
  // de Kalshi (el precio contra el que se liquida), no el de Coinbase.
  // Si Kalshi no lo devuelve, se cae a la apertura de la vela 15m de
  // Coinbase (y la UI lo avisa). La señal sigue calculándose con las
  // velas de Coinbase; la liquidación usa el índice BRTI (ver aviso).
  const kalshiTargetPrice = kalshiMarket && kalshiMarket.source === 'kalshi' ? kalshiMarket.targetPrice : null;
  const kalshiRefPrice = kalshiTargetPrice ?? kalshiCandleOpen;
  const kalshiRefSource = kalshiTargetPrice != null ? 'kalshi' : 'coinbase';
  // v15: ¿vas GANANDO o PERDIENDO según el BRTI de Kalshi? Se decide
  // contra el promedio de 60 s (el que liquida) para tu primera
  // posición real abierta CON decisión; sin posición, no hay
  // decisión que tomar y la UI lo dice ("sin posición abierta").
  // Funciones puras (kalshi.js): brtiPositionOutcome añade "cerca
  // de la línea" (≤30 $ del objetivo) y liveDecision da SAL AHORA /
  // AGUANTA / INVIERTE MÁS. Nunca se inventa un resultado.
  const brtiArgs = {
    targetPrice: kalshiTargetPrice,
    avg60s: brti && brti.source === 'kalshi' ? brti.avg60s : null,
    value: brti && brti.source === 'kalshi' ? brti.value : null,
  };
  // v15 + CORRECCIÓN: referencia BRTI-objetivo SOLO con el promedio
  // de 60 s (el que liquida). Si no hay promedio, null: el tick
  // instantáneo NO se usa para la diferencia ni para ganar/perder.
  const brtiRefPrice = brti && brti.source === 'kalshi' && brti.avg60s != null ? brti.avg60s : null;
  const brtiDiff = brtiRefPrice != null && kalshiTargetPrice ? brtiRefPrice - kalshiTargetPrice : null;
  const brtiDiffPct = brtiDiff != null && kalshiTargetPrice ? (brtiDiff / kalshiTargetPrice) * 100 : null;
  const firstRealDecision = realDecisions.find((d) => d.decision) || null;
  const firstOutcome = firstRealDecision ? brtiPositionOutcome({ dir: firstRealDecision.dir, ...brtiArgs }) : null;
  const liveDecisionNow = firstRealDecision ? liveDecision({ winning: firstOutcome ? firstOutcome.winning : null, signalKey: kalshiVerdict.key, signalScore: kalshiScore, dir: firstRealDecision.dir, contractCents: firstRealDecision.currentPriceCents }) : null;
  const kalshiWinChangePct = (kalshiRefPrice && kalshiPrice) ? ((kalshiPrice - kalshiRefPrice) / kalshiRefPrice) * 100 : null;
  const kalshiAtr = useMemo(() => atr(candles15m), [last15mKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // v13.4: la medida 15m es la de KALSHI (windowOutcome.js): cierre
  // de la MISMA ventana vs su apertura (lo que liquida Kalshi), NO
  // la vela siguiente. backtestSignal/signalHistory siguen para la
  // señal general 1h, que sí se mide contra la vela siguiente.
  const kalshiBacktest = useMemo(() => backtestWindowSignal(candles15m), [last15mKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const kalshiHist = useMemo(() => evaluateWindowSignal(candles15m, 5), [last15mKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // v13: si en las últimas ventanas la señal 15m acierta menos del
  // 50%, no se esconde: se avisa en la pestaña Kalshi y la confianza
  // estimada se baja (tope 60%). v13.4: además el veredicto muestra
  // "SEÑAL DÉBIL" junto a SUBE/BAJA/ESPERAR, no solo baja la confianza.
  const kalshiRecent = recentWinRate(kalshiHist);
  const kalshiWeakSignal = Boolean(kalshiRecent && kalshiRecent.rate < 0.5);
  const kalshiProbAdj = adjustProbForRecent(kalshiProb, kalshiHist);
  const kalshiEntryNum = Number(kalshiEntryPrice);
  const kalshiAmountNum = Number(kalshiAmount);
  const kalshiDecision = useMemo(() => cashOutDecision({
    dir: kalshiDir, entryPrice: kalshiEntryNum, currentPrice: kalshiPrice, amount: kalshiAmountNum,
    signalKey: kalshiVerdict.key, signalScore: kalshiScore, entryScore: kalshiPos.entryScore,
  }), [kalshiDir, kalshiEntryNum, kalshiPrice, kalshiAmountNum, kalshiVerdict.key, kalshiScore, kalshiPos.entryScore]);
  const kalshiExitPrice = suggestedExitPrice({
    decisionKey: kalshiDecision.key, currentPrice: kalshiPrice, entryPrice: kalshiEntryNum, dir: kalshiDir, atr15m: kalshiAtr,
  });
  const setKalshiPosition = () => {
    if (!kalshiEntryNum || kalshiEntryNum <= 0 || !kalshiAmountNum || kalshiAmountNum <= 0) {
      setKalshiMsg('Pon un precio de entrada y una cantidad virtual mayores que 0.');
      return;
    }
    // Guardar la puntuación de la señal al entrar: así la app sabe si
    // la señal se debilitó o se dio la vuelta desde que entraste.
    setKalshiPos({ entryPrice: kalshiEntryPrice, dir: kalshiDir, amount: kalshiAmount, entryScore: kalshiScore });
    saveLS('cev_kalshi_position_v1', { entryPrice: kalshiEntryPrice, dir: kalshiDir, amount: kalshiAmount, entryScore: kalshiScore });
    setKalshiMsg(`Posición virtual guardada: apostaste a que ${kalshiDir === 'up' ? 'SUBE' : 'BAJA'} desde ${fmt(kalshiEntryNum, currency)} con ${fmt(kalshiAmountNum, currency)} virtuales. La app te dirá si cobrar o salir.`);
  };
  const clearKalshiPosition = () => {
    setKalshiPos({ entryPrice: '', dir: 'up', amount: '100', entryScore: null });
    setKalshiEntryPrice(''); setKalshiDir('up'); setKalshiAmount('100');
    saveLS('cev_kalshi_position_v1', { entryPrice: '', dir: 'up', amount: '100', entryScore: null });
    setKalshiMsg('Posición virtual borrada.');
  };
  function priceNowForPlan() {
    return ticker?.price ?? markets.find((m) => m.symbol === symbol)?.price ?? null;
  }
  // v13.2: mercado actual de Kalshi (precio objetivo + SÍ/NO), cada
  // 15 s (el servidor cachea 15 s: el sondeo coincide con la caché).
  // Es el precio contra el que se liquida la ventana. Si Kalshi
  // falla, el servidor responde source 'coinbase' y la pantalla usa el
  // precio de Coinbase con aviso, nunca en blanco.
  useEffect(() => {
    if (symbol !== 'BTC') { setKalshiMarket(null); return; }
    let alive = true;
    const load = async () => {
      try {
        const m = await api('/api/kalshi-market');
        if (alive) setKalshiMarket(m || null);
      } catch { if (alive) setKalshiMarket({ source: 'coinbase', targetPrice: null }); }
    };
    load();
    const stop = visibleInterval(load, 15000);
    return () => { alive = false; stop(); };
  }, [symbol]);

  // v13.5: valor BRTI en vivo de Kalshi, cada 2 s con la pantalla
  // activa y sesión iniciada (v15: de 3 s a 2 s, lo más rápido que
  // pide Luis para la referencia y la posición en vivo). El endpoint
  // solo lee el último tick que el servidor guarda del WebSocket; si
  // no hay Kalshi conectado, responde connected:false y NO se abre
  // ninguna conexión a Kalshi. Si el token caducó, apiAuth lanza y
  // se cae a Coinbase con aviso (la sesión se limpia en el efecto
  // de /me).
  useEffect(() => {
    if (activeTab !== 'kalshi' || symbol !== 'BTC' || !user) { setBrti(null); return; }
    let alive = true;
    const load = async () => {
      try {
        const b = await apiAuth('/api/kalshi/brti');
        if (alive) setBrti(b || null);
      } catch { if (alive) setBrti((prev) => (prev && prev.source === 'kalshi' && prev.value != null) ? { ...prev, status: 'error', stale: true, error: 'No se pudo leer el BRTI del servidor: se mantiene el último valor conocido.' } : { source: 'coinbase', value: null, status: 'error', error: 'No se pudo leer el BRTI del servidor.' }); }
    };
    load();
    const stop = visibleInterval(load, 2000);
    return () => { alive = false; stop(); };
  }, [activeTab, symbol, user?.id]);

  // v9: capitalización total y dominio de BTC REALES, de /api/global
  // (CoinGecko). Se refrescan cada 5 min. Si CoinGecko falla o da 429,
  // globalData queda en null y la UI muestra "No disponible", nunca un
  // número inventado (el proxy precio × volumen se eliminó).
  const [globalData, setGlobalData] = useState(null);
  // v10: si no hay ninguna fuente, cuántos segundos faltan para el
  // próximo reintento (lo devuelve /api/global como retryInSeconds).
  const [globalRetrySec, setGlobalRetrySec] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const g = await api('/api/global');
        if (!alive) return;
        if (g && g.available) { setGlobalData(g); setGlobalRetrySec(null); }
        else { setGlobalData(null); setGlobalRetrySec(g && g.retryInSeconds != null ? g.retryInSeconds : 60); }
      } catch { if (alive) { setGlobalData(null); setGlobalRetrySec(60); } }
    };
    load();
    const stop = visibleInterval(load, 300000);
    return () => { alive = false; stop(); };
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
    const stops = [visibleInterval(loadTicker, 1000), visibleInterval(loadMarkets, 10000), visibleInterval(loadCandles, 6000)];
    return () => { alive = false; stops.forEach((stop) => stop()); };
  }, [symbol, currency, candleInterval]);

  // Al cambiar de activo/moneda/intervalo, la vela en curso es otra.
  useEffect(() => {
    candlesRef.current = [];
    lastCandlesSig.current = '';
    lastChartSig.current = '';
    lastChartTime.current = null;
    prevPrice.current = null;
    setCandles([]);
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
    const stop = visibleInterval(load, 20000);
    return () => { alive = false; stop(); };
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
    const stop = visibleInterval(load, 10000);
    return () => { alive = false; stop(); };
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

  // --- v8/v13: ALERTA cuando el VEREDICTO cambia ---
  // v13: el veredicto se recalcula con cada tick de la vela en curso
  // y con cada refresco de las 4 temporalidades, así que puede cruzar
  // el umbral varias veces en el mismo segundo (en el video del 12-nov
  // salieron ESPERAR y VENDER a la vez, a las 19:48:54). Regla: una
  // sola alerta de cambio de veredicto por minuto; si cambia dos veces
  // en menos de 60 s, solo queda la última (se reemplaza, no se añade
  // otra, y no vuelve a sonar).
  const verdictKeyNow = mtfVerdict.verdict.key;
  useEffect(() => {
    const prev = prevVerdictKey.current;
    prevVerdictKey.current = verdictKeyNow;
    if (!prev) return; // primera carga: no es un cambio, no alertar
    if (prev === verdictKeyNow) return;
    const flips = (prev === 'buy' && verdictKeyNow === 'sell') || (prev === 'sell' && verdictKeyNow === 'buy');
    const msg = flips
      ? `🚨 CAMBIO DE SEÑAL ${symbol}: ${prev === 'buy' ? 'COMPRAR' : 'VENDER'} → ${verdictKeyNow === 'buy' ? 'COMPRAR' : 'VENDER'} (puntuación ${mtfVerdict.score}, índice de coincidencia ${mtfVerdict.confidence}/95) — ${new Date().toLocaleTimeString('es-US')}`
      : `🔔 Señal ${symbol}: ahora ${mtfVerdict.verdict.label} (puntuación ${mtfVerdict.score}) — ${new Date().toLocaleTimeString('es-US')}`;
    const nowMs = Date.now();
    const chk = shouldSignalAlert(lastSignalAlertRef.current, nowMs);
    lastSignalAlertRef.current = { at: nowMs, key: verdictKeyNow };
    if (!chk.fire && chk.replace) {
      // Dentro del mismo minuto: reemplazar la alerta anterior por
      // esta última, sin añadir otra ni volver a notificar.
      setAlerts((a) => {
        const idx = a.findIndex((x) => x.includes('Señal') || x.includes('CAMBIO DE SEÑAL'));
        if (idx < 0) return [msg, ...a].slice(0, 20);
        const copy = [...a];
        copy[idx] = msg;
        return copy;
      });
      return;
    }
    setAlerts((a) => [msg, ...a].slice(0, 20));
    notify('Cripto en Vivo — cambio de señal', msg);
    try {
      const hist = JSON.parse(localStorage.getItem('cev_signal_changes_v1') || '[]');
      hist.unshift({ time: new Date().toISOString(), symbol, from: prev, to: verdictKeyNow, score: mtfVerdict.score });
      localStorage.setItem('cev_signal_changes_v1', JSON.stringify(hist.slice(0, 30)));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verdictKeyNow, symbol]);

  // --- Gráfico de velas: creación al montar la pantalla ---
  // v13: antes se creaba UNA sola vez al montar la app; si el
  // contenedor aún no tenía tamaño o las velas no habían llegado, el
  // gráfico quedaba en blanco y nada lo recreaba (eso se ve en el
  // video del 12-nov). Después se creaba al entrar en la pestaña
  // Gráfico y se destruía al salir. v14: no hay pestañas, la gráfica
  // es parte de la única pantalla, así que se crea al montar y se
  // destruye al desmontar; chartReady obliga al efecto de datos a
  // repintar con las velas que ya hay.
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
    const onResize = () => { try { chart.applyOptions({ width: el.clientWidth }); } catch {} };
    window.addEventListener('resize', onResize);
    let ro = null;
    try {
      ro = new ResizeObserver(() => { try { chart.applyOptions({ width: el.clientWidth }); } catch {} });
      ro.observe(el);
    } catch {}
    // El gráfico ya existe: avisar al efecto de datos para que pinte
    // las velas que ya llegaron (si no, se quedaría en blanco hasta
    // que llegara una vela nueva).
    lastChartSig.current = '';
    setChartReady((n) => n + 1);
    return () => {
      window.removeEventListener('resize', onResize);
      try { ro && ro.disconnect(); } catch {}
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
    if (!candles.length) {
      // Sin velas no se pinta nada: vaciar las series para no dejar
      // velas viejas de otro intervalo y que la UI diga "Cargando…".
      try { candleSeries.current.setData([]); volumeSeries.current.setData([]); } catch {}
      return;
    }
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
  }, [candles, analysis, showEma, showBoll, showRsi, compareBtc, btcCandles, chartReady]);

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

  // --- Screener: se calcula SOLO al cargar la página (10 llamadas a /api/candles, 1h) ---
  // v10: antes solo se calculaba al pulsar "Actualizar screener" y al
  // entrar salía "Todavía no hay screener". Ahora se auto-ejecuta la
  // primera vez que llegan las 10 pestañas de mercados; el botón queda
  // solo para refrescar a mano.
  const screenAutoRanRef = useRef(false);
  const runScreener = async (marketsList) => {
    const list = marketsList || markets;
    setScreenLoading(true);
    setScreenError('');
    try {
      const settled = await Promise.allSettled(ASSETS.map((a) => api(`/api/candles?symbol=${a.symbol}&currency=${currency}&interval=1h`)));
      const analyses = {};
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value.candles && r.value.candles.length) analyses[ASSETS[i].symbol] = analyze(r.value.candles);
      });
      setScreenRows(screenOpportunities(list, analyses));
      setScreenUpdatedAt(new Date().toLocaleTimeString('es-US'));
    } catch (e) { setScreenError(String(e.message || e)); }
    finally { setScreenLoading(false); }
  };
  useEffect(() => {
    if (screenAutoRanRef.current || markets.length < 10 || screenLoading) return;
    screenAutoRanRef.current = true;
    runScreener(markets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markets]);

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

  // v12: vista admin (#admin): muestra el panel de administración en vez
  // de la app pública. Solo entra si el usuario es admin.
  if (view === 'admin') {
    return (
      <div className="app">
        <header>
          <div><h1>₿ Cripto en Vivo</h1><p>Precios reales desde el servidor · React + Node · {VERSION_LABEL}</p></div>
          <div className="row">
            {user ? (
              <>
                <span className="badge">👤 {user.name || user.email}</span>
                <button onClick={handleLogout}>Salir</button>
              </>
            ) : (
              <button onClick={() => { goApp(); setShowAuth('login'); }}>Entrar</button>
            )}
          </div>
        </header>
        {!user ? (
          <section className="card">
            <h2>🛡️ Administración</h2>
            <p className="muted">Entra con tu cuenta de administrador para ver esta vista.</p>
            <div className="row"><button onClick={goApp}>← Volver a la app</button></div>
          </section>
        ) : user.role === 'admin' ? (
          <AdminPanel token={token} onBack={goApp} />
        ) : (
          <section className="card">
            <h2>🛡️ Administración</h2>
            <p className="error">No tienes permiso de administrador.</p>
            <div className="row"><button onClick={goApp}>← Volver a la app</button></div>
          </section>
        )}
        <footer>Fuente de datos: APIs públicas de Coinbase, Kraken, Binance US y CoinGecko, consultadas por el servidor. {APP_URL}</footer>
      </div>
    );
  }

  return (
    <div className="app">
      {/* v14: encabezado mínimo — nombre, versión y sesión. Sin
          fuente/latencia ni botones de más. */}
      <header>
        <div><h1>₿ Cripto en Vivo</h1><p>{VERSION_LABEL}</p></div>
        <div className="row">
          {!user ? (
            <>
              <button onClick={() => { setShowAuth('login'); setAuthError(''); }}>Entrar</button>
              <button onClick={() => { setShowAuth('register'); setAuthError(''); }}>Crear cuenta</button>
            </>
          ) : (
            <>
              <span className="badge">👤 {user.name || user.email}</span>
              {user.role === 'admin' && <button onClick={goAdmin}>🛡️ Admin</button>}
              <button onClick={handleLogout}>Salir</button>
            </>
          )}
        </div>
      </header>


      {/* v12: modal de entrar / crear cuenta (sin registro obligatorio para ver precios y señales) */}
      {showAuth && (
        <section className="card">
          <h2>{showAuth === 'register' ? 'Crear cuenta' : 'Entrar'}</h2>
          <p className="muted">La cuenta te deja conectar tu Kalshi en solo lectura para ver el valor BRTI en vivo y tus posiciones. Ver la pantalla no necesita cuenta.</p>
          <form onSubmit={handleAuthSubmit}>
            <div className="row">
              {showAuth === 'register' && (
                <label>Nombre: <input type="text" value={authName} autoComplete="name" onChange={(e) => setAuthName(e.target.value)} placeholder="Tu nombre" /></label>
              )}
              <label>Email: <input type="email" value={authEmail} autoComplete="email" onChange={(e) => setAuthEmail(e.target.value)} placeholder="tu@email.com" /></label>
              <label>Contraseña: <input type="password" value={authPassword} autoComplete={showAuth === 'register' ? 'new-password' : 'current-password'} onChange={(e) => setAuthPassword(e.target.value)} placeholder="Mínimo 8 caracteres" /></label>
              <button type="submit" disabled={authBusy}>{authBusy ? '…' : showAuth === 'register' ? 'Crear mi cuenta' : 'Entrar'}</button>
              <button type="button" onClick={() => setShowAuth(null)}>Cancelar</button>
            </div>
          </form>
          {authError && <p className="error">{authError}</p>}
          <p className="muted">
            {showAuth === 'login' ? (
              <>¿No tienes cuenta? <button onClick={() => { setShowAuth('register'); setAuthError(''); }}>Crear cuenta</button></>
            ) : (
              <>¿Ya tienes cuenta? <button onClick={() => { setShowAuth('login'); setAuthError(''); }}>Entrar</button></>
            )}
          </p>
          <p className="muted">¿Olvidaste tu contraseña? Pídele al admin que la resetee.</p>
        </section>
      )}

      <p className="warn">⚠️ Prueba educativa, dinero virtual, solo lectura: la app nunca opera por ti. Kalshi liquida con el índice BRTI (promedio de 60 s), no con Coinbase.</p>

      {error && <div className="error">No se pudo cargar desde el servidor: {error}. Revisa que el servidor esté corriendo (npm run dev en la carpeta raíz).</div>}

        <section className={`card verdict-card kalshi-card verdict-${kalshiVerdict.key === 'up' ? 'buy' : kalshiVerdict.key === 'down' ? 'sell' : 'wait'}`} aria-label="Modo Kalshi 15 minutos">
          <p className="verdict-kicker">MODO KALSHI 15 MIN · {symbol} · VENTANA DE 15 MINUTOS · EDUCATIVO, NO ES RECOMENDACIÓN DE APUESTA</p>
          <h2>1 · Referencia en tiempo real — BTC · ventana 15 min</h2>
          <div className="stats">
            <div><span>Ventana actual</span><b>{fmtClock(kalshiWin.startMs)} – {fmtClock(kalshiWin.endMs)}</b></div>
            <div><span>Cierra en</span><b className="countdown">{fmtCountdown(kalshiWin.remainingMs)}</b></div>
            <div><span>Precio objetivo (Kalshi)</span><b>{kalshiTargetPrice ? fmt(kalshiTargetPrice, currency) : '—'}</b></div>
            <div><span>Precio SÍ / NO (Kalshi)</span><b>{kalshiMarket && kalshiMarket.source === 'kalshi' && kalshiMarket.yesAskCents != null ? `SÍ ${kalshiMarket.yesAskCents}¢ · NO ${kalshiMarket.noAskCents ?? '—'}¢` : '—'}</b></div>
          </div>
          <div className="score-bar" aria-hidden="true"><div style={{ width: `${kalshiWin.elapsedPct}%`, background: '#f59e0b' }} /></div>
          <p className="muted">Ventana {Math.round(kalshiWin.elapsedPct)}% transcurrida. Al cerrar, la predicción se resuelve: ¿el precio terminó por encima o por debajo del precio objetivo de Kalshi?</p>
          <p className="muted">Precio objetivo de Kalshi: es el precio contra el que se liquida esta ventana (mercado {kalshiMarket && kalshiMarket.ticker ? kalshiMarket.ticker : 'KXBTC15M'}). El precio SÍ/NO es lo que cuesta el contrato en Kalshi en centavos, no la probabilidad de acierto de la señal de esta app.</p>
          <p className="muted">Cómo liquida Kalshi: el objetivo es el promedio de 60 s antes de la apertura; el cierre se compara contra ese objetivo con el promedio de 60 s antes del cierre. El valor instantáneo que parpadea no liquida.</p>
          {kalshiRefSource !== 'kalshi' && (
            <p className="warn">⚠️ Precio de referencia de Coinbase, no de Kalshi: la API pública de Kalshi no devolvió el mercado actual, así que la referencia es la apertura de la vela 15m de Coinbase.</p>
          )}
          {kalshiCandleOpen && kalshiTargetPrice && (
            <p className="muted">Apertura de la ventana según Coinbase: {fmt(kalshiCandleOpen, currency)} (solo orientativo; la liquidación usa el objetivo de Kalshi).</p>
          )}

          {/* v13.5: VALOR EN VIVO DE KALSHI (BRTI) — el número que
              liquida la ventana, no Coinbase. El promedio de 60 s es
              el que decide: si al cerrar está por encima del objetivo
              gana SÍ, si no gana NO. GANANDO/PERDIENDO se calcula
              contra ese promedio para tu primera posición real
              abierta; sin posición real, solo se dice si el BRTI está
              por encima o por debajo del objetivo. Sin Kalshi
              conectado o sin dato del WS, se muestra Coinbase con
              aviso, nunca en blanco y nunca un número inventado. */}
          {brti == null ? (
            <p className="muted">Cargando valor en vivo de Kalshi (BRTI)…</p>
          ) : brti.source === 'kalshi' && brti.value != null ? (
            <div className="signal" style={{ borderColor: brtiDiff != null && brtiDiff >= 0 ? '#22c55e' : brtiDiff != null ? '#ef4444' : '#94a3b8' }}>
              <b style={{ fontSize: 26 }}>BRTI ahora: {fmt(brti.value, currency)}</b>
              <span>Promedio de 60 s (el que liquida): <b>{brti.avg60s != null ? fmt(brti.avg60s, currency) : '— (aún no disponible: sin promedio no se puede saber si vas ganando; el valor instantáneo no liquida)'}</b>{brti.avg15mFinal != null && (<> · Promedio final de la ventana: <b>{fmt(brti.avg15mFinal, currency)}</b></>)}</span>
              {kalshiTargetPrice && brtiDiff != null && (
                <span>Diferencia contra el objetivo {fmt(kalshiTargetPrice, currency)}: <b className={brtiDiff >= 0 ? 'up' : 'down'}>{brtiDiff >= 0 ? '+' : '−'}{fmt(Math.abs(brtiDiff), currency)} ({brtiDiffPct >= 0 ? '+' : ''}{brtiDiffPct.toFixed(3)}%)</b> · referencia: promedio de 60 s</span>
              )}
              {kalshiTargetPrice && brtiDiff == null && (
                <span className="muted">Promedio de 60 s no disponible: sin él no se puede saber si vas ganando ni la diferencia contra el objetivo. El valor instantáneo de arriba no liquida.</span>
              )}
              <span className="muted">Fuente: índice BRTI en vivo por WebSocket de Kalshi (canal cfbenchmarks_value), con tu clave ya conectada. Actualizado: {brti.updatedAt ? new Date(brti.updatedAt).toLocaleTimeString('es-US', { hour12: false }) : '—'}{brti.stale ? ' · ⚠️ Dato con más de 15 s: puede estar desactualizado.' : ''}</span>
            </div>
          ) : (
            <div className="signal" style={{ borderColor: '#f59e0b' }}>
              <b style={{ fontSize: 22 }}>⚠️ Sin valor en vivo de Kalshi</b>
              <span>{user ? (brti.status === 'error' ? `El WebSocket de Kalshi no está dando el valor (${brti.error || 'sin dato'})` : 'Aún no llega el primer tick de Kalshi') : 'Entra con tu cuenta y conecta Kalshi para ver el valor en vivo que liquida'} — se muestra el precio de Coinbase mientras tanto.</span>
              <span>Precio de Coinbase ahora: <b>{kalshiPrice ? fmt(kalshiPrice, currency) : '—'}</b> · puede diferir del de liquidación (BRTI).</span>
              <span className="muted">Actualizado: {brti.updatedAt ? new Date(brti.updatedAt).toLocaleTimeString('es-US', { hour12: false }) : '—'}</span>
            </div>
          )}


          {/* v15: §2 MI POSICIÓN EN VIVO — justo debajo de la
              referencia. El P&L se recalcula con cada tick BRTI
              (cada 2 s); las posiciones se refrescan cada 30 s
              (KalshiConnect). P&L estimado = liquidación si la
              ventana cerrara ahora según BRTI ($1 si vas ganando,
              $0 si vas perdiendo, menos el precio medio, por
              contrato). El P&L "si vendes ahora" es el del precio
              del contrato, lo que Kalshi te pagaría hoy. */}
          <h2>2 · Mi posición en vivo</h2>
          {!user ? (
            <p className="muted">Entra con tu cuenta y conecta Kalshi para ver tu posición en vivo aquí.</p>
          ) : realDecisions.length === 0 ? (
            <p className="muted">Sin posición abierta en Kalshi ahora mismo: no hay nada que vigilar. Cuando abras una, aparecerá aquí con su P&L en vivo.</p>
          ) : (
            <div>
              {realDecisions.map((d, i) => {
                const out = brtiPositionOutcome({ dir: d.dir, ...brtiArgs });
                const pnlEst = estimateSettlementPnl({ dir: d.dir, ...brtiArgs, avgPriceCents: d.avgPriceCents, count: d.count });
                const canLose = out && (!out.winning || out.nearLine);
                return (
                  <div key={`${d.ticker || ''}-${i}`} className="signal" style={{ borderColor: out ? (out.winning ? '#22c55e' : '#ef4444') : '#94a3b8' }}>
                    <b>{d.ticker || '—'} — {d.side === 'yes' ? 'SÍ' : d.side === 'no' ? 'NO' : '—'} · Apuesta: {d.dir === 'up' ? '▲ SUBE' : d.dir === 'down' ? '▼ BAJA' : '—'}</b>
                    <span>Precio medio: {d.avgPriceCents != null ? `${d.avgPriceCents}¢` : '—'} · Cantidad: {d.count} contrato(s) · Precio actual del contrato: {d.currentPriceCents != null ? `${d.currentPriceCents}¢` : '—'}</span>
                    {pnlEst ? (
                      <span>P&L estimado si la ventana cerrara ahora según BRTI: <b className={pnlEst.pnlUsd >= 0 ? 'up' : 'down'}>{pnlEst.pnlUsd >= 0 ? '+' : ''}{fmt(pnlEst.pnlUsd, 'USD')}</b> · el contrato valdría ${pnlEst.estValueCents / 100} si liquida así</span>
                    ) : (
                      <span className="muted">Sin P&L estimado: falta el promedio de 60 s, el objetivo o el precio medio. El valor instantáneo no liquida.</span>
                    )}
                    {d.decision && d.decision.pnl != null && (
                      <span>Si vendes ahora en Kalshi (precio del contrato): <b className={d.decision.pnl >= 0 ? 'up' : 'down'}>{d.decision.pnl >= 0 ? '+' : ''}{fmt(d.decision.pnl, 'USD')}</b></span>
                    )}
                    {out ? (
                      <span><b style={{ color: out.winning ? '#22c55e' : '#ef4444' }}>{out.winning ? '✓ VAS GANANDO según BRTI' : '✗ VAS PERDIENDO según BRTI'}</b>{canLose && (<span> · <b>⚠️ PUEDES PERDER</b>: {out.winning ? 'estás a menos de $30 del objetivo y la ventana puede darse la vuelta' : 'el BRTI está en tu contra'}</span>)}</span>
                    ) : (
                      <span className="muted">Sin promedio de 60 s: no se puede saber si vas ganando o perdiendo. El valor instantáneo no liquida y no se usa para decidir.</span>
                    )}
                    {!d.decision && (
                      <span className="muted">Sin decisión por precio del contrato: falta el precio medio o el actual — comprueba la posición en Kalshi.</span>
                    )}
                  </div>
                );
              })}
              <p className="muted">Posiciones actualizadas cada 30 s; el P&L se recalcula con cada tick BRTI (cada 2 s).</p>
            </div>
          )}

          {/* v15: §3 DECISIÓN — SAL AHORA / AGUANTA / INVIERTE MÁS.
              Sugerencia educativa, nunca una orden: la app no opera
              por ti. Reglas en kalshi.js (liveDecision): contrato
              ≤15¢ o BRTI + señal en contra -> SAL; ganando + señal
              fuerte a favor + contrato ≤40¢ -> INVIERTE MÁS (con
              aviso de más riesgo); ganando + señal a favor -> AGUANTA;
              resto -> AGUANTA CON CUIDADO. */}
          <h2>3 · Decisión</h2>
          {!user ? (
            <p className="muted">Entra y conecta Kalshi para que la app te diga si salir, aguantar o invertir más según tu posición.</p>
          ) : !firstRealDecision ? (
            <p className="muted">Sin posición abierta en Kalshi ahora mismo: no hay decisión que tomar. Cuando abras una, aparecerá aquí.</p>
          ) : liveDecisionNow ? (
            <div className="signal" style={{ borderColor: liveDecisionNow.color }}>
              <b style={{ color: liveDecisionNow.color, fontSize: 26 }}>{liveDecisionNow.label}</b>
              <span>{liveDecisionNow.reason}</span>
              <span>Tu posición: <b>{firstRealDecision.ticker} — {firstRealDecision.side === 'yes' ? 'SÍ' : firstRealDecision.side === 'no' ? 'NO' : '—'} ({firstRealDecision.count} contrato(s), {firstRealDecision.currentPriceCents}¢ ahora)</b></span>
              {liveDecisionNow.key === 'add' && (
                <span className="warn">⚠️ Invertir más aumenta el riesgo: si la ventana se da la vuelta, pierdes más de lo que llevas. Solo con dinero que te sobre.</span>
              )}
              <span className="muted">Sugerencia educativa, nunca una orden: la app no opera por ti. Decide y opera tú en Kalshi.</span>
            </div>
          ) : null}

          <h2>4 · Señales del mercado</h2>
          <div className="verdict-main">
            <div className="verdict-word">{kalshiVerdict.icon} {kalshiVerdict.label}{kalshiWeakSignal && (<span> · ⚠️ SEÑAL DÉBIL</span>)}</div>
            <div className="verdict-meta">
              <span>Puntuación 15m: <b>{kalshiScore}</b> / −100 a +100</span>
              <span>Fuerza: <b>{strengthForScore(kalshiScore)}</b></span>
              <span>Índice de coincidencia: <b>{kalshiProbAdj}/100*</b></span>
            </div>
          </div>
          <p className="muted">* Índice propio (puntuación + timeframes que coinciden). NO es una probabilidad de ganar y NO es la probabilidad oficial de Kalshi. Una señal que acertó ~56% en 1h puede fallar en 15 minutos.</p>
          {kalshiBacktest.total >= 5 && kalshiBacktest.ci95 && (
            <p className="muted">Medido como liquida Kalshi (señal calculada ANTES de abrir cada ventana): acertó {kalshiBacktest.wins} de {kalshiBacktest.total} ({kalshiBacktest.pct}%; margen al 95%: {kalshiBacktest.ci95.low}–{kalshiBacktest.ci95.high}%).{isCoinFlip(kalshiBacktest.ci95) ? ' Con estas muestras no se distingue de lanzar una moneda.' : ''}</p>
          )}
          {kalshiWeakSignal && (
            <p className="warn">⚠️ SEÑAL DÉBIL — Últimas {kalshiRecent.total} ventanas con señal clara de 15 min: la señal solo acertó {kalshiRecent.wins} ({Math.round(kalshiRecent.rate * 100)}%). Está fallando últimamente: el índice se bajó a {kalshiProbAdj} y no conviene apostar fuerte por ella. Medido como liquida Kalshi: cierre de cada ventana contra su apertura, no contra la vela siguiente.</p>
          )}
          {kalshiReasons.length > 0 && (
            <ul className="reasons">
              {kalshiReasons.map((r, i) => (
                <li key={i} className={`reason-${r.dir}`}><b>{r.icon}</b> {r.text}</li>
              ))}
            </ul>
          )}

          <h3>¿Cobro o me quedo?</h3>
          <div className="row">
            <label>Precio de entrada ({CUR[currency]}): <input type="number" min="0" step="1" value={kalshiEntryPrice} placeholder={kalshiPrice ? String(Math.round(kalshiPrice)) : ''} onChange={(e) => setKalshiEntryPrice(e.target.value)} /></label>
            <label>Dirección: <select value={kalshiDir} onChange={(e) => setKalshiDir(e.target.value)}>
              <option value="up">Aposté a que SUBE</option>
              <option value="down">Aposté a que BAJA</option>
            </select></label>
            <label>Cantidad virtual ({CUR[currency]}): <input type="number" min="1" step="10" value={kalshiAmount} onChange={(e) => setKalshiAmount(e.target.value)} /></label>
            <button onClick={setKalshiPosition}>Guardar mi posición virtual</button>
            <button onClick={clearKalshiPosition}>Borrar posición</button>
          </div>
          {kalshiMsg && <p className="muted">{kalshiMsg}</p>}
          <div className="signal" style={{ borderColor: kalshiDecision.color }}>
            <b style={{ color: kalshiDecision.color, fontSize: 26 }}>{kalshiDecision.label}</b>
            <span><b>{kalshiDecision.title}</b></span>
            <span>{kalshiDecision.text}</span>
            {kalshiDecision.pnl != null && (
              <span>Tu posición virtual: <b className={kalshiDecision.pnl >= 0 ? 'up' : 'down'}>{kalshiDecision.pnl >= 0 ? '+' : ''}{fmt(kalshiDecision.pnl, currency)} ({kalshiDecision.pnlPct >= 0 ? '+' : ''}{kalshiDecision.pnlPct.toFixed(2)}%)</b> · precio ahora {kalshiPrice ? fmt(kalshiPrice, currency) : '—'} · entrada {fmt(kalshiEntryNum, currency)}</span>
            )}
            {kalshiExitPrice && (
              <span>Precio sugerido para cobrar/salir: <b>{fmt(kalshiExitPrice, currency)}</b> {kalshiDecision.key === 'hold' || kalshiDecision.key === 'hold-careful' ? `(objetivo a 1 ATR 15m, ${kalshiAtr ? fmt(kalshiAtr, currency) : '—'})` : '(precio actual)'}</span>
            )}
          </div>
          <p className="muted">Regla simple: si vas ganando y la señal se dio la vuelta, cobra. Si vas perdiendo y la señal va en tu contra, sal. Si la señal sigue a tu favor, aguanta hasta el cierre de la ventana. Todo virtual: nada de esto mueve dinero real ni tu cuenta de Kalshi.</p>

          {/* v15: §5 GRÁFICA — velas BTC 15m, al final. Sin botones
              de intervalo (siempre 15m), sin toggles de
              indicadores, sin pantalla completa ni panel RSI. Solo
              las velas y "Cargando velas…" si aún no llegaron. */}
          <section className="card">
            <div className="row"><h2>5 · Gráfica · BTC 15m</h2></div>
            <div ref={chartRef} className="chart" />
            {candles.length === 0 && (
              <p className="muted">{candlesError ? `Sin velas: ${candlesError}` : 'Cargando velas…'}</p>
            )}
          </section>


          {/* v14: MI CUENTA KALSHI discreta — solo un <details>.
              KalshiConnect en modo mínimo: sigue cargando las
              posiciones y subiendo la decisión real a la §2 y §3,
              pero NO muestra la tabla ni el historial. Sin
              sesión, solo los botones de entrar/crear cuenta. */}
          <details className="account-details">
            <summary>⚙️ Mi cuenta Kalshi — conectar / desconectar</summary>
            {user ? (
              <KalshiConnect token={token} kalshiScore={kalshiScore} kalshiVerdictKey={kalshiVerdict.key} currentPrice={kalshiPrice} referencePrice={kalshiRefPrice} referenceSource={kalshiRefSource} currency={currency} user={user} onLogout={handleLogout} active onRealDecision={handleRealDecisions} minimal />
            ) : (
              <div>
                <p className="muted">Entra o crea tu cuenta para conectar tu Kalshi y ver tus posiciones reales. La app nunca opera por ti: solo lee tus posiciones.</p>
                <div className="row">
                  <button onClick={() => { setShowAuth('login'); setAuthError(''); }}>Entrar</button>
                  <button onClick={() => { setShowAuth('register'); setAuthError(''); }}>Crear cuenta</button>
                </div>
              </div>
            )}
          </details>

        </section>

      <footer>Fuente de datos: APIs públicas de Coinbase, Kraken, Binance US y CoinGecko, consultadas por el servidor. Precios en vivo, no inventados. {APP_URL}</footer>
    </div>
  );
}
