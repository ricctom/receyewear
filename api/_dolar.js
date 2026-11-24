// ============================================================================
//  PRECIOS DE LA WEB SEGÚN EL DÓLAR MEP (banda del 5%)
//
//  Los precios que están escritos en index.html son los "de base": están
//  armados con el dólar MEP de BASE. La web los muestra multiplicados por
//  publicado / BASE, redondeados (ver precios.js).
//
//  Todos los días a las 11 de Argentina (cron de vercel.json) se lee el MEP y
//  se guarda. Se compara el promedio de los últimos DIAS días contra el dólar
//  publicado: si se va más de BANDA para arriba o para abajo, queda una
//  propuesta y le llega un mail a Tomás. Los precios NO cambian solos: se
//  aplica con el botón del panel (Pedidos → Dólar web).
//
//  Si algún día se reescriben a mano los precios de index.html, hay que poner
//  en BASE el dólar con el que se armaron y volver a "publicar" ese mismo valor.
// ============================================================================
const BASE = 1700;    // MEP con el que están armados los precios de index.html (24/11/2026)
const BANDA = 0.05;   // ±5% respecto del dólar al que están publicados los precios
const DIAS = 3;       // promedio de las últimas lecturas diarias, para no saltar por un día

const r2 = (n) => Math.round(Number(n) * 100) / 100;

// Día de hoy en Argentina, como YYYY-MM-DD.
function hoyAR() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

async function leerMep() {
  const r = await fetch('https://dolarapi.com/v1/dolares/bolsa');
  const d = await r.json();
  const v = Number(d && d.venta);
  if (!(v > 0)) throw new Error('No se pudo leer el dólar MEP');
  return r2(v);
}

// Solo lo que necesita la tienda para mostrar los precios (rápido, sin tablas nuevas).
async function factorWeb() {
  const { getSettings } = require('./_db');
  const s = await getSettings();
  const base = Number(s.dolar_web_base) || BASE;
  const publicado = Number(s.dolar_web_publicado) || base;
  return { base, publicado, factor: publicado / base };
}

// Todo lo que muestra el panel.
async function estado() {
  const { sql, getSettings } = require('./_db');
  const s = await getSettings();
  const base = Number(s.dolar_web_base) || BASE;
  const publicado = Number(s.dolar_web_publicado) || base;
  const lecturas = (await sql`SELECT fecha, valor FROM dolar_mep ORDER BY fecha DESC LIMIT 10`)
    .map((x) => ({ fecha: String(x.fecha).slice(0, 10), valor: Number(x.valor) }));
  const ult = lecturas.slice(0, DIAS).map((x) => x.valor);
  const promedio = ult.length ? r2(ult.reduce((a, b) => a + b, 0) / ult.length) : null;
  const movimiento = promedio ? promedio / publicado - 1 : 0;
  return {
    base, publicado, factor: publicado / base, banda: BANDA, dias: DIAS,
    piso: r2(publicado * (1 - BANDA)), techo: r2(publicado * (1 + BANDA)),
    lecturas, promedio, movimiento, fuera: Math.abs(movimiento) > BANDA,
    propuesto: Number(s.dolar_web_propuesto) || null,
    publicado_at: s.dolar_web_publicado_at || null,
  };
}

// La lectura de las 11. Una por día: si ya está la de hoy, no hace nada.
async function chequeoDiario({ forzar } = {}) {
  const { sql, ensureTables, setSetting } = require('./_db');
  await ensureTables();
  const hoy = hoyAR();
  const [ya] = await sql`SELECT valor FROM dolar_mep WHERE fecha = ${hoy}`;
  if (ya && !forzar) return { ok: true, ya: true, mep: Number(ya.valor) };

  const mep = await leerMep();
  await sql`INSERT INTO dolar_mep (fecha, valor) VALUES (${hoy}, ${mep})
    ON CONFLICT (fecha) DO UPDATE SET valor = EXCLUDED.valor, created_at = now()`;

  const e = await estado();
  if (!e.fuera) {
    await setSetting('dolar_web_propuesto', null);
    return { ok: true, mep, promedio: e.promedio, fuera: false };
  }
  const nuevo = !e.propuesto;
  await setSetting('dolar_web_propuesto', e.promedio);
  if (nuevo) await avisar(e);
  return { ok: true, mep, promedio: e.promedio, fuera: true, avisado: nuevo };
}

async function avisar(e) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const { sendEmail } = require('./_notify');
  const admin = process.env.ADMIN_EMAIL || 'ricciarditomas@gmail.com';
  const pct = (e.movimiento * 100).toFixed(1).replace('.', ',');
  const sube = e.movimiento > 0;
  const n = (x) => '$' + Number(x).toLocaleString('es-AR', { maximumFractionDigits: 2 });
  const asunto = `Dólar MEP ${sube ? 'arriba' : 'abajo'} de la banda: ${sube ? '+' : ''}${pct}%`;
  const texto = `El MEP promedio de los últimos ${e.dias} días está en ${n(e.promedio)}.\n`
    + `Los precios de la web están armados a ${n(e.publicado)} (banda: ${n(e.piso)} a ${n(e.techo)}).\n\n`
    + `Si lo aplicás, los precios ${sube ? 'suben' : 'bajan'} alrededor de ${pct.replace('-', '')}%, redondeados.\n`
    + `Se aplica desde el panel: Pedidos → botón "Dólar web". Si no hacés nada, quedan como están.`;
  await sendEmail(key, admin, asunto, texto, '<p>' + texto.replace(/\n/g, '<br>') + '</p>');
}

module.exports = { BASE, BANDA, DIAS, hoyAR, leerMep, factorWeb, estado, chequeoDiario };
