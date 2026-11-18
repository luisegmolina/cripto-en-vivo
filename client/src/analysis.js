// Análisis técnico de PRUEBA EDUCATIVA — no es recomendación de inversión.
// Reglas clásicas y públicas (RSI, MACD, EMA, Bollinger, patrones de velas).
// Ningún indicador predice el precio: solo resume lo que ya pasó en el gráfico.

export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}
// v15.2: RSI con el suavizado de Wilder (el estándar de TradingView, Coinbase, etc.).
// Antes era una media simple de las últimas 14 variaciones, que da otros números.
// Una sola pasada O(n): rsiSeries devuelve el RSI de cada vela y rsi() el último.
export function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  const toRsi = () => (avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss));
  out[period] = toRsi();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = toRsi();
  }
  return out;
}
export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const s = rsiSeries(closes, period);
  return s[s.length - 1];
}
// v15.2: MACD estándar (12, 26, 9). La señal es la EMA de 9 de la línea MACD
// (antes era la media de 9 valores) y las EMA se calculan una vez (antes se
// recalculaban desde cero en cada paso, O(n²)). Si aún no hay 9 valores de la
// línea MACD (menos de 34 velas) devuelve null: sin dato en vez de un histograma falso.
export function macd(closes) {
  if (closes.length < 34) return null;
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const lines = [];
  for (let i = 0; i < closes.length; i++) if (e12[i] != null && e26[i] != null) lines.push(e12[i] - e26[i]);
  const sig = emaSeries(lines, 9);
  const line = lines[lines.length - 1];
  const signal = sig[sig.length - 1];
  if (signal == null) return null;
  const prevLine = lines.length >= 2 ? lines[lines.length - 2] : line;
  const prevSig = sig.length >= 2 && sig[sig.length - 2] != null ? sig[sig.length - 2] : signal;
  const histogram = line - signal;
  const prevHistogram = prevLine - prevSig;
  return { line, signal, histogram, prevHistogram, rising: histogram > prevHistogram };
}
export function bollinger(closes, period = 20) {
  if (closes.length < period) return null;
  const s = closes.slice(-period);
  const mean = s.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  const last = closes[closes.length - 1];
  return { middle: mean, upper: mean + 2 * sd, lower: mean - 2 * sd, pctB: sd ? (last - (mean - 2 * sd)) / (4 * sd) : 0.5 };
}

// Patrones de velas sobre las últimas velas. Devuelve lista {name, dir, time, text}
export function detectPatterns(candles) {
  const out = [];
  if (candles.length < 3) return out;
  const c = candles[candles.length - 1], p = candles[candles.length - 2];
  const body = Math.abs(c.close - c.open), range = c.high - c.low || 1;
  const upper = c.high - Math.max(c.open, c.close), lower = Math.min(c.open, c.close) - c.low;
  const bullish = c.close > c.open, bearish = c.close < c.open;
  // Martillo: cuerpo pequeño, mecha inferior larga, tras caída
  if (body <= range * 0.35 && lower >= body * 2 && upper <= body) out.push({ name: 'Martillo', dir: 'up', time: c.time, text: 'Cuerpo pequeño con mecha larga abajo: los compradores defendieron el precio. Posible rebote, no seguro.' });
  // Estrella fugaz: cuerpo pequeño, mecha superior larga
  if (body <= range * 0.35 && upper >= body * 2 && lower <= body) out.push({ name: 'Estrella fugaz', dir: 'down', time: c.time, text: 'Cuerpo pequeño con mecha larga arriba: los vendedores frenaron la subida. Posible bajada, no seguro.' });
  // Envolvente
  if (p.close < p.open && bullish && c.open <= p.close && c.close >= p.open) out.push({ name: 'Envolvente alcista', dir: 'up', time: c.time, text: 'La vela verde cubre por completo a la roja anterior: cambio de fuerza hacia arriba.' });
  if (p.close > p.open && bearish && c.open >= p.close && c.close <= p.open) out.push({ name: 'Envolvente bajista', dir: 'down', time: c.time, text: 'La vela roja cubre por completo a la verde anterior: cambio de fuerza hacia abajo.' });
  // Doji: apertura casi igual al cierre
  if (body <= range * 0.1) out.push({ name: 'Doji', dir: 'neutral', time: c.time, text: 'Apertura y cierre casi iguales: indecisión entre compradores y vendedores.' });
  return out;
}

// Serie EMA completa (un valor por vela, null hasta tener suficientes
// datos) para dibujarla como línea en el gráfico.
export function emaSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

// Serie Bollinger completa (un {upper, middle, lower} por vela, null
// hasta tener 20 velas) para dibujar las bandas como líneas.
export function bollingerSeries(closes, period = 20) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  for (let i = period - 1; i < closes.length; i++) {
    const s = closes.slice(i - period + 1, i + 1);
    const mean = s.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    out[i] = { middle: mean, upper: mean + 2 * sd, lower: mean - 2 * sd };
  }
  return out;
}

// v15.5: analyze() calibrado para detectar con precisión tanto la tendencia
// de fondo (EMA 20/50) como el movimiento corto en tiempo real (EMA 9/20,
// impulso de las últimas 3 velas, presión de la vela actual y RSI sin el
// sesgo inverso en zona 30-70 que antes restaba puntos cuando el precio subía).
export function analyze(candles) {
  if (!candles || candles.length < 30) {
    return {
      score: 0, label: 'Sin señal clara', strength: 'Débil',
      detail: 'Faltan velas para calcular los indicadores.',
      rsi: null, macd: null, ema9: null, ema20: null, ema50: null,
      bollinger: null, patterns: [], momentumPct: 0, candleChangePct: 0,
    };
  }
  const closes = candles.map((c) => c.close);
  const lastPrice = closes[closes.length - 1];
  const lastCandle = candles[candles.length - 1];
  const r = rsi(closes), m = macd(closes);
  const e9 = ema(closes, 9), e20 = ema(closes, 20), e50 = ema(closes, 50);
  const b = bollinger(closes);
  const patterns = detectPatterns(candles);

  // Impulso corto (variación de las últimas 3 velas y de la vela en curso).
  const prev3 = closes[Math.max(0, closes.length - 4)];
  const momentumPct = prev3 > 0 ? ((lastPrice - prev3) / prev3) * 100 : 0;
  const candleChangePct = lastCandle.open > 0 ? ((lastCandle.close - lastCandle.open) / lastCandle.open) * 100 : 0;

  let score = 0;
  const parts = [];

  // 1. Tendencia de fondo (EMA 20 vs EMA 50; o precio vs EMA 20 si aún hay <50 velas)
  if (e20 != null && e50 != null) {
    const s = e20 > e50 ? 16 : -16;
    score += s;
    parts.push(`Tendencia EMA 20/50: ${s > 0 ? '+' : ''}${s}`);
  } else if (e20 != null) {
    const s = lastPrice >= e20 ? 12 : -12;
    score += s;
    parts.push(`Precio vs EMA 20: ${s > 0 ? '+' : ''}${s}`);
  }

  // 2. Tendencia corta reactiva (EMA 9 vs EMA 20 + posición del precio actual)
  if (e9 != null && e20 != null) {
    let s = e9 > e20 ? 10 : -10;
    if (lastPrice > e9 && e9 > e20) s += 5;
    else if (lastPrice < e9 && e9 < e20) s -= 5;
    score += s;
    parts.push(`Impulso corto EMA 9/20: ${s > 0 ? '+' : ''}${s}`);
  }

  // 3. MACD (12, 26, 9) + aceleración del histograma
  if (m) {
    let s = m.histogram > 0 ? 12 : -12;
    if (m.histogram > 0 && m.rising) s += 4;
    else if (m.histogram < 0 && !m.rising) s -= 4;
    score += s;
    parts.push(`MACD: ${s > 0 ? '+' : ''}${s}`);
  }

  // 4. RSI(14) de Wilder: extremos (<30 sobreventa, >70 sobrecompra) y
  // acompañamiento del impulso en zona 30-70 (v15.5: antes restaba cuando
  // el precio subía con fuerza entre 50 y 70, anulando señales claras).
  if (r != null) {
    let s = 0;
    if (r < 30) s = 15;
    else if (r > 70) s = -15;
    else if (r >= 54) s = Math.min(10, Math.round((r - 50) / 2));
    else if (r <= 46) s = Math.max(-10, Math.round((r - 50) / 2));
    score += s;
    parts.push(`RSI ${r.toFixed(1)}: ${s > 0 ? '+' : ''}${s}`);
  }

  // 5. Velocidad de las últimas 3 velas + vela actual
  const momScore = Math.abs(momentumPct) >= 0.08
    ? (momentumPct > 0 ? Math.min(12, Math.round(momentumPct * 40)) : Math.max(-12, Math.round(momentumPct * 40)))
    : (candleChangePct > 0.04 ? 5 : candleChangePct < -0.04 ? -5 : 0);
  if (momScore !== 0) {
    score += momScore;
    parts.push(`Movimiento 3v (${momentumPct >= 0 ? '+' : ''}${momentumPct.toFixed(2)}%): ${momScore > 0 ? '+' : ''}${momScore}`);
  }

  // 6. Bandas de Bollinger y patrones de velas
  if (b) {
    const s = b.pctB < 0.2 ? 6 : b.pctB > 0.8 ? -6 : 0;
    if (s !== 0) { score += s; parts.push(`Bollinger: ${s > 0 ? '+' : ''}${s}`); }
  }
  for (const p of patterns) {
    const s = p.dir === 'up' ? 12 : p.dir === 'down' ? -12 : 0;
    score += s;
    parts.push(`${p.name}: ${s > 0 ? '+' : ''}${s}`);
  }

  score = Math.max(-100, Math.min(100, score));
  const label = score >= 25 ? 'Posible subida' : score <= -25 ? 'Posible bajada' : 'Sin señal clara';
  const strength = Math.abs(score) >= 60 ? 'Fuerte' : Math.abs(score) >= 25 ? 'Moderada' : 'Débil';
  return {
    score, label, strength, detail: parts.join(' · '),
    rsi: r, macd: m, ema9: e9, ema20: e20, ema50: e50,
    bollinger: b, patterns, momentumPct, candleChangePct,
  };
}
