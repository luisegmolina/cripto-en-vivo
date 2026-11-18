import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createChart } from 'lightweight-charts';
import { analyze, emaSeries, bollingerSeries } from './analysis.js';
import { updateLastCandle, candlesSignature, mergeServerCandles } from './liveCandle.js';
import { evaluateWindowSignal, backtestWindowSignal } from './windowOutcome.js';
import { multiTfVerdict, reasonsFor, atr, VERDICT_TFS } from './verdict.js';
import { window15m, kalshiVerdictForScore, estimatedProb, adjustProbForRecent, recentWinRate, cashOutDecision, suggestedExitPrice, brtiPositionOutcome, estimateSettlementPnl, liveDecision, marketRecommendation } from './kalshi.js';
import { shouldFireAlert, shouldSignalAlert, dedupePriceAlerts } from './alerts.js';
import { APP_URL } from './shareCard.js';
import { getToken, register, login, me, logout, apiAuth } from './auth.js';
import AdminPanel from './AdminPanel.jsx';
import LiveReference from './components/LiveReference.jsx';
import MyPosition from './components/MyPosition.jsx';
import Decision from './components/Decision.jsx';
import Signals from './components/Signals.jsx';
import ChartSection from './components/ChartSection.jsx';
import AccountBox from './components/AccountBox.jsx';
import AuthModal from './components/AuthModal.jsx';

const CUR = { USD: '$', EUR: '€', GBP: '£' };
const START_CASH = 10000;
const VERSION_LABEL = 'v15.3.1 — Corrección pantalla en blanco (v15.3) + gráfica con locale fijo';

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
function loadLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function saveLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
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
  const [error, setError] = useState('');
  const [candlesError, setCandlesError] = useState('');
  const [alerts, setAlerts] = useState([]);
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
  const candlesRef = useRef([]);

  // v15.3: la gráfica es siempre BTC 15m con EMA 20/50 y Bollinger:
  // sin toggles, sin RSI, sin comparar con BTC ni pantalla completa.

  // v15.3: la cartera virtual y las alertas de precio ya no tienen UI
  // (se eliminaron de la vista en v14 y el código en v15.3), pero el
  // ESTADO se conserva: la sincronización opcional con el servidor
  // (v12, pullOrPushServerData + subida con debounce) sigue usándolo,
  // y las alertas guardadas siguen sonando con cada tick (efecto de
  // abajo). Sin estado no habría nada que sincronizar.
  // v15.3.1: estas dos declaraciones se borraron por error en la
  // limpieza de v15.3 y la app quedaba en blanco con
  // "ReferenceError: priceAlerts is not defined" al renderizar
  // (línea de priceAlertsRef, durante el primer render). Restauradas
  // tal como estaban en v15.2; el build de Vite NO detecta variables
  // no declaradas, por eso pasó desapercibido.
  const [portfolio, setPortfolio] = useState(() => loadLS('cev_portfolio_v1', { cash: START_CASH, holdings: {}, trades: [] }));
  const [priceAlerts, setPriceAlerts] = useState(() => dedupePriceAlerts(loadLS('cev_price_alerts_v1', [])));
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

  // v15.3: el análisis general solo alimenta los patrones del gráfico
  // (marcadores de velas). El backtest/historial 1h se eliminó: no se
  // mostraba desde v14 y la medida que manda es la 15m de Kalshi
  // (backtestWindowSignal/evaluateWindowSignal, más abajo).
  const analysis = useMemo(() => analyze(candles), [candles]);

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
  // --- v11: cálculos del MODO KALSHI 15 MIN ---
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
  const kalshiAtr = useMemo(() => atr(candles15m), [last15mKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // v13.4: la medida 15m es la de KALSHI (windowOutcome.js): cierre
  // de la MISMA ventana vs su apertura (lo que liquida Kalshi), NO
  // la vela siguiente.
  const kalshiBacktest = useMemo(() => backtestWindowSignal(candles15m), [last15mKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const kalshiHist = useMemo(() => evaluateWindowSignal(candles15m, 5), [last15mKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // v13: si en las últimas ventanas la señal 15m acierta menos del
  // 50%, no se esconde: se avisa en la pestaña Kalshi y la confianza
  // estimada se baja (tope 60%). v13.4: además el veredicto muestra
  // "SEÑAL DÉBIL" junto a SUBE/BAJA/ESPERAR, no solo baja la confianza.
  const kalshiRecent = recentWinRate(kalshiHist);
  const kalshiWeakSignal = Boolean(kalshiRecent && kalshiRecent.rate < 0.5);
  // v15.3: ¿la señal 15m choca con los demás plazos? Si la mayoría de
  // los timeframes con señal clara van en contra de la señal 15m, la
  // recomendación del mercado (sin posición) dice ESPERAR, no inventa
  // un lado. Sin timeframes claros no hay conflicto: no bloquea.
  const marketWantKey = kalshiVerdict.key === 'up' ? 'buy' : kalshiVerdict.key === 'down' ? 'sell' : null;
  const mtfClearRows = (mtfVerdict.rows || []).filter((r) => r.key === 'buy' || r.key === 'sell');
  const marketConflict = Boolean(marketWantKey && mtfClearRows.length > 0
    && mtfClearRows.filter((r) => r.key === marketWantKey).length / mtfClearRows.length < 0.5);
  const marketRec = marketRecommendation({ signalKey: kalshiVerdict.key, weakSignal: kalshiWeakSignal, conflict: marketConflict, recent: kalshiRecent });
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

  // --- Datos: polling AL SERVIDOR (localhost:3001), nunca a los exchanges ---
  useEffect(() => {
    let alive = true;
    const loadTicker = async () => {
      try {
        const t = await api(`/api/ticker?symbol=${symbol}&currency=${currency}`);
        if (!alive) return;
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
        }
        setError((prev) => (prev === '' ? prev : ''));
      } catch (e) { if (alive) { setError(String(e.message || e)); } }
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
        }
      } catch { /* sin mercados: se mantiene la última lista */ }
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
    setCandles([]);
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
      // v15.3.1: locale explícito. Sin él, lightweight-charts usa
      // navigator.language y en navegadores con locale raro
      // (p. ej. "en-US@posix") rompe con "Invalid language tag" y la
      // gráfica queda vacía. La app ya formatea todo en es-US.
      localization: { locale: 'es-US' },
    });
    chartObj.current = chart;
    candleSeries.current = chart.addCandlestickSeries({ upColor: '#22c55e', downColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444' });
    volumeSeries.current = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '' });
    ema20Series.current = chart.addLineSeries({ color: '#f59e0b', lineWidth: 1, title: 'EMA 20', priceLineVisible: false, lastValueVisible: false });
    ema50Series.current = chart.addLineSeries({ color: '#38bdf8', lineWidth: 1, title: 'EMA 50', priceLineVisible: false, lastValueVisible: false });
    bbUpperSeries.current = chart.addLineSeries({ color: 'rgba(148,163,184,.7)', lineWidth: 1, title: 'Bollinger sup.', priceLineVisible: false, lastValueVisible: false });
    bbMiddleSeries.current = chart.addLineSeries({ color: 'rgba(148,163,184,.4)', lineWidth: 1, title: 'Bollinger media', priceLineVisible: false, lastValueVisible: false });
    bbLowerSeries.current = chart.addLineSeries({ color: 'rgba(148,163,184,.7)', lineWidth: 1, title: 'Bollinger inf.', priceLineVisible: false, lastValueVisible: false });
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
      lastChartSig.current = '';
    };
  }, []);

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
    const sig = `${candlesSignature(candles)}|${analysis.patterns.map((p) => `${p.time}:${p.name}`).join(',')}`;
    if (sig === lastChartSig.current) return;
    lastChartSig.current = sig;
    candleSeries.current.setData(candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
    volumeSeries.current.setData(candles.map((c) => ({ time: c.time, value: c.volume || 0, color: c.close >= c.open ? 'rgba(34,197,94,.5)' : 'rgba(239,68,68,.5)' })));
    candleSeries.current.setMarkers(analysis.patterns.map((p) => ({
      time: p.time, position: p.dir === 'up' ? 'belowBar' : p.dir === 'down' ? 'aboveBar' : 'inBar',
      color: p.dir === 'up' ? '#22c55e' : p.dir === 'down' ? '#ef4444' : '#94a3b8',
      shape: p.dir === 'up' ? 'arrowUp' : p.dir === 'down' ? 'arrowDown' : 'circle', text: p.name,
    })));
    // EMA 20/50 como líneas (siempre visibles).
    const toPoints = (series) => times.map((t, i) => (series[i] == null ? null : { time: t, value: series[i] })).filter(Boolean);
    try {
      ema20Series.current?.setData(toPoints(emaSeries(closes, 20)));
      ema50Series.current?.setData(toPoints(emaSeries(closes, 50)));
    } catch {}
    // Bollinger como 3 líneas (siempre visibles).
    try {
      const bb = bollingerSeries(closes);
      const pick = (k) => times.map((t, i) => (bb[i] == null ? null : { time: t, value: bb[i][k] })).filter(Boolean);
      bbUpperSeries.current?.setData(pick('upper'));
      bbMiddleSeries.current?.setData(pick('middle'));
      bbLowerSeries.current?.setData(pick('lower'));
    } catch {}
    const lastTime = candles.length ? candles[candles.length - 1].time : null;
    if (lastTime !== lastChartTime.current) {
      lastChartTime.current = lastTime;
      chartObj.current.timeScale().scrollToRealTime();
    }
  }, [candles, analysis, chartReady]);

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


      {showAuth && (
        <AuthModal showAuth={showAuth} authName={authName} onAuthName={setAuthName} authEmail={authEmail} onAuthEmail={setAuthEmail} authPassword={authPassword} onAuthPassword={setAuthPassword} authBusy={authBusy} authError={authError} onSubmit={handleAuthSubmit} onClose={() => setShowAuth(null)} onSwitchMode={(m) => { setShowAuth(m); setAuthError(''); }} />
      )}

      <p className="warn">⚠️ Prueba educativa, dinero virtual, solo lectura: la app nunca opera por ti. Kalshi liquida con el índice BRTI (promedio de 60 s), no con Coinbase.</p>

      {error && <div className="error">No se pudo cargar desde el servidor: {error}. Revisa que el servidor esté corriendo (npm run dev en la carpeta raíz).</div>}

        <section className={`card verdict-card kalshi-card verdict-${kalshiVerdict.key === 'up' ? 'buy' : kalshiVerdict.key === 'down' ? 'sell' : 'wait'}`} aria-label="Modo Kalshi 15 minutos">
          <MyPosition user={user} realDecisions={realDecisions} brtiArgs={brtiArgs} fmt={fmt} />
          <Decision user={user} firstRealDecision={firstRealDecision} liveDecisionNow={liveDecisionNow} marketRec={marketRec} kalshiScore={kalshiScore} kalshiReasons={kalshiReasons} />
          <LiveReference symbol={symbol} currency={currency} kalshiWin={kalshiWin} kalshiTargetPrice={kalshiTargetPrice} kalshiMarket={kalshiMarket} kalshiPrice={kalshiPrice} kalshiRefSource={kalshiRefSource} brti={brti} brtiDiff={brtiDiff} brtiDiffPct={brtiDiffPct} fmt={fmt} user={user} />
          <Signals kalshiVerdict={kalshiVerdict} kalshiWeakSignal={kalshiWeakSignal} kalshiScore={kalshiScore} kalshiProbAdj={kalshiProbAdj} kalshiBacktest={kalshiBacktest} kalshiRecent={kalshiRecent} kalshiReasons={kalshiReasons} kalshiEntryPrice={kalshiEntryPrice} onKalshiEntryPrice={setKalshiEntryPrice} kalshiDir={kalshiDir} onKalshiDir={setKalshiDir} kalshiAmount={kalshiAmount} onKalshiAmount={setKalshiAmount} onSaveKalshiPosition={setKalshiPosition} onClearKalshiPosition={clearKalshiPosition} kalshiMsg={kalshiMsg} kalshiDecision={kalshiDecision} kalshiPrice={kalshiPrice} kalshiEntryNum={kalshiEntryNum} kalshiExitPrice={kalshiExitPrice} kalshiAtr={kalshiAtr} currency={currency} currencySym={CUR[currency]} fmt={fmt} />
          <ChartSection chartRef={chartRef} candles={candles} candlesError={candlesError} />
          <AccountBox user={user} token={token} kalshiScore={kalshiScore} kalshiVerdictKey={kalshiVerdict.key} kalshiPrice={kalshiPrice} kalshiRefPrice={kalshiRefPrice} kalshiRefSource={kalshiRefSource} currency={currency} onLogout={handleLogout} onRealDecision={handleRealDecisions} onShowAuth={(m) => { setShowAuth(m); setAuthError(''); }} />
        </section>


      <footer>Fuente de datos: APIs públicas de Coinbase, Kraken, Binance US y CoinGecko, consultadas por el servidor. Precios en vivo, no inventados. {APP_URL}</footer>
    </div>
  );
}
