// /api/proveedor — cuenta corriente, consignación y lista de precios de Martín.
// El admin ve y carga todo. El proveedor, si su email está cargado, entra con
// su cuenta de Google y ve lo mismo en modo lectura.
//   GET                        -> saldo, movimientos, consignación, precios
//   GET ?pedido=N              -> arma el borrador de entrega a partir de un pedido de la web
//   POST { entrega:{...} }     -> me entregó mercadería (sube la deuda)
//   POST { pago:{...} }        -> le pagué (baja la deuda)
//   POST { ajuste:{...} }      -> corrección manual
//   POST { consignacion:{...} }-> deja / devuelve / paga mercadería en consignación
//   POST { precio:{...} }      -> edita la lista de precios
//   POST { proveedor:{...} }   -> nombre y email del proveedor
//   POST { borrarMov | borrarConsign }
const { sql, ensureTables, splitNombre, norm, usdRate } = require('./_db');
const { getSession } = require('./_auth');

const TIPOS = ['PEDIDO', 'PAGO', 'AJUSTE'];

async function proveedorActual() {
  const rows = await sql`SELECT id, nombre, email FROM suppliers ORDER BY id LIMIT 1`;
  if (rows.length) return rows[0];
  const nuevo = await sql`INSERT INTO suppliers (nombre) VALUES ('Martín') RETURNING id, nombre, email`;
  return nuevo[0];
}

function limpiarItems(items) {
  return (items || []).map((it) => ({
    articulo: String(it.articulo || '').trim(),
    cantidad: parseInt(it.cantidad, 10) || 0,
    precio_usd: Math.round((Number(it.precio_usd) || 0) * 100) / 100,
  })).filter((it) => it.articulo && it.cantidad);
}

function totalItems(items) {
  return Math.round(items.reduce((a, it) => a + it.cantidad * it.precio_usd, 0) * 100) / 100;
}

module.exports = async (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Necesitás iniciar sesión' });
  try {
    await ensureTables();
    const prov = await proveedorActual();
    const esProveedor = !!(prov.email && s.email && prov.email.toLowerCase() === String(s.email).toLowerCase());
    if (!s.admin && !esProveedor) return res.status(403).json({ error: 'Esta cuenta no tiene acceso' });
    const soloLectura = !s.admin;

    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x');

      // Borrador de entrega a partir de un pedido de la web: pasa las líneas
      // del catálogo a artículos del proveedor usando el mapa de costos.
      const pedidoId = parseInt(url.searchParams.get('pedido') || '', 10);
      if (pedidoId) {
        if (soloLectura) return res.status(403).json({ error: 'Solo el administrador' });
        const [ped] = await sql`SELECT id, items FROM orders WHERE id = ${pedidoId}`;
        if (!ped) return res.status(404).json({ error: 'No existe el pedido' });
        const mapRows = await sql`SELECT patron, articulo, factor FROM cost_map`;
        const precios = await sql`SELECT articulo, precio_usd FROM supplier_prices WHERE activo`;
        const mapa = new Map(mapRows.map((r) => [r.patron, r]));
        const pmap = new Map(precios.map((r) => [String(r.articulo).toUpperCase(), Number(r.precio_usd)]));
        const acum = new Map();
        const sinMapear = new Set();
        (ped.items || []).forEach((it) => {
          const { linea } = splitNombre(it.name);
          const m = mapa.get(norm(linea));
          const qty = Math.max(1, parseInt(it.qty, 10) || 1);
          if (!m) { sinMapear.add(linea); return; }
          const art = m.articulo;
          const cant = qty * (m.factor || 1);
          acum.set(art, (acum.get(art) || 0) + cant);
        });
        const items = [...acum.entries()].map(([articulo, cantidad]) => ({
          articulo, cantidad, precio_usd: pmap.get(articulo.toUpperCase()) || 0,
        }));
        return res.status(200).json({ pedido: ped.id, items, sin_mapear: [...sinMapear] });
      }

      const [movs, consign, precios, usd] = await Promise.all([
        sql`SELECT id, fecha, tipo, monto_usd, detalle, items FROM supplier_moves
            WHERE supplier_id = ${prov.id} ORDER BY fecha, id`,
        sql`SELECT id, fecha, articulo, cantidad, precio_usd, nota FROM supplier_consign
            WHERE supplier_id = ${prov.id} ORDER BY fecha, id`,
        sql`SELECT id, articulo, precio_usd, activo FROM supplier_prices
            WHERE supplier_id = ${prov.id} ORDER BY articulo`,
        usdRate(),
      ]);

      // Saldo corrido de la cuenta corriente.
      let saldo = 0;
      const movimientos = movs.map((m) => {
        saldo = Math.round((saldo + Number(m.monto_usd)) * 100) / 100;
        return { ...m, monto_usd: Number(m.monto_usd), saldo };
      }).reverse();

      // Consignación: qué queda en mi poder, por artículo.
      const porArticulo = new Map();
      consign.forEach((c) => {
        const a = porArticulo.get(c.articulo) || { articulo: c.articulo, cantidad: 0, usd: 0 };
        a.cantidad += c.cantidad;
        a.usd = Math.round((a.usd + c.cantidad * Number(c.precio_usd)) * 100) / 100;
        porArticulo.set(c.articulo, a);
      });
      const stockConsign = [...porArticulo.values()].filter((a) => a.cantidad || a.usd);
      const consignTotal = Math.round(stockConsign.reduce((a, x) => a + x.usd, 0) * 100) / 100;

      return res.status(200).json({
        proveedor: { id: prov.id, nombre: prov.nombre, email: prov.email },
        soloLectura,
        deuda_usd: saldo,
        consign_total_usd: consignTotal,
        movimientos,
        consignacion: consign.slice().reverse(),
        stock_consignacion: stockConsign,
        precios,
        usd,
      });
    }

    if (req.method === 'POST') {
      if (soloLectura) return res.status(403).json({ error: 'Solo el administrador puede cargar movimientos' });
      const b = req.body || {};
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha || '')) ? b.fecha : null;

      /* ----- Datos del proveedor (para darle acceso por su mail) ----- */
      if (b.proveedor) {
        const nombre = String(b.proveedor.nombre || prov.nombre).trim().slice(0, 80) || prov.nombre;
        const email = b.proveedor.email ? String(b.proveedor.email).toLowerCase().trim().slice(0, 120) : null;
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Ese mail no parece válido' });
        await sql`UPDATE suppliers SET nombre = ${nombre}, email = ${email} WHERE id = ${prov.id}`;
        return res.status(200).json({ ok: true });
      }

      /* ----- Lista de precios ----- */
      if (b.precio) {
        const articulo = String(b.precio.articulo || '').trim().slice(0, 80);
        if (!articulo) return res.status(400).json({ error: 'Falta el artículo' });
        if (b.precio.borrar) {
          await sql`DELETE FROM supplier_prices WHERE supplier_id = ${prov.id} AND upper(articulo) = upper(${articulo})`;
          return res.status(200).json({ ok: true });
        }
        const precio = Math.round((Number(b.precio.precio_usd) || 0) * 100) / 100;
        if (!(precio > 0)) return res.status(400).json({ error: 'El precio tiene que ser mayor a cero' });
        await sql`INSERT INTO supplier_prices (supplier_id, articulo, precio_usd, activo)
          VALUES (${prov.id}, ${articulo}, ${precio}, true)
          ON CONFLICT (supplier_id, upper(articulo))
          DO UPDATE SET precio_usd = EXCLUDED.precio_usd, activo = true`;
        return res.status(200).json({ ok: true });
      }

      /* ----- Entrega de mercadería (sube la deuda) ----- */
      if (b.entrega) {
        const items = limpiarItems(b.entrega.items);
        if (!items.length) return res.status(400).json({ error: 'Cargá al menos un artículo con cantidad' });
        const monto = totalItems(items);
        if (!(monto > 0)) return res.status(400).json({ error: 'El total de la entrega da cero' });
        const [mov] = await sql`INSERT INTO supplier_moves (supplier_id, fecha, tipo, monto_usd, detalle, items)
          VALUES (${prov.id}, COALESCE(${fecha}::date, CURRENT_DATE), 'PEDIDO', ${monto},
                  ${b.entrega.detalle ? String(b.entrega.detalle).slice(0, 200) : null},
                  ${JSON.stringify(items)}::jsonb)
          RETURNING id`;
        return res.status(200).json({ ok: true, id: mov.id, monto_usd: monto });
      }

      /* ----- Pago al proveedor (baja la deuda) ----- */
      if (b.pago) {
        const monto = Math.round((Number(b.pago.monto) || 0) * 100) / 100;
        if (!(monto > 0)) return res.status(400).json({ error: 'El monto tiene que ser mayor a cero' });
        await sql`INSERT INTO supplier_moves (supplier_id, fecha, tipo, monto_usd, detalle)
          VALUES (${prov.id}, COALESCE(${fecha}::date, CURRENT_DATE), 'PAGO', ${-monto},
                  ${b.pago.detalle ? String(b.pago.detalle).slice(0, 200) : null})`;
        return res.status(200).json({ ok: true });
      }

      /* ----- Ajuste manual (para cuadrar diferencias) ----- */
      if (b.ajuste) {
        const monto = Math.round((Number(b.ajuste.monto) || 0) * 100) / 100;
        if (!monto) return res.status(400).json({ error: 'El ajuste no puede ser cero' });
        await sql`INSERT INTO supplier_moves (supplier_id, fecha, tipo, monto_usd, detalle)
          VALUES (${prov.id}, COALESCE(${fecha}::date, CURRENT_DATE), 'AJUSTE', ${monto},
                  ${b.ajuste.detalle ? String(b.ajuste.detalle).slice(0, 200) : 'Ajuste manual'})`;
        return res.status(200).json({ ok: true });
      }

      /* ----- Consignación ----- */
      if (b.consignacion) {
        const items = limpiarItems(b.consignacion.items);
        if (!items.length) return res.status(400).json({ error: 'Cargá al menos un artículo con cantidad' });
        // signo: 'deja' suma, 'devuelvo' y 'pago' restan.
        const signo = b.consignacion.tipo === 'deja' ? 1 : -1;
        for (const it of items) {
          await sql`INSERT INTO supplier_consign (supplier_id, fecha, articulo, cantidad, precio_usd, nota)
            VALUES (${prov.id}, COALESCE(${fecha}::date, CURRENT_DATE), ${it.articulo},
                    ${signo * Math.abs(it.cantidad)}, ${it.precio_usd},
                    ${b.consignacion.nota ? String(b.consignacion.nota).slice(0, 200) : null})`;
        }
        // Si me la quedo (le pago), además pasa a la cuenta corriente.
        if (b.consignacion.tipo === 'pago') {
          const monto = totalItems(items.map((i) => ({ ...i, cantidad: Math.abs(i.cantidad) })));
          await sql`INSERT INTO supplier_moves (supplier_id, fecha, tipo, monto_usd, detalle, items)
            VALUES (${prov.id}, COALESCE(${fecha}::date, CURRENT_DATE), 'PEDIDO', ${monto},
                    'Consignación que me quedo', ${JSON.stringify(items)}::jsonb)`;
        }
        return res.status(200).json({ ok: true });
      }

      /* ----- Borrar ----- */
      if (b.borrarMov) {
        await sql`DELETE FROM supplier_moves WHERE id = ${parseInt(b.borrarMov, 10)} AND supplier_id = ${prov.id}`;
        return res.status(200).json({ ok: true });
      }
      if (b.borrarConsign) {
        await sql`DELETE FROM supplier_consign WHERE id = ${parseInt(b.borrarConsign, 10)} AND supplier_id = ${prov.id}`;
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Datos inválidos' });
    }

    res.status(405).json({ error: 'method' });
  } catch (e) {
    res.status(500).json({ error: 'server', detail: String((e && e.message) || e) });
  }
};

module.exports.TIPOS = TIPOS;
