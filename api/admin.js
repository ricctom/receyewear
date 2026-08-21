// /api/admin — pedidos (solo el email admin).
// El pedido avanza de a un paso: nuevo -> pedido (a Martín) -> recibido -> despachado.
//   GET                                -> pedidos + costo + cotización
//   POST { id, etapa }                 -> mueve el pedido de paso
//   POST { id, recibir:{ lineas } }    -> confirma lo que llegó y genera la deuda con Martín
//   POST { id, pago:{...} }            -> registra un cobro
//   POST { id, resetPagos|borrar|nota|items }
//   POST { usd:{...} } / { costmap:{...} }
const { sql, ensureTables, splitNombre, norm, setSetting, usdRate, costTables, costoDe } = require('./_db');
const { getSession } = require('./_auth');

const ETAPAS = ['nuevo', 'pedido', 'recibido', 'despachado', 'cancelado'];
// Se sigue escribiendo el viejo "status" para que "Mis pedidos" del cliente
// siga mostrando algo con sentido.
const STATUS = { nuevo: 'nuevo', pedido: 'preparando', recibido: 'preparando',
                 despachado: 'enviado', cancelado: 'cancelado' };

// Agrupa los items del pedido por línea: es la única unidad que le importa a
// Tomás cuando confirma lo que llegó (los modelos no se revisan).
function porLinea(items) {
  const m = new Map();
  (items || []).forEach((it) => {
    const { linea } = splitNombre(it.name);
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    if (!m.has(linea)) m.set(linea, { linea, qty: 0 });
    m.get(linea).qty += qty;
  });
  return [...m.values()];
}

// Costo en dólares de una lista de líneas con sus cantidades.
function costoLineas(lineas, t) {
  let total = 0, ars = 0;
  const items = [];
  const sinCosto = [];
  lineas.forEach((l) => {
    const m = t.mapa.get(norm(l.linea));
    // De otro proveedor: no entra en la entrega de Martín.
    if (m && m.ignorar) { ars += Number(m.costo_ars || 0) * (m.factor || 1) * l.qty; return; }
    const precio = m ? t.precios.get(String(m.articulo).toUpperCase()) : undefined;
    if (!m || precio == null) { if (l.qty) sinCosto.push(l.linea); return; }
    const cantidad = l.qty * (m.factor || 1);
    if (!cantidad) return;
    total += precio * cantidad;
    const ya = items.find((x) => x.articulo === m.articulo);
    if (ya) ya.cantidad += cantidad;
    else items.push({ articulo: m.articulo, cantidad, precio_usd: precio });
  });
  return { usd: Math.round(total * 100) / 100, ars: Math.round(ars), items, sinCosto };
}

module.exports = async (req, res) => {
  const s = getSession(req);
  if (!s || !s.admin) return res.status(403).json({ error: 'Solo el administrador' });
  try {
    await ensureTables();

    if (req.method === 'GET') {
      const [rows, usd, tablas] = await Promise.all([
        sql`SELECT o.id, o.items, o.recibido, o.total, o.etapa, o.created_at, o.ship, o.faltante,
                   o.supplier_move_id,
                   o.usd_rate, o.nota, u.email, u.name,
                   COALESCE((SELECT sum(p.monto)::int FROM order_payments p WHERE p.order_id = o.id), 0) AS cobrado,
                   COALESCE((SELECT json_agg(json_build_object('id',p.id,'fecha',p.fecha,'monto',p.monto,'medio',p.medio,'nota',p.nota) ORDER BY p.id)
                             FROM order_payments p WHERE p.order_id = o.id), '[]'::json) AS pagos
            FROM orders o JOIN users u ON u.id = o.user_id
            ORDER BY o.id DESC LIMIT 500`,
        usdRate(),
        costTables(),
      ]);

      const sinMapear = new Set();
      const orders = rows.map((o) => {
        const c = costoDe(o.items, tablas);
        c.sinCosto.forEach((l) => sinMapear.add(l));
        const real = o.recibido ? costoLineas(o.recibido, tablas) : null;
        return { ...o, costo_usd: real ? real.usd : c.usd,
                 costo_ars: real ? real.ars : c.ars, sin_costo: c.sinCosto };
      });

      const precios = await sql`SELECT articulo FROM supplier_prices WHERE activo ORDER BY articulo`;
      const mapa = await sql`SELECT patron, articulo, factor, ignorar, costo_ars FROM cost_map ORDER BY patron`;
      return res.status(200).json({
        orders, usd,
        articulos: precios.map((p) => p.articulo),
        cost_map: mapa,
        sin_mapear: [...sinMapear],
      });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    const b = req.body || {};

    /* ----- Cotización ----- */
    if (b.usd) {
      if (b.usd.auto) await setSetting('usd_manual', null);
      else {
        const v = Number(b.usd.valor);
        if (!(v > 0)) return res.status(400).json({ error: 'Cotización inválida' });
        await setSetting('usd_manual', v);
      }
      return res.status(200).json({ ok: true, usd: await usdRate() });
    }

    /* ----- Qué artículo del proveedor es cada línea ----- */
    if (b.costmap) {
      const patron = norm(b.costmap.patron);
      const articulo = String(b.costmap.articulo || '').trim();
      const factor = Math.max(1, parseInt(b.costmap.factor, 10) || 1);
      if (!patron) return res.status(400).json({ error: 'Falta la línea' });
      // "otro" = no es de Martín (franelas, líquidos): no suma ni vuelve a avisar.
      if (articulo === 'otro') {
        const costo = Math.max(0, Number(b.costmap.costo_ars) || 0);
        await sql`INSERT INTO cost_map (patron, articulo, factor, ignorar, costo_ars)
          VALUES (${patron}, '', ${factor}, true, ${costo})
          ON CONFLICT (patron) DO UPDATE SET articulo = '', factor = ${factor}, ignorar = true, costo_ars = ${costo}`;
        return res.status(200).json({ ok: true });
      }
      if (!articulo) {
        await sql`DELETE FROM cost_map WHERE patron = ${patron}`;
        return res.status(200).json({ ok: true });
      }
      await sql`INSERT INTO cost_map (patron, articulo, factor, ignorar) VALUES (${patron}, ${articulo}, ${factor}, false)
        ON CONFLICT (patron) DO UPDATE SET articulo = EXCLUDED.articulo, factor = EXCLUDED.factor, ignorar = false`;
      return res.status(200).json({ ok: true });
    }

    const id = parseInt(b.id, 10);
    if (!id) return res.status(400).json({ error: 'Datos inválidos' });

    /* ----- Confirmar lo que llegó: acá se genera la deuda con Martín ----- */
    if (b.recibir) {
      const [ped] = await sql`SELECT id, items, etapa, supplier_move_id, ship FROM orders WHERE id = ${id}`;
      if (!ped) return res.status(404).json({ error: 'No existe el pedido' });
      if (ped.supplier_move_id) return res.status(400).json({ error: 'Este pedido ya se cargó en la cuenta de Martín' });

      // Si no mandó las líneas, es "llegó tal cual": se usa lo que pidió el cliente.
      const pedidas = porLinea(ped.items);
      const lineas = Array.isArray(b.recibir.lineas) && b.recibir.lineas.length
        ? pedidas.map((p) => {
            const dado = b.recibir.lineas.find((x) => String(x.linea) === p.linea);
            return { linea: p.linea, qty: dado ? Math.max(0, parseInt(dado.qty, 10) || 0) : p.qty };
          })
        : pedidas;

      const tablas = await costTables();
      const { usd, items, sinCosto } = costoLineas(lineas, tablas);

      const [prov] = await sql`SELECT id FROM suppliers ORDER BY id LIMIT 1`;
      let moveId = null;
      if (prov && usd > 0) {
        const sh = ped.ship || {};
        const [mov] = await sql`
          INSERT INTO supplier_moves (supplier_id, fecha, tipo, monto_usd, detalle, items, order_id)
          VALUES (${prov.id}, CURRENT_DATE, 'PEDIDO', ${usd},
                  ${'Pedido #' + id + (sh.razon_social ? ' · ' + sh.razon_social : '')},
                  ${JSON.stringify(items)}::jsonb, ${id})
          RETURNING id`;
        moveId = mov.id;
      }

      // Si el pedido ya estaba despachado (por ejemplo los viejos, que se
      // migraron salteando este paso), se le carga la deuda sin hacerlo volver atrás.
      const nuevaEtapa = ped.etapa === 'despachado' ? 'despachado' : 'recibido';
      await sql`UPDATE orders SET etapa = ${nuevaEtapa}, status = ${STATUS[nuevaEtapa]},
          recibido = ${JSON.stringify(lineas)}::jsonb, supplier_move_id = ${moveId}
        WHERE id = ${id}`;
      return res.status(200).json({ ok: true, monto_usd: usd, sin_costo: sinCosto });
    }

    /* ----- Mover de paso ----- */
    if (b.etapa) {
      if (!ETAPAS.includes(b.etapa)) return res.status(400).json({ error: 'Paso inválido' });
      const [ped] = await sql`SELECT etapa, supplier_move_id FROM orders WHERE id = ${id}`;
      if (!ped) return res.status(404).json({ error: 'No existe el pedido' });
      // Volver atrás de "recibido" deshace la deuda que se le había cargado a Martín.
      if (ped.supplier_move_id && (b.etapa === 'nuevo' || b.etapa === 'pedido')) {
        await sql`DELETE FROM supplier_moves WHERE id = ${ped.supplier_move_id}`;
        await sql`UPDATE orders SET supplier_move_id = NULL, recibido = NULL WHERE id = ${id}`;
      }
      await sql`UPDATE orders SET etapa = ${b.etapa}, status = ${STATUS[b.etapa]} WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    /* ----- Borrar ----- */
    if (b.borrar) {
      const [ped] = await sql`SELECT supplier_move_id FROM orders WHERE id = ${id}`;
      if (ped && ped.supplier_move_id) await sql`DELETE FROM supplier_moves WHERE id = ${ped.supplier_move_id}`;
      await sql`DELETE FROM order_payments WHERE order_id = ${id}`;
      await sql`DELETE FROM orders WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    /* ----- Cobros ----- */
    if (b.resetPagos) {
      await sql`DELETE FROM order_payments WHERE order_id = ${id}`;
      return res.status(200).json({ ok: true, cobrado: 0 });
    }
    if (b.pago) {
      const [row] = await sql`SELECT total,
          COALESCE((SELECT sum(monto)::int FROM order_payments WHERE order_id = ${id}), 0) AS cobrado
        FROM orders WHERE id = ${id}`;
      if (!row) return res.status(404).json({ error: 'No existe el pedido' });
      const monto = b.pago.resto ? (row.total - row.cobrado) : Math.round(Number(b.pago.monto) || 0);
      if (!monto) return res.status(400).json({ error: 'El monto tiene que ser distinto de cero' });
      if (monto > 0 && row.cobrado + monto > row.total) {
        return res.status(400).json({ error: 'Te pasás: faltan ' + (row.total - row.cobrado) });
      }
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.pago.fecha || '')) ? b.pago.fecha : null;
      await sql`INSERT INTO order_payments (order_id, fecha, monto, medio, nota)
        VALUES (${id}, COALESCE(${fecha}::date, CURRENT_DATE), ${monto},
                ${b.pago.medio ? String(b.pago.medio).slice(0, 40) : null},
                ${b.pago.nota ? String(b.pago.nota).slice(0, 200) : null})`;
      return res.status(200).json({ ok: true, cobrado: row.cobrado + monto, total: row.total });
    }

    /* ----- Nota interna ----- */
    if (b.nota !== undefined && !b.items) {
      await sql`UPDATE orders SET nota = ${b.nota ? String(b.nota).slice(0, 500) : null} WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    /* ----- Editar los items ----- */
    if (Array.isArray(b.items)) {
      if (!b.items.length) return res.status(400).json({ error: 'El pedido no puede quedar vacío' });
      const clean = b.items.map((it) => ({
        sku: String(it.sku || ''), name: String(it.name || ''),
        color: it.color ? String(it.color) : null,
        qty: Math.max(1, parseInt(it.qty, 10) || 1),
        price: Number(it.price) || 0,
      }));
      if (clean.some((it) => !it.name)) return res.status(400).json({ error: 'Hay un item sin nombre' });
      const total = clean.reduce((a, it) => a + it.price * it.qty, 0);
      await sql`UPDATE orders SET items = ${JSON.stringify(clean)}::jsonb, total = ${total} WHERE id = ${id}`;
      return res.status(200).json({ ok: true, total });
    }

    res.status(400).json({ error: 'Datos inválidos' });
  } catch (e) {
    res.status(500).json({ error: 'server', detail: String((e && e.message) || e) });
  }
};

module.exports.porLinea = porLinea;
module.exports.costoLineas = costoLineas;
