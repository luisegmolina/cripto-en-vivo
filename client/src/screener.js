// Screener / Oportunidades del día — PRUEBA EDUCATIVA.
// Filtra las 10 criptos por RSI, cambio 24h, volumen y puntuación de
// señal, y las ordena por una puntuación propia. Cada oportunidad lleva
// una explicación en una frase. NO es recomendación de inversión: solo
// resume lo que ya pasó en los datos.
//
// v9: SOLO es "oportunidad" una señal CLARA (|score| >= 25): de compra
// (score >= 25) o de venta (score <= -25). Las débiles (|score| < 25)
// van en `rest` como "sin oportunidad clara" y NUNCA se numeran como
// oportunidad #2. Antes, una señal débil de -19 (XRP) aparecía como #2.
// Devuelve { opportunities, rest } en vez de una sola lista mezclada.
export function screenOpportunities(markets, analyses) {
  if (!markets || !markets.length) return { opportunities: [], rest: [] };
  const vols = markets.map((m) => m.volume24h || 0).filter((v) => v > 0);
  const medVol = vols.length ? vols.slice().sort((a, b) => a - b)[Math.floor(vols.length / 2)] : 0;
  const rows = markets.map((m) => {
    const a = (analyses && analyses[m.symbol]) || {};
    const rsi = a.rsi != null ? a.rsi : null;
    const score = a.score != null ? a.score : 0;
    const chg = m.change24h ?? 0;
    let pts = 0;
    const reasons = [];
    if (rsi != null) {
      if (rsi < 30) { pts += 30; reasons.push(`RSI en ${rsi.toFixed(0)} (sobreventa)`); }
      else if (rsi > 70) { pts += 10; reasons.push(`RSI en ${rsi.toFixed(0)} (sobrecompra, cuidado)`); }
      else if (rsi >= 45 && rsi <= 55) { pts += 10; reasons.push(`RSI neutro en ${rsi.toFixed(0)}`); }
      else { pts += 15; reasons.push(`RSI en ${rsi.toFixed(0)}`); }
    }
    if (chg >= 3) { pts += 25; reasons.push(`sube +${chg.toFixed(2)}% en 24 h`); }
    else if (chg >= 1) { pts += 15; reasons.push(`sube +${chg.toFixed(2)}% en 24 h`); }
    else if (chg <= -3) { pts += 15; reasons.push(`cae ${chg.toFixed(2)}% en 24 h (posible rebote, o sigue bajando)`); }
    else if (chg < 0) { pts += 5; reasons.push(`baja ${chg.toFixed(2)}% en 24 h`); }
    else { pts += 5; reasons.push('casi plana en 24 h'); }
    if (score >= 25) { pts += 25; reasons.push(`señal clara de posible subida (+${score})`); }
    else if (score <= -25) { pts += 25; reasons.push(`señal clara de posible bajada (${score})`); }
    else if (score !== 0) { pts += 10; reasons.push(`señal débil (${score})`); }
    if (medVol && (m.volume24h || 0) >= medVol) { pts += 10; reasons.push('volumen alto hoy'); }
    const reason = reasons.length ? reasons.join(' · ') + '.' : 'Sin datos suficientes para explicarla.';
    return {
      symbol: m.symbol, name: m.name, price: m.price, change24h: chg,
      volume24h: m.volume24h, rsi, score: a.score != null ? a.score : null,
      label: a.label || 'Sin señal clara', points: pts, reason,
      // Oportunidad solo si la señal es clara en algún sentido.
      opportunity: score >= 25 ? 'buy' : score <= -25 ? 'sell' : null,
    };
  });
  const byStrength = (x, y) => Math.abs(y.score || 0) - Math.abs(x.score || 0) || y.points - x.points;
  return {
    opportunities: rows.filter((r) => r.opportunity).sort(byStrength),
    rest: rows.filter((r) => !r.opportunity).sort((x, y) => y.points - x.points),
  };
}
