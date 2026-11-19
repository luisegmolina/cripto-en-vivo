import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createChart } from 'lightweight-charts';
import { analyze, emaSeries, bollingerSeries } from './analysis.js';
import { updateLastCandle, candlesSignature, mergeServerCandles } from './liveCandle.js';
import { evaluateWindowSignal, backtestWindowSignal } from './windowOutcome.js';
import { multiTfVerdict, reasonsFor, atr, VERDICT_TFS } from './verdict.js';
import { window15m, fmtCountdown, kalshiVerdictForScore, estimatedProb, adjustProbForRecent, recentWinRate, cashOutDecision, suggestedExitPrice, brtiPositionOutcome, estimateSettlementPnl, liveDecision, marketRecommendation, detectMarketMovement, buildBetPlan } from './kalshi.js';
import { shouldFireAlert, shouldSignalAlert, dedupePriceAlerts } from './alerts.js';
import { APP_URL } from './shareCard.js';
import { getToken, register, login, me, logout, apiAuth } from './auth.js';
import { webauthnLogin, isPlatformAuthenticatorAvailable } from './webauthn.js';
import AdminPanel from './AdminPanel.jsx';
import LiveReference from './components/LiveReference.jsx';
import MyPosition from './components/MyPosition.jsx';
import Decision from './components/Decision.jsx';
import Signals from './components/Signals.jsx';
import ChartSection from './components/ChartSection.jsx';
import PaperAudit from './components/PaperAudit.jsx';
import PaperTrader from './components/PaperTrader.jsx';
import LiveTrader from './components/LiveTrader.jsx';
import AccountBox from './components/AccountBox.jsx';
import AuthModal from './components/AuthModal.jsx';
import SiteGate from './components/SiteGate.jsx';
import { siteGateStatus, onSiteGateLocked, emitSiteGateLocked } from './siteGate.js';

const CUR = { USD: '$', EUR: '€', GBP: '£' };
const START_CASH = 10000;
const VERSION_LABEL = 'v16.9 — Entradas del trader en vivo';

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
    if (!r.ok) {
      const err = new Error(j.error || `HTTP ${r.status} en ${path}`);
      err.status = r.status;
      // v16.5 — 403 {error:'site_gate'}: el PIN se puso en otro lado y
      // este navegador ya no tiene la cookie: mostrar la pantalla PIN.
      if (r.status === 403 && j.error === 'site_gate') emitSiteGateLocked();
      throw err;
    }
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
  const [candleInterval, setCandleInterval] = useState('15m');

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
  const [realDecisions, setRealDecisions] = useState([]);
  const handleRealDecisions = (list) => {
    setRealDecisions((prev) => {
      const next = Array.isArray(list) ? list : [];
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
    });
  };
  const [kalshiMarket, setKalshiMarket] = useState(null);
  const [brti, setBrti] = useState(null);
  useEffect(() => { saveLS('cev_kalshi_position_v1', { entryPrice: kalshiEntryPrice, dir: kalshiDir, amount: kalshiAmount, entryScore: kalshiPos.entryScore }); }, [kalshiEntryPrice, kalshiDir, kalshiAmount]); // eslint-disable-line react-hooks/exhaustive-deps

  const [token, setTokenState] = useState(() => getToken());
  const [user, setUser] = useState(null);
  const [view, setView] = useState(() => (typeof window !== 'undefined' && window.location.hash === '#admin' ? 'admin' : 'app'));
  const [showAuth, setShowAuth] = useState(null);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authName, setAuthName] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  // v16.4 — entrada con huella / rostro (WebAuthn): si el navegador y
  // el dispositivo lo admiten, el modal muestra el botón; si no, lo
  // muestra deshabilitado con la explicación.
  const [webauthnAvailable, setWebauthnAvailable] = useState(false);
  const [webauthnBusy, setWebauthnBusy] = useState(false);
  const [webauthnError, setWebauthnError] = useState('');
  useEffect(() => {
    let vivo = true;
    isPlatformAuthenticatorAvailable().then((v) => { if (vivo) setWebauthnAvailable(v === true); }).catch(() => {});
    return () => { vivo = false; };
  }, []);
  const serverSyncDone = useRef(false);

  // v16.5 — PIN de acceso al sitio: al arrancar, ANTES de intentar
  // restaurar la sesión, se comprueba si la puerta está cerrada para
  // este navegador (GET /api/site-gate/status). Si locked:true, solo
  // se muestra la pantalla SiteGate (nada de la app, nada del login).
  // Si la comprobación falla (servidor viejo sin la ruta, o servidor
  // caído), el arranque sigue normal: sin PIN puesto nada cambia, y
  // con PIN puesto el servidor bloquea igual las llamadas con 403
  // site_gate, que aquí mismo muestran la pantalla SiteGate.
  const [gateState, setGateState] = useState('checking'); // 'checking' | 'locked' | 'open'

  useEffect(() => {
    let vivo = true;
    siteGateStatus()
      .then((s) => { if (vivo) setGateState(s && s.locked ? 'locked' : 'open'); })
      .catch(() => { if (vivo) setGateState('open'); });
    return () => { vivo = false; };
  }, []);

  // v16.5 — si cualquier llamada API devuelve 403 site_gate (el PIN se
  // puso en otro dispositivo mientras esta pestaña estaba abierta),
  // muestra la pantalla SiteGate en vez de romper.
  useEffect(() => onSiteGateLocked(() => setGateState('locked')), []);

  // v16.5 — tras verify OK el servidor ya puso la cookie de puerta en
  // este navegador: confiar en el verify, no re-preguntar el status.
  // El status devuelve locked:true mientras exista un PIN, así que
  // re-preguntarlo dejaría la pantalla del PIN atascada (el PIN sigue
  // existiendo aunque este navegador ya tenga cookie). Si la cookie no
  // quedara guardada, la siguiente llamada API daría 403 site_gate y
  // la pantalla volvería sola.
  function handleGateUnlocked() {
    setGateState('open');
  }

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
    } catch {}
    serverSyncDone.current = true;
  }

  useEffect(() => {
    if (gateState !== 'open') return;
    const t = getToken();
    if (!t) return;
    me().then((u) => { setUser(u); pullOrPushServerData(); }).catch((e) => {
      if (e.status === 401) setTokenState(null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateState]);

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

  // v16.4 — entrar con huella / rostro (WebAuthn). Hace falta el email
  // en el modal (el servidor busca las credenciales por email). Devuelve
  // la misma sesión JWT que el login con password.
  async function handleWebauthnLogin() {
    setWebauthnError('');
    if (!authEmail.trim()) { setWebauthnError('Pon tu email primero para entrar con huella.'); return; }
    setWebauthnBusy(true);
    try {
      const data = await webauthnLogin(authEmail.trim());
      setTokenState(getToken());
      setUser(data.user || null);
      setShowAuth(null);
      setAuthPassword('');
      setAuthName('');
      serverSyncDone.current = false;
      pullOrPushServerData();
    } catch (err) { setWebauthnError(err.message || 'No se pudo entrar con huella.'); }
    finally { setWebauthnBusy(false); }
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
  const [chartReady, setChartReady] = useState(0);
  const candleSeries = useRef(null);
  const volumeSeries = useRef(null);
  const ema9Series = useRef(null);
  const ema20Series = useRef(null);
  const ema50Series = useRef(null);
  const bbUpperSeries = useRef(null);
  const bbMiddleSeries = useRef(null);
  const bbLowerSeries = useRef(null);
  const candlesRef = useRef([]);

  const [portfolio, setPortfolio] = useState(() => loadLS('cev_portfolio_v1', { cash: START_CASH, holdings: {}, trades: [] }));
  const [priceAlerts, setPriceAlerts] = useState(() => dedupePriceAlerts(loadLS('cev_price_alerts_v1', [])));
  const priceAlertsRef = useRef(priceAlerts);
  priceAlertsRef.current = priceAlerts;
  const alertCooldownRef = useRef(loadLS('cev_alert_cooldown_v1', {}));
  const prevVerdictKey = useRef(null);
  const lastSignalAlertRef = useRef(null);

  useEffect(() => { saveLS('cev_portfolio_v1', portfolio); }, [portfolio]);
  useEffect(() => { saveLS('cev_price_alerts_v1', priceAlerts); }, [priceAlerts]);

  useEffect(() => {
    if (!user || !serverSyncDone.current) return;
    const t = setTimeout(() => {
      apiAuth('/api/me/portfolio', { method: 'PUT', body: { portfolio } }).catch(() => {});
      apiAuth('/api/me/alerts', { method: 'PUT', body: { alerts: priceAlerts } }).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [portfolio, priceAlerts, user]);

  const analysis = useMemo(() => analyze(candles), [candles]);

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

  const kalshiPrice = ticker?.price ?? markets.find((m) => m.symbol === symbol)?.price ?? null;
  const kalshiWin = window15m(nowMs);
  const candles15m = (candleInterval === '15m' && candles.length >= 32)
    ? candles
    : ((mtfCandles['15m'] && mtfCandles['15m'].length >= 32)
      ? mtfCandles['15m']
      : (candleInterval === '15m' ? candles : []));
  const last15mKey = candlesSignature(candles15m);
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
  const kalshiTargetPrice = kalshiMarket && kalshiMarket.source === 'kalshi' ? kalshiMarket.targetPrice : null;
  const kalshiRefPrice = kalshiTargetPrice ?? kalshiCandleOpen;
  const kalshiRefSource = kalshiTargetPrice != null ? 'kalshi' : 'coinbase';

  const brtiArgs = {
    targetPrice: kalshiTargetPrice,
    avg60s: brti && brti.source === 'kalshi' ? brti.avg60s : null,
    value: brti && brti.source === 'kalshi' ? brti.value : null,
  };
  const brtiRefPrice = brti && brti.source === 'kalshi' && brti.avg60s != null ? brti.avg60s : null;
  const brtiDiff = brtiRefPrice != null && kalshiTargetPrice ? brtiRefPrice - kalshiTargetPrice : null;
  const brtiDiffPct = brtiDiff != null && kalshiTargetPrice ? (brtiDiff / kalshiTargetPrice) * 100 : null;
  const firstRealDecision = realDecisions.find((d) => d.decision) || null;
  const firstOutcome = firstRealDecision ? brtiPositionOutcome({ dir: firstRealDecision.dir, ...brtiArgs }) : null;
  const liveDecisionNow = firstRealDecision ? liveDecision({ winning: firstOutcome ? firstOutcome.winning : null, signalKey: kalshiVerdict.key, signalScore: kalshiScore, dir: firstRealDecision.dir, contractCents: firstRealDecision.currentPriceCents, remainingMs: kalshiWin.remainingMs }) : null;
  const kalshiAtr = useMemo(() => atr(candles15m), [last15mKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const kalshiBacktest = useMemo(() => backtestWindowSignal(candles15m), [last15mKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const kalshiHist = useMemo(() => evaluateWindowSignal(candles15m, 5), [last15mKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const kalshiRecent = recentWinRate(kalshiHist);
  const kalshiWeakSignal = Boolean(kalshiRecent && kalshiRecent.rate < 0.5);
  const marketWantKey = kalshiVerdict.key === 'up' ? 'buy' : kalshiVerdict.key === 'down' ? 'sell' : null;
  const mtfClearRows = (mtfVerdict.rows || []).filter((r) => r.key === 'buy' || r.key === 'sell');
  const marketConflict = Boolean(marketWantKey && mtfClearRows.length > 0
    && mtfClearRows.filter((r) => r.key === marketWantKey).length / mtfClearRows.length < 0.5);
  const marketRec = marketRecommendation({ signalKey: kalshiVerdict.key, weakSignal: kalshiWeakSignal, conflict: marketConflict, recent: kalshiRecent });
  const kalshiProbAdj = adjustProbForRecent(kalshiProb, kalshiHist);

  const marketMovement = useMemo(() => detectMarketMovement({
    candles15m, mtfAnalysis, spotPrice: kalshiPrice, targetPrice: kalshiTargetPrice,
    brtiAvg60s: brtiRefPrice, atr15m: kalshiAtr,
  }), [last15mKey, mtfAnalysis, kalshiPrice, kalshiTargetPrice, brtiRefPrice, kalshiAtr]); // eslint-disable-line react-hooks/exhaustive-deps

  const betPlan = useMemo(() => buildBetPlan({
    marketRec, movement: marketMovement, kalshiScore, kalshiProbAdj,
    kalshiMarket, brtiDiff, kalshiAtr, remainingMs: kalshiWin.remainingMs,
  }), [marketRec, marketMovement, kalshiScore, kalshiProbAdj, kalshiMarket, brtiDiff, kalshiAtr, kalshiWin.remainingMs]);

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
    setKalshiPos({ entryPrice: kalshiEntryPrice, dir: kalshiDir, amount: kalshiAmount, entryScore: kalshiScore });
    saveLS('cev_kalshi_position_v1', { entryPrice: kalshiEntryPrice, dir: kalshiDir, amount: kalshiAmount, entryScore: kalshiScore });
    setKalshiMsg(`Posición virtual guardada: apostaste a que ${kalshiDir === 'up' ? 'SUBE' : 'BAJA'} desde ${fmt(kalshiEntryNum, currency)} con ${fmt(kalshiAmountNum, currency)} virtuales.`);
  };
  const clearKalshiPosition = () => {
    setKalshiPos({ entryPrice: '', dir: 'up', amount: '100', entryScore: null });
    setKalshiEntryPrice(''); setKalshiDir('up'); setKalshiAmount('100');
    saveLS('cev_kalshi_position_v1', { entryPrice: '', dir: 'up', amount: '100', entryScore: null });
    setKalshiMsg('Posición virtual borrada.');
  };

  useEffect(() => {
    if (gateState !== 'open') return; // v16.5 — puerta cerrada: sin sondeo
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
  }, [symbol, gateState]);

  useEffect(() => {
    if (gateState !== 'open' || activeTab !== 'kalshi' || symbol !== 'BTC' || !user) { setBrti(null); return; }
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
  }, [activeTab, symbol, user?.id, gateState]);

  useEffect(() => {
    if (gateState !== 'open') return; // v16.5 — puerta cerrada: sin sondeo
    let alive = true;
    const loadTicker = async () => {
      try {
        const t = await api(`/api/ticker?symbol=${symbol}&currency=${currency}`);
        if (!alive) return;
        const live = updateLastCandle(candlesRef.current, t.price, candleInterval);
        if (live && live !== candlesRef.current) {
          const last = live[live.length - 1];
          candlesRef.current = live;
          try {
            candleSeries.current?.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
            volumeSeries.current?.update({ time: last.time, value: last.volume || 0, color: last.close >= last.open ? 'rgba(16,185,129,.5)' : 'rgba(244,63,94,.5)' });
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
      } catch {}
    };
    const loadCandles = async () => {
      try {
        const c = await api(`/api/candles?symbol=${symbol}&currency=${currency}&interval=${candleInterval}`);
        if (!alive) return;
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
  }, [symbol, currency, candleInterval, gateState]);

  useEffect(() => {
    candlesRef.current = [];
    lastCandlesSig.current = '';
    lastChartSig.current = '';
    lastChartTime.current = null;
    setCandles([]);
  }, [symbol, currency, candleInterval]);

  useEffect(() => {
    if (gateState !== 'open') return; // v16.5 — puerta cerrada: sin sondeo
    let alive = true;
    const load = async () => {
      const settled = await Promise.allSettled(VERDICT_TFS.map((tf) => api(`/api/candles?symbol=${symbol}&currency=${currency}&interval=${tf}`)));
      if (!alive) return;
      const next = {};
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value.candles && r.value.candles.length) next[VERDICT_TFS[i]] = r.value.candles;
      });
      setMtfCandles((prev) => {
        const sig = (o) => VERDICT_TFS.map((tf) => candlesSignature(o[tf])).join('|');
        return sig(next) === sig(prev) ? prev : next;
      });
    };
    load();
    const stop = visibleInterval(load, 20000);
    return () => { alive = false; stop(); };
  }, [symbol, currency, gateState]);

  useEffect(() => {
    if (!ticker || ticker.price == null) return;
    const price = ticker.price;
    const nowMs = Date.now();
    let fired = false;
    const next = priceAlertsRef.current.map((a) => {
      if (a.triggered || a.symbol !== symbol || a.currency !== currency) return a;
      const hit = a.direction === 'above' ? price >= a.target : price <= a.target;
      if (!hit) return a;
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

  const verdictKeyNow = mtfVerdict.verdict.key;
  useEffect(() => {
    const prev = prevVerdictKey.current;
    prevVerdictKey.current = verdictKeyNow;
    if (!prev) return;
    if (prev === verdictKeyNow) return;
    const flips = (prev === 'buy' && verdictKeyNow === 'sell') || (prev === 'sell' && verdictKeyNow === 'buy');
    const msg = flips
      ? `🚨 CAMBIO DE SEÑAL ${symbol}: ${prev === 'buy' ? 'COMPRAR' : 'VENDER'} → ${verdictKeyNow === 'buy' ? 'COMPRAR' : 'VENDER'} (puntuación ${mtfVerdict.score}, índice de coincidencia ${mtfVerdict.confidence}/95) — ${new Date().toLocaleTimeString('es-US')}`
      : `🔔 Señal ${symbol}: ahora ${mtfVerdict.verdict.label} (puntuación ${mtfVerdict.score}) — ${new Date().toLocaleTimeString('es-US')}`;
    const nowMs = Date.now();
    const chk = shouldSignalAlert(lastSignalAlertRef.current, nowMs);
    lastSignalAlertRef.current = { at: nowMs, key: verdictKeyNow };
    if (!chk.fire && chk.replace) {
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
  useEffect(() => {
    const el = chartRef.current;
    if (!el) return undefined;
    const chart = createChart(el, {
      width: el.clientWidth, height: 320,
      layout: { background: { color: '#090d16' }, textColor: '#cbd5e1' },
      grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      timeScale: { timeVisible: true, secondsVisible: false },
      localization: { locale: 'es-US' },
    });
    chartObj.current = chart;
    candleSeries.current = chart.addCandlestickSeries({ upColor: '#10b981', downColor: '#f43f5e', wickUpColor: '#10b981', wickDownColor: '#f43f5e' });
    volumeSeries.current = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '' });
    ema9Series.current = chart.addLineSeries({ color: '#a855f7', lineWidth: 1, title: 'EMA 9', priceLineVisible: false, lastValueVisible: false });
    ema20Series.current = chart.addLineSeries({ color: '#f59e0b', lineWidth: 1, title: 'EMA 20', priceLineVisible: false, lastValueVisible: false });
    ema50Series.current = chart.addLineSeries({ color: '#38bdf8', lineWidth: 1, title: 'EMA 50', priceLineVisible: false, lastValueVisible: false });
    bbUpperSeries.current = chart.addLineSeries({ color: 'rgba(148,163,184,.55)', lineWidth: 1, title: 'Bollinger sup.', priceLineVisible: false, lastValueVisible: false });
    bbMiddleSeries.current = chart.addLineSeries({ color: 'rgba(148,163,184,.3)', lineWidth: 1, title: 'Bollinger media', priceLineVisible: false, lastValueVisible: false });
    bbLowerSeries.current = chart.addLineSeries({ color: 'rgba(148,163,184,.55)', lineWidth: 1, title: 'Bollinger inf.', priceLineVisible: false, lastValueVisible: false });
    const onResize = () => { try { chart.applyOptions({ width: el.clientWidth }); } catch {} };
    window.addEventListener('resize', onResize);
    let ro = null;
    try {
      ro = new ResizeObserver(() => { try { chart.applyOptions({ width: el.clientWidth }); } catch {} });
      ro.observe(el);
    } catch {}
    lastChartSig.current = '';
    setChartReady((n) => n + 1);
    return () => {
      window.removeEventListener('resize', onResize);
      try { ro && ro.disconnect(); } catch {}
      chart.remove();
      chartObj.current = null;
      candleSeries.current = null;
      volumeSeries.current = null;
      ema9Series.current = null;
      ema20Series.current = null;
      ema50Series.current = null;
      bbUpperSeries.current = null;
      bbMiddleSeries.current = null;
      bbLowerSeries.current = null;
      lastChartSig.current = '';
    };
    // v16.5 — gateState en deps: con la puerta cerrada el contenedor no
    // existe al montar (el === null) y el gráfico debe crearse al abrir.
  }, [gateState]);

  useEffect(() => {
    if (!candleSeries.current || !volumeSeries.current || !chartObj.current) return;
    if (!candles.length) {
      try { candleSeries.current.setData([]); volumeSeries.current.setData([]); } catch {}
      return;
    }
    const closes = candles.map((c) => c.close);
    const times = candles.map((c) => c.time);
    const sig = `${candlesSignature(candles)}|${analysis.patterns.map((p) => `${p.time}:${p.name}`).join(',')}`;
    if (sig === lastChartSig.current) return;
    lastChartSig.current = sig;
    candleSeries.current.setData(candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
    volumeSeries.current.setData(candles.map((c) => ({ time: c.time, value: c.volume || 0, color: c.close >= c.open ? 'rgba(16,185,129,.45)' : 'rgba(244,63,94,.45)' })));
    candleSeries.current.setMarkers(analysis.patterns.map((p) => ({
      time: p.time, position: p.dir === 'up' ? 'belowBar' : p.dir === 'down' ? 'aboveBar' : 'inBar',
      color: p.dir === 'up' ? '#10b981' : p.dir === 'down' ? '#f43f5e' : '#94a3b8',
      shape: p.dir === 'up' ? 'arrowUp' : p.dir === 'down' ? 'arrowDown' : 'circle', text: p.name,
    })));
    const toPoints = (series) => times.map((t, i) => (series[i] == null ? null : { time: t, value: series[i] })).filter(Boolean);
    try {
      ema9Series.current?.setData(toPoints(emaSeries(closes, 9)));
      ema20Series.current?.setData(toPoints(emaSeries(closes, 20)));
      ema50Series.current?.setData(toPoints(emaSeries(closes, 50)));
    } catch {}
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

  // v16.5 — puerta del sitio: con la puerta cerrada se muestra SOLO la
  // pantalla SiteGate (nada de la app, nada del login, tampoco la vista
  // admin). Mientras se comprueba el status, solo un "comprobando".
  if (gateState === 'locked') {
    return (
      <div className="app">
        <SiteGate onUnlocked={handleGateUnlocked} />
      </div>
    );
  }
  if (gateState === 'checking') {
    return (
      <div className="app">
        <section className="card"><p className="muted">Comprobando el acceso al sitio…</p></section>
      </div>
    );
  }

  if (view === 'admin') {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand-row"><h1>₿ Cripto en Vivo</h1><span className="version-pill">{VERSION_LABEL}</span></div>
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
        <footer>Fuente de datos: APIs públicas de Coinbase, Kraken, Binance US y CoinGecko. {APP_URL}</footer>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand-row">
          <h1>₿ Cripto en Vivo</h1>
          <span className="version-pill">{VERSION_LABEL}</span>
        </div>
        <div className="window-pill">
          <span className="muted">Cierre 15m:</span>
          <b className="countdown">{fmtCountdown(kalshiWin.remainingMs)}</b>
        </div>
        <div className="row">
          {!user ? (
            <>
              <button onClick={() => { setShowAuth('login'); setAuthError(''); }}>Entrar</button>
              <button className="primary" onClick={() => { setShowAuth('register'); setAuthError(''); }}>Crear cuenta</button>
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
        <AuthModal showAuth={showAuth} authName={authName} onAuthName={setAuthName} authEmail={authEmail} onAuthEmail={setAuthEmail} authPassword={authPassword} onAuthPassword={setAuthPassword} authBusy={authBusy} authError={authError} onSubmit={handleAuthSubmit} onClose={() => setShowAuth(null)} onSwitchMode={(m) => { setShowAuth(m); setAuthError(''); }} webauthnAvailable={webauthnAvailable} onWebauthnLogin={handleWebauthnLogin} webauthnBusy={webauthnBusy} webauthnError={webauthnError} />
      )}

      <p className="warn">⚠️ Prueba educativa, dinero virtual: con el bot en vivo APAGADO (§7), la app nunca opera por ti. Si lo enciendes y lo armas, sí puede enviar órdenes en Kalshi. Kalshi liquida con el índice BRTI (promedio de 60 s), no con Coinbase.</p>

      {error && <div className="error">No se pudo cargar desde el servidor: {error}. Revisa que el servidor esté corriendo (npm run dev en la carpeta raíz).</div>}

      <section className="terminal-grid" aria-label="Modo Kalshi 15 minutos">
        <MyPosition user={user} realDecisions={realDecisions} brtiArgs={brtiArgs} fmt={fmt} />
        <Decision user={user} firstRealDecision={firstRealDecision} liveDecisionNow={liveDecisionNow} marketRec={marketRec} kalshiScore={kalshiScore} kalshiReasons={kalshiReasons} marketMovement={marketMovement} betPlan={betPlan} />
        <LiveReference symbol={symbol} currency={currency} kalshiWin={kalshiWin} kalshiTargetPrice={kalshiTargetPrice} kalshiMarket={kalshiMarket} kalshiPrice={kalshiPrice} kalshiRefSource={kalshiRefSource} brti={brti} brtiDiff={brtiDiff} brtiDiffPct={brtiDiffPct} fmt={fmt} user={user} marketMovement={marketMovement} />
        <Signals kalshiVerdict={kalshiVerdict} kalshiWeakSignal={kalshiWeakSignal} kalshiScore={kalshiScore} kalshiProbAdj={kalshiProbAdj} kalshiBacktest={kalshiBacktest} kalshiRecent={kalshiRecent} kalshiReasons={kalshiReasons} kalshiEntryPrice={kalshiEntryPrice} onKalshiEntryPrice={setKalshiEntryPrice} kalshiDir={kalshiDir} onKalshiDir={setKalshiDir} kalshiAmount={kalshiAmount} onKalshiAmount={setKalshiAmount} onSaveKalshiPosition={setKalshiPosition} onClearKalshiPosition={clearKalshiPosition} kalshiMsg={kalshiMsg} kalshiDecision={kalshiDecision} kalshiPrice={kalshiPrice} kalshiEntryNum={kalshiEntryNum} kalshiExitPrice={kalshiExitPrice} kalshiAtr={kalshiAtr} currency={currency} currencySym={CUR[currency]} fmt={fmt} marketMovement={marketMovement} />
        <ChartSection chartRef={chartRef} candles={candles} candlesError={candlesError} />
        <PaperAudit user={user} fmt={fmt} />
        <PaperTrader user={user} fmt={fmt} />
        <LiveTrader user={user} fmt={fmt} />
        <AccountBox user={user} token={token} kalshiScore={kalshiScore} kalshiVerdictKey={kalshiVerdict.key} kalshiPrice={kalshiPrice} kalshiRefPrice={kalshiRefPrice} kalshiRefSource={kalshiRefSource} currency={currency} onLogout={handleLogout} onRealDecision={handleRealDecisions} onShowAuth={(m) => { setShowAuth(m); setAuthError(''); }} />
      </section>

      <footer>Fuente de datos: APIs públicas de Coinbase, Kraken, Binance US y CoinGecko, consultadas por el servidor. {APP_URL}</footer>
    </div>
  );
}
