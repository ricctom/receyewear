// /api/admin — pedidos (solo el email admin).
// El pedido avanza de a un paso: nuevo -> pedido (a Martín) -> recibido -> despachado.
//   GET                                -> pedidos + costo + cotización
//   POST { id, etapa }                 -> mueve el pedido de paso
//   POST { id, recibir:{ lineas } }    -> confirma lo que llegó y genera la deuda con Martín
//   POST { id, pago:{...} }            -> registra un cobro
//   POST { id, resetPagos|borrar|nota|items }
//   POST { usd:{...} } / { costmap:{...} }
const { sql, ensureTables, splitNombre, norm, setSetting, usdRate,
        costTables, costoDe, costoLineasDe } = require('./_db');
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

      const sinMapear = new Map();
      const orders = rows.map((o) => {
        // Si ya confirmó lo que llegó, el costo real es el de lo recibido.
        const c = o.recibido ? costoLineasDe(o.recibido, tablas) : costoDe(o.items, tablas);
        costoDe(o.items, tablas).sinCosto.forEach((x) => sinMapear.set(x.linea, x));
        return { ...o, costo: c.detalle, sin_costo: c.sinCosto };
      });

      const [precios, mapa, provs] = await Promise.all([
        sql`SELECT supplier_id, articulo, precio FROM supplier_prices WHERE activo ORDER BY articulo`,
        sql`SELECT patron, articulo, factor, supplier_id FROM cost_map ORDER BY patron`,
        sql`SELECT id, nombre, moneda FROM suppliers ORDER BY id`,
      ]);
      return res.status(200).json({
        orders, usd, proveedores: provs,
        articulos: precios,
        cost_map: mapa,
        sin_mapear: [...sinMapear.values()],
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

    /* ----- De qué proveedor y qué artículo es cada línea ----- */
    if (b.costmap) {
      const patron = norm(b.costmap.patron);
      const articulo = String(b.costmap.articulo || '').trim();
      const proveedor = parseInt(b.costmap.supplier_id, 10) || null;
      const factor = Math.max(1, parseInt(b.costmap.factor, 10) || 1);
      if (!patron) return res.status(400).json({ error: 'Falta la línea' });
      if (!articulo || !proveedor) {
        await sql`DELETE FROM cost_map WHERE patron = ${patron}`;
        return res.status(200).json({ ok: true });
      }
      // Si el artículo todavía no está en la lista de ese proveedor, se crea
      // con el precio que vino (o en cero, para cargarlo después).
      const precio = Number(b.costmap.precio);
      if (isFinite(precio) && precio > 0) {
        await sql`INSERT INTO supplier_prices (supplier_id, articulo, precio_usd, precio)
          VALUES (${proveedor}, ${articulo}, ${precio}, ${precio})
          ON CONFLICT (supplier_id, upper(articulo))
          DO UPDATE SET precio = ${precio}, precio_usd = ${precio}, activo = true`;
      }
      await sql`INSERT INTO cost_map (patron, articulo, factor, supplier_id, ignorar)
        VALUES (${patron}, ${articulo}, ${factor}, ${proveedor}, false)
        ON CONFLICT (patron) DO UPDATE SET articulo = EXCLUDED.articulo,
          factor = EXCLUDED.factor, supplier_id = EXCLUDED.supplier_id, ignorar = false`;
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
      const { detalle, sinCosto } = costoLineasDe(lineas, tablas);

      // Un movimiento por proveedor: lo de Martín va a su cuenta en dólares,
      // lo de Fernando y Juan a la de ellos en pesos.
      const sh = ped.ship || {};
      const glosa = 'Pedido #' + id + (sh.razon_social ? ' · ' + sh.razon_social : '');
      let moveId = null;
      const cargado = [];
      for (const d of detalle) {
        if (!(d.monto > 0)) continue;
        const [mov] = await sql`
          INSERT INTO supplier_moves (supplier_id, fecha, tipo, monto_usd, monto, detalle, items, order_id)
          VALUES (${d.supplier_id}, CURRENT_DATE, 'PEDIDO', ${d.monto}, ${d.monto}, ${glosa},
                  ${JSON.stringify(d.items)}::jsonb, ${id})
          RETURNING id`;
        if (!moveId) moveId = mov.id;
        cargado.push({ nombre: d.nombre, moneda: d.moneda, monto: d.monto });
      }

      // Si el pedido ya estaba despachado (por ejemplo los viejos, que se
      // migraron salteando este paso), se le carga la deuda sin hacerlo volver atrás.
      const nuevaEtapa = ped.etapa === 'despachado' ? 'despachado' : 'recibido';
      await sql`UPDATE orders SET etapa = ${nuevaEtapa}, status = ${STATUS[nuevaEtapa]},
          recibido = ${JSON.stringify(lineas)}::jsonb, supplier_move_id = ${moveId}
        WHERE id = ${id}`;
      return res.status(200).json({ ok: true, cargado, sin_costo: sinCosto });
    }

    /* ----- Mover de paso ----- */
    if (b.etapa) {
      if (!ETAPAS.includes(b.etapa)) return res.status(400).json({ error: 'Paso inválido' });
      const [ped] = await sql`SELECT etapa, supplier_move_id FROM orders WHERE id = ${id}`;
      if (!ped) return res.status(404).json({ error: 'No existe el pedido' });
      // Volver atrás de "recibido" deshace la deuda que se le había cargado a Martín.
      if (ped.supplier_move_id && (b.etapa === 'nuevo' || b.etapa === 'pedido')) {
        await sql`DELETE FROM supplier_moves WHERE order_id = ${id}`;
        await sql`UPDATE orders SET supplier_move_id = NULL, recibido = NULL WHERE id = ${id}`;
      }
      await sql`UPDATE orders SET etapa = ${b.etapa}, status = ${STATUS[b.etapa]} WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    /* ----- Borrar ----- */
    if (b.borrar) {
      await sql`DELETE FROM supplier_moves WHERE order_id = ${id}`;
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
