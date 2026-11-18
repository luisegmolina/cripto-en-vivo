// ChartSection.jsx — v15: §5 GRÁFICA — velas BTC 15m, al final (v15.3:
// extraída de App.jsx a su propio componente, sin cambiar la vista).
// Solo el contenedor: el gráfico (lightweight-charts) lo crea y lo
// alimenta App.jsx con chartRef. Sin botones de intervalo (siempre
// 15m), sin toggles de indicadores, sin pantalla completa ni panel RSI.
// Solo las velas y "Cargando velas…" si aún no llegaron.
export default function ChartSection({ chartRef, candles, candlesError }) {
  return (
    <section className="card">
      <div className="row"><h2>5 · Gráfica · BTC 15m</h2></div>
      <div ref={chartRef} className="chart" />
      {candles.length === 0 && (
        <p className="muted">{candlesError ? `Sin velas: ${candlesError}` : 'Cargando velas…'}</p>
      )}
    </section>
  );
}
