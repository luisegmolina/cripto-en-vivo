import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createChart } from 'lightweight-charts';
import { analyze } from './analysis.js';
import { updateLastCandle, candlesSignature, mergeServerCandles } from './liveCandle.js';

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
  const [candleInterval, setCandleInterval] = useState('1m');
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
  const candlesRef = useRef([]);

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

  // Activos distintos visitados (logro Explorador).
  useEffect(() => {
    const visited = loadLS('cev_visited_v1', []);
    if (!visited.includes(symbol)) {
      const next = [...visited, symbol];
      saveLS('cev_visited_v1', next);
      if (next.length >= 5) unlock('explorador');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const analysis = useMemo(() => analyze(candles), [candles]);

  // --- Datos: polling AL SERVIDOR (localhost:3001), nunca a los exchanges ---
  useEffect(() => {
    let alive = true;
    const loadTicker = async () => {
      try {
        const t = await api(`/api/ticker?symbol=${symbol}&currency=${currency}`);
        if (!alive) return;
        if (prevPrice.current != null && t.price !== prevPrice.current) {
          const dir = t.price > prevPrice.current ? 'up' : 'down';
          setFlash((f) => (f === dir ? f : dir));
        }
        prevPrice.current = t.price;
        // *** GRÁFICO EN VIVO: cada tick mueve la última vela ***
        // Antes el ticker solo actualizaba el precio grande; la vela
        // solo cambiaba cada 6 s con el fetch de velas. Ahora cada tick
        // actualiza close/high/low de la vela en curso (updateLastCandle),
        // se pinta al instante con series.update() y se guarda en el
        // estado para que el análisis (RSI/MACD/...) también se mueva.
        // Si el tick cae en un bucket nuevo, se crea la vela de ese
        // bucket con el precio del tick; el próximo fetch del servidor
        // la reemplaza por la vela oficial. La última vela de Coinbase
        // va con ~4-5 min de retraso en 1m, por eso sin esto el gráfico
        // parecía congelado aunque el precio sí se movía.
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
  }, [symbol, currency, candleInterval]);

  // --- Alertas de precio personalizadas: se comprueban con cada tick ---
  useEffect(() => {
    if (!ticker || ticker.price == null) return;
    const price = ticker.price;
    let fired = false;
    const next = priceAlertsRef.current.map((a) => {
      if (a.triggered || a.symbol !== symbol || a.currency !== currency) return a;
      const hit = a.direction === 'above' ? price >= a.target : price <= a.target;
      if (!hit) return a;
      fired = true;
      const msg = `🔔 ${a.symbol}: llegó a ${fmt(price, currency)} (${a.direction === 'above' ? 'por encima de' : 'por debajo de'} ${fmt(a.target, currency)}) — ${new Date().toLocaleTimeString('es-US')}`;
      setAlerts((prev) => [msg, ...prev].slice(0, 20));
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification('Cripto en Vivo — alerta de precio', { body: msg }); } catch {}
      }
      return { ...a, triggered: true, triggeredAt: new Date().toISOString() };
    });
    if (fired) setPriceAlerts(next);
  }, [ticker, symbol, currency]);

  // --- Alertas cuando cambia la señal ---
  const signalLabel = analysis.label;
  const signalScore = analysis.score;
  useEffect(() => {
    const sig = signalLabel;
    if (sig !== 'Posible subida' && sig !== 'Posible bajada') { alertedKey.current = ''; return; }
    const key = `${symbol}|${sig}|${signalScore}`;
    if (key === alertedKey.current) return;
    alertedKey.current = key;
    const msg = `${symbol}: ${sig} (${analysis.score}, ${analysis.strength}) — ${new Date().toLocaleTimeString('es-US')}`;
    setAlerts((a) => [msg, ...a].slice(0, 20));
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification('Cripto en Vivo', { body: msg }); } catch {}
    }
  }, [signalLabel, signalScore, symbol]);

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
    const onResize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.remove();
      chartObj.current = null;
      candleSeries.current = null;
      volumeSeries.current = null;
      lastChartSig.current = '';
    };
  }, []);

  // --- Gráfico de velas: datos (solo cuando cambia la firma de las velas) ---
  // La firma ya incluye la última vela actualizada por cada tick, así que
  // este efecto NO congela el gráfico: cada tick cambia la firma y se
  // repinta. Solo se evita el scroll automático si la última vela no es
  // nueva (para no sacarte del gráfico si hiciste scroll atrás).
  useEffect(() => {
    if (!candleSeries.current || !volumeSeries.current || !chartObj.current) return;
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
    const lastTime = candles.length ? candles[candles.length - 1].time : null;
    if (lastTime !== lastChartTime.current) {
      lastChartTime.current = lastTime;
      chartObj.current.timeScale().scrollToRealTime();
    }
  }, [candles, analysis]);

  const testServer = async () => {
    setTestResult('Probando…');
    setDebugInfo('');
    try {
      const t0 = Date.now();
      const h = await api('/api/health');
      const ms = Date.now() - t0;
      setServerStatus('OK — responde');
      setTestResult(`✅ Servidor OK en ${ms} ms: ${JSON.stringify(h)}`);
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
    const alert = { id: Date.now(), symbol, currency, target, direction: alertDir, createdAt: new Date().toISOString(), triggered: false };
    setPriceAlerts((prev) => [alert, ...prev].slice(0, 20));
    unlock('primera_alerta');
    setPaperMsg(`Alerta creada: ${symbol} ${alertDir === 'above' ? 'por encima de' : 'por debajo de'} ${fmt(target, currency)}.`);
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
        <div><h1>₿ Cripto en Vivo</h1><p>Precios reales desde el servidor local · React + Node · v4 — Cartera virtual + gráfico en vivo</p></div>
        <div className="badge">{source ? `Fuente: ${source}` : 'Conectando…'} · {updatedAt ? new Date(updatedAt).toLocaleTimeString('es-US') : ''}</div>
      </header>

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

      {error && <div className="error">No se pudo cargar desde el servidor: {error}. Revisa que el servidor esté corriendo (npm run dev en la carpeta raíz).</div>}

      <section className="card status">
        <h2>Estado del servidor</h2>
        <div className="stats">
          <div><span>Servidor (localhost:3001)</span><b className={serverStatus.startsWith('OK') ? 'up' : serverStatus.startsWith('FALLO') ? 'down' : ''}>{serverStatus}</b></div>
          <div><span>Última actualización</span><b>{updatedAt ? new Date(updatedAt).toLocaleTimeString('es-US') : '— (nunca llegó un precio)'}</b></div>
          <div><span>Fuente del precio</span><b>{source || '—'}</b></div>
        </div>
        {(error || marketsError || candlesError) && (
          <p className="errtext">Último error exacto — precio: {error || 'ninguno'} · pestañas: {marketsError || 'ninguno'} · velas: {candlesError || 'ninguno'}</p>
        )}
        <div className="row">
          <button onClick={testServer}>Probar servidor</button>
          <span className="muted">Llama a /api/health y a /api/debug y muestra el resultado aquí.</span>
        </div>
        {testResult && <p className="errtext">{testResult}</p>}
        {debugInfo && <pre className="errtext">{debugInfo}</pre>}
      </section>

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

      <section className="card">
        <div className="row"><h2>Precio actual · {symbol}-{currency}</h2>
          <span className={flash === 'up' ? 'flash up' : flash === 'down' ? 'flash down' : 'flash'}>{change24 != null ? `${change24 >= 0 ? '▲' : '▼'} ${change24.toFixed(2)}% 24h` : 'Esperando datos…'}</span>
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
        <div ref={chartRef} className="chart" />
        <p className="muted">Actualización: precio cada 1 s, última vela se mueve con cada tick, velas completas cada 6 s, desde el servidor (Coinbase → Kraken → Binance US → CoinGecko).</p>
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
        </div>
        {alerts.length > 0 && <ul className="alerts">{alerts.map((a, i) => <li key={i}>🔔 {a}</li>)}</ul>}
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
      <section className="card">
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

      <footer>Fuente de datos: APIs públicas de Coinbase, Kraken, Binance US y CoinGecko, consultadas por el servidor. Precios en vivo, no inventados. El simulador y las alertas usan dinero virtual y son solo una prueba educativa.</footer>
    </div>
  );
}
