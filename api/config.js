// Expone al front lo que no es secreto: el Client ID de Google y, si hay una
// campaña de cupones corriendo, sus condiciones (para poder mostrar el cartel).
// Además:
//   ?js=1        -> un script chiquito con el factor del dólar para los precios
//                   de la web (lo carga index.html antes de la lista de productos)
//   ?cron=dolar  -> la lectura diaria del MEP de las 11 (vercel.json → crons)
const { PROMO, promoActiva } = require('./_promo');
const { factorWeb, chequeoDiario } = require('./_dolar');

module.exports = async (req, res) => {
  const q = req.query || {};
  if (q.js) {
    let f = { factor: 1 };
    try { f = await factorWeb(); } catch { /* sin base: precios tal cual */ }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    // Queda en la CDN 5 minutos: casi nunca hace esperar a la página.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400');
    return res.status(200).send('window.REC_DOLAR=' + JSON.stringify(f) + ';');
  }
  if (q.cron === 'dolar') {
    // Con CRON_SECRET cargado en Vercel, solo lo puede disparar el cron.
    const secreto = process.env.CRON_SECRET;
    if (secreto && req.headers.authorization !== 'Bearer ' + secreto) return res.status(401).json({ error: 'no' });
    res.setHeader('Cache-Control', 'no-store');
    try { return res.status(200).json(await chequeoDiario()); }
    catch (e) { return res.status(500).json({ error: String((e && e.message) || e) }); }
  }
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.status(200).json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    promo: promoActiva()
      ? { monto: PROMO.monto, minimo: PROMO.minimo, vence: PROMO.venceUso }
      : null,
  });
};
