// Facturación en ARCA. No es una función propia (el plan de Vercel permite 12):
// la atiende /api/admin cuando viene ?facturas=1.
// Se factura lo que se cobró en blanco: se eligen cobros de un pedido y se
// emite UNA Factura C por la suma. Cada cobro queda atado a su factura
// (order_payments.factura_id), así nada se factura dos veces.
//   GET                                   -> config, datos del emisor, resumen por mes, facturas
//   POST { emisor:{...} }                 -> datos que van impresos en la factura
//   POST { probar:true }                  -> prueba la conexión con ARCA (no emite nada)
//   POST { facturar:{ order_id, pagos:[ids], cond_iva, doc, nombre } }  ⚠ emite
//   POST { revisar: facturaId }           -> pregunta a ARCA qué pasó con una pendiente
//   POST { anular: facturaId }            ⚠ emite la nota de crédito C
const { sql, ensureTables, setSetting } = require('./_db');
const { getSession } = require('./_auth');
const arca = require('./_arca');

const FACTURA_C = 11, NOTA_CREDITO_C = 13;
// ARCA acepta factura de productos con fecha hasta 5 días antes de hoy (y no
// anterior a la última emitida de ese tipo en el punto de venta).
const DIAS_ATRAS = 5;
// "AAAA-MM-DD" de hoy en Argentina, corrido `dias` días.
const diaAR = (dias = 0) => new Date(Date.now() - 3 * 3600000 + dias * 86400000).toISOString().slice(0, 10);
// "2026-09-27" -> Date al mediodía de Argentina, para que ningún huso lo corra de día.
const mediodia = (f) => new Date(String(f).slice(0, 10) + 'T15:00:00Z');
const isoDe = (f) => (f instanceof Date ? f.toISOString() : String(f)).slice(0, 10);

async function emisor() {
  const [row] = await sql`SELECT value FROM settings WHERE key = 'factura_emisor'`;
  try { return (row && JSON.parse(row.value)) || {}; } catch { return {}; }
}

// Manda el comprobante a ARCA y deja la fila de `facturas` como quedó.
// Si se corta en el medio, pregunta antes de dar nada por perdido.
async function emitir(f, asociado) {
  let numero;
  try {
    numero = (await arca.ultimoAutorizado(f.tipo)) + 1;
  } catch (e) {
    // Todavía no se mandó nada: se libera y listo.
    await rechazar(f.id, e.message);
    return { ok: false, error: 'No pude hablar con ARCA: ' + e.message };
  }
  await sql`UPDATE facturas SET numero = ${numero} WHERE id = ${f.id}`;
  const pedido = { cbteTipo: f.tipo, numero, fecha: mediodia(isoDe(f.fecha)), docTipo: f.doc_tipo, docNro: f.doc_nro,
                   condIva: f.cond_iva, total: f.total, asociado };
  let r;
  try {
    r = await arca.solicitarCAE(pedido);
  } catch (e) {
    return revisar(f.id, numero, e.message);
  }
  if (r.aprobada) {
    const obs = r.observaciones.length ? arca.enTexto(r.observaciones) : null;
    await sql`UPDATE facturas SET estado = 'ok', cae = ${r.cae}, cae_vence = ${r.caeVence}, errores = ${obs}
      WHERE id = ${f.id}`;
    return { ok: true, numero, cae: r.cae };
  }
  const motivo = arca.enTexto(r.errores.concat(r.observaciones)) || 'ARCA la rechazó sin decir por qué';
  await rechazar(f.id, motivo);
  return { ok: false, error: 'ARCA la rechazó: ' + motivo };
}

async function rechazar(fid, motivo) {
  await sql`UPDATE facturas SET estado = 'rechazada', errores = ${motivo} WHERE id = ${fid}`;
  await sql`UPDATE order_payments SET factura_id = NULL WHERE factura_id = ${fid}`;
}

// ¿La tiene ARCA? Si sí, queda emitida; si no, se libera; si no contesta, sigue pendiente.
async function revisar(fid, numero, porQue) {
  const [f] = await sql`SELECT * FROM facturas WHERE id = ${fid}`;
  const n = numero || f.numero;
  try {
    const c = n ? await arca.consultarComprobante(f.tipo, n) : null;
    if (c && c.cae && Math.round(c.total) === f.total) {
      await sql`UPDATE facturas SET estado = 'ok', numero = ${n}, cae = ${c.cae}, cae_vence = ${c.caeVence}
        WHERE id = ${fid}`;
      if (f.anula_id) await sql`UPDATE order_payments SET factura_id = NULL WHERE factura_id = ${f.anula_id}`;
      return { ok: true, numero: n, cae: c.cae };
    }
    await rechazar(fid, porQue || 'ARCA no la tiene');
    return { ok: false, error: 'No se emitió' + (porQue ? ': ' + porQue : '') + '. Los cobros quedaron libres para volver a facturar.' };
  } catch (e) {
    return { ok: false, pendiente: true,
      error: 'No sé si ARCA la emitió (' + (porQue || e.message) + '). Quedó pendiente: tocá "Revisar" en un rato.' };
  }
}

module.exports = async (req, res) => {
  const s = getSession(req);
  if (!s || !s.admin) return res.status(403).json({ error: 'Solo el administrador' });
  try {
    await ensureTables();

    if (req.method === 'GET') {
      // Por mes: lo que entró en blanco, en negro (pesos), en dólares y lo facturado.
      const [meses, facturas, datos] = await Promise.all([
        sql`WITH c AS (
              SELECT to_char(fecha, 'YYYY-MM') AS mes,
                     sum(CASE WHEN en_blanco THEN monto ELSE 0 END)::bigint AS blanco,
                     sum(CASE WHEN NOT COALESCE(en_blanco, false) AND usd IS NULL THEN monto ELSE 0 END)::bigint AS negro,
                     sum(COALESCE(usd, 0))::numeric AS usd,
                     sum(CASE WHEN usd IS NOT NULL THEN monto ELSE 0 END)::bigint AS usd_pesos,
                     sum(CASE WHEN en_blanco AND factura_id IS NULL AND NOT COALESCE(facturado_aparte, false) THEN monto ELSE 0 END)::bigint AS sin_facturar
                FROM order_payments GROUP BY 1),
            f AS (
              SELECT to_char(fecha, 'YYYY-MM') AS mes,
                     sum(CASE WHEN tipo = 13 THEN -total ELSE total END)::bigint AS facturado
                FROM facturas WHERE estado = 'ok' AND NOT homologacion GROUP BY 1)
            SELECT COALESCE(c.mes, f.mes) AS mes, COALESCE(blanco, 0) AS blanco, COALESCE(negro, 0) AS negro,
                   COALESCE(usd, 0) AS usd, COALESCE(usd_pesos, 0) AS usd_pesos,
                   COALESCE(sin_facturar, 0) AS sin_facturar, COALESCE(facturado, 0) AS facturado
              FROM c FULL JOIN f ON f.mes = c.mes
             ORDER BY 1 DESC LIMIT 24`,
        sql`SELECT f.*, COALESCE(NULLIF(u.razon_social, ''), u.name) AS cliente
              FROM facturas f LEFT JOIN orders o ON o.id = f.order_id LEFT JOIN users u ON u.id = o.user_id
             ORDER BY f.id DESC LIMIT 300`,
        emisor(),
      ]);
      return res.status(200).json({
        fechas: { desde: diaAR(-DIAS_ATRAS), hasta: diaAR() },
        config: { falta: arca.faltaConfigurar(), homologacion: arca.HOMOLOGACION,
                  cuit: arca.cuit(), pto_vta: arca.puntoVenta() },
        emisor: datos, meses, facturas,
        qr: Object.fromEntries(facturas.filter((f) => f.cae).map((f) => [f.id, arca.urlQR(f)])),
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    const b = req.body || {};

    if (b.emisor) {
      const campos = ['razon_social', 'domicilio', 'inicio', 'iibb'];
      const d = Object.fromEntries(campos.map((k) => [k, String(b.emisor[k] || '').trim().slice(0, 160)]));
      await setSetting('factura_emisor', JSON.stringify(d));
      return res.status(200).json({ ok: true, emisor: d });
    }

    const falta = arca.faltaConfigurar();
    if (falta.length) {
      return res.status(400).json({ error: 'Falta cargar en Vercel: ' + falta.join(', ') + '. Mirá FACTURACION.md.' });
    }

    if (b.probar) {
      const vivo = await arca.servidorVivo();
      const ultimo = await arca.ultimoAutorizado(FACTURA_C);
      return res.status(200).json({ ok: true, vivo, ultimo,
        msg: 'ARCA contesta. Última Factura C del punto de venta ' + arca.puntoVenta() + ': ' + (ultimo || 'ninguna') +
             (arca.HOMOLOGACION ? ' (entorno de PRUEBA)' : '') });
    }

    if (b.facturar) {
      const orderId = parseInt(b.facturar.order_id, 10);
      const ids = (Array.isArray(b.facturar.pagos) ? b.facturar.pagos : []).map((x) => parseInt(x, 10)).filter(Boolean);
      if (!orderId || !ids.length) return res.status(400).json({ error: 'Elegí qué cobros facturar' });
      const condIva = parseInt(b.facturar.cond_iva, 10);
      if (!arca.IVA_RECEPTOR[condIva]) return res.status(400).json({ error: 'Falta la condición de IVA del cliente' });
      const doc = arca.documentoDe(b.facturar.doc);
      if (condIva !== 5 && doc.docTipo !== arca.DOC.CUIT) {
        return res.status(400).json({ error: 'A un ' + arca.IVA_RECEPTOR[condIva].toLowerCase() + ' hay que facturarle con CUIT (11 números)' });
      }

      // Fecha de la factura: hoy, o hasta DIAS_ATRAS para atrás.
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.facturar.fecha || '')) ? b.facturar.fecha : diaAR();
      if (fecha > diaAR() || fecha < diaAR(-DIAS_ATRAS)) {
        return res.status(400).json({ error: 'ARCA acepta fechas entre el ' + diaAR(-DIAS_ATRAS).split('-').reverse().join('/') +
          ' y hoy' });
      }
      const [ultima] = await sql`SELECT max(fecha) AS fecha FROM facturas
        WHERE tipo = ${FACTURA_C} AND pto_vta = ${arca.puntoVenta()} AND estado <> 'rechazada'
          AND homologacion = ${arca.HOMOLOGACION}`;
      if (ultima && ultima.fecha && fecha < isoDe(ultima.fecha)) {
        return res.status(400).json({ error: 'Ya hay una factura del ' + isoDe(ultima.fecha).split('-').reverse().join('/') +
          ': ARCA no deja hacer una con fecha anterior. Usá esa fecha o una posterior.' });
      }

      const pagos = await sql`SELECT id, monto, factura_id, facturado_aparte FROM order_payments
        WHERE order_id = ${orderId} AND id = ANY(${ids}::int[])`;
      if (pagos.length !== ids.length) return res.status(400).json({ error: 'Algún cobro no es de este pedido' });
      if (pagos.some((p) => p.factura_id || p.facturado_aparte)) return res.status(400).json({ error: 'Algún cobro ya está facturado' });
      const total = pagos.reduce((a, p) => a + Number(p.monto), 0);
      if (!(total > 0)) return res.status(400).json({ error: 'El total tiene que ser mayor a cero' });

      const [f] = await sql`INSERT INTO facturas (order_id, tipo, pto_vta, fecha, total, doc_tipo, doc_nro, nombre, cond_iva, homologacion)
        VALUES (${orderId}, ${FACTURA_C}, ${arca.puntoVenta()}, ${fecha}, ${total}, ${doc.docTipo}, ${doc.docNro},
                ${String(b.facturar.nombre || '').trim().slice(0, 120) || null}, ${condIva}, ${arca.HOMOLOGACION})
        RETURNING *`;
      // Se atan los cobros ANTES de mandarla: si llega otro clic, ya no los encuentra libres.
      const atados = await sql`UPDATE order_payments SET factura_id = ${f.id}
        WHERE id = ANY(${ids}::int[]) AND factura_id IS NULL RETURNING id`;
      if (atados.length !== ids.length) {
        await rechazar(f.id, 'Se facturó dos veces a la vez: se canceló esta');
        return res.status(409).json({ error: 'Esos cobros se estaban facturando en otra pestaña' });
      }
      // Para la próxima: se recuerda la condición de IVA del cliente.
      await sql`UPDATE users SET cond_iva = ${condIva}
        WHERE id = (SELECT user_id FROM orders WHERE id = ${orderId})`;

      const r = await emitir(f);
      return res.status(r.ok ? 200 : 400).json(r);
    }

    if (b.revisar) {
      const [f] = await sql`SELECT id, estado FROM facturas WHERE id = ${parseInt(b.revisar, 10)}`;
      if (!f) return res.status(404).json({ error: 'No existe esa factura' });
      if (f.estado !== 'pendiente') return res.status(200).json({ ok: true });
      const r = await revisar(f.id, null, null);
      return res.status(r.ok ? 200 : 400).json(r);
    }

    if (b.anular) {
      const [f] = await sql`SELECT * FROM facturas WHERE id = ${parseInt(b.anular, 10)}`;
      if (!f || f.tipo !== FACTURA_C || f.estado !== 'ok') return res.status(400).json({ error: 'Solo se anula una factura emitida' });
      if (f.homologacion !== arca.HOMOLOGACION) return res.status(400).json({ error: 'Esa factura es de otro entorno (prueba/real)' });
      const [ya] = await sql`SELECT id FROM facturas WHERE anula_id = ${f.id} AND estado <> 'rechazada'`;
      if (ya) return res.status(400).json({ error: 'Esa factura ya tiene su nota de crédito' });

      const [nc] = await sql`INSERT INTO facturas (order_id, tipo, pto_vta, total, doc_tipo, doc_nro, nombre, cond_iva, anula_id, homologacion)
        VALUES (${f.order_id}, ${NOTA_CREDITO_C}, ${f.pto_vta}, ${f.total}, ${f.doc_tipo}, ${f.doc_nro}, ${f.nombre},
                ${f.cond_iva}, ${f.id}, ${arca.HOMOLOGACION})
        RETURNING *`;
      const r = await emitir(nc, { tipo: FACTURA_C, numero: f.numero,
        fecha: new Date(f.fecha || Date.now()).toISOString().slice(0, 10) });
      // Anulada la factura, sus cobros vuelven a quedar sin facturar.
      if (r.ok) await sql`UPDATE order_payments SET factura_id = NULL WHERE factura_id = ${f.id}`;
      return res.status(r.ok ? 200 : 400).json(r);
    }

    return res.status(400).json({ error: 'Acción inválida' });
  } catch (e) {
    console.error('facturas', e);
    return res.status(500).json({ error: e instanceof arca.ArcaError ? e.message : 'Error: ' + e.message });
  }
};
