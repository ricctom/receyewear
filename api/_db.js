// Conexión a Neon (Postgres serverless) + creación automática de tablas.
// Todo se crea/migra solo: no hay que correr ningún SQL a mano.
const { neon } = require('@neondatabase/serverless');
const SEED = require('./_seed');

const sql = neon(process.env.DATABASE_URL);

let ready = null;
function ensureTables() {
  if (ready) return ready;
  ready = (async () => {
    /* ---------- Usuarios y pedidos ---------- */
    await sql`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_sub TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      picture TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`;
    // Datos de envío que quedan guardados en el usuario (se piden una sola vez).
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS dni_cuit TEXT`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS razon_social TEXT`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS telefono TEXT`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS direccion JSONB`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS faltante TEXT`;

    await sql`CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      items JSONB NOT NULL,
      total INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'nuevo',
      created_at TIMESTAMPTZ DEFAULT now()
    )`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship JSONB`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS faltante TEXT`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS usd_rate NUMERIC`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS nota TEXT`;
    // En qué paso está el pedido: nuevo -> pedido (a Martín) -> recibido ->
    // despachado. Reemplaza al viejo "status", que se conserva por las dudas.
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS etapa TEXT`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS recibido JSONB`;
    await sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier_move_id INTEGER`;
    await sql`UPDATE orders SET etapa = CASE status
        WHEN 'preparando' THEN 'pedido'
        WHEN 'enviado' THEN 'despachado'
        WHEN 'entregado' THEN 'despachado'
        WHEN 'cancelado' THEN 'cancelado'
        ELSE 'nuevo' END
      WHERE etapa IS NULL`;
    await sql`ALTER TABLE orders ALTER COLUMN etapa SET DEFAULT 'nuevo'`;

    // Cobros del pedido (permite pagos parciales).
    await sql`CREATE TABLE IF NOT EXISTS order_payments (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      fecha DATE NOT NULL DEFAULT CURRENT_DATE,
      monto INTEGER NOT NULL,
      medio TEXT,
      nota TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`;

    /* ---------- Configuración (dólar, etc.) ---------- */
    await sql`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    )`;

    /* ---------- CRM de clientes ---------- */
    await sql`CREATE TABLE IF NOT EXISTS crm_clients (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      zona TEXT,
      estado TEXT DEFAULT 'tibio',
      telefono TEXT,
      email TEXT,
      ultimo_contacto DATE,
      resumen TEXT,
      proxima_accion TEXT,
      fecha_accion DATE,
      comprado BIGINT DEFAULT 0,
      pendiente BIGINT DEFAULT 0,
      archivado BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS crm_clients_nombre_uk ON crm_clients (lower(nombre))`;
    await sql`CREATE TABLE IF NOT EXISTS crm_events (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES crm_clients(id) ON DELETE CASCADE,
      fecha DATE NOT NULL DEFAULT CURRENT_DATE,
      texto TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )`;

    /* ---------- Proveedores ---------- */
    await sql`CREATE TABLE IF NOT EXISTS suppliers (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      email TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`;
    // Link de invitación: el primero que entre con Google por ese link queda
    // registrado como el proveedor y el token se quema.
    await sql`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS invite_token TEXT`;
    await sql`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`;
    // Cada proveedor lleva su cuenta en su moneda: Martín en dólares,
    // los locales en pesos. Por eso los montos dejan de llamarse "usd".
    await sql`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS moneda TEXT DEFAULT 'USD'`;
    await sql`UPDATE suppliers SET moneda = 'USD' WHERE moneda IS NULL`;
    await sql`CREATE TABLE IF NOT EXISTS supplier_prices (
      id SERIAL PRIMARY KEY,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      articulo TEXT NOT NULL,
      precio_usd NUMERIC NOT NULL DEFAULT 0,
      activo BOOLEAN DEFAULT true
    )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS supplier_prices_uk
      ON supplier_prices (supplier_id, upper(articulo))`;
    await sql`ALTER TABLE supplier_prices ADD COLUMN IF NOT EXISTS precio NUMERIC`;
    await sql`UPDATE supplier_prices SET precio = precio_usd WHERE precio IS NULL`;
    await sql`CREATE TABLE IF NOT EXISTS supplier_moves (
      id SERIAL PRIMARY KEY,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      fecha DATE NOT NULL DEFAULT CURRENT_DATE,
      tipo TEXT NOT NULL,
      monto_usd NUMERIC NOT NULL,
      detalle TEXT,
      items JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now()
    )`;
    // Qué pedido de la web generó este movimiento (si vino de uno).
    await sql`ALTER TABLE supplier_moves ADD COLUMN IF NOT EXISTS order_id INTEGER`;
    await sql`ALTER TABLE supplier_moves ADD COLUMN IF NOT EXISTS monto NUMERIC`;
    await sql`UPDATE supplier_moves SET monto = monto_usd WHERE monto IS NULL`;
    await sql`CREATE TABLE IF NOT EXISTS supplier_consign (
      id SERIAL PRIMARY KEY,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
      fecha DATE NOT NULL DEFAULT CURRENT_DATE,
      articulo TEXT NOT NULL,
      cantidad INTEGER NOT NULL,
      precio_usd NUMERIC NOT NULL DEFAULT 0,
      nota TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`;
    await sql`ALTER TABLE supplier_consign ADD COLUMN IF NOT EXISTS precio NUMERIC`;
    await sql`UPDATE supplier_consign SET precio = precio_usd WHERE precio IS NULL`;
    // Qué artículo del proveedor corresponde a cada línea de la web.
    await sql`CREATE TABLE IF NOT EXISTS cost_map (
      id SERIAL PRIMARY KEY,
      patron TEXT NOT NULL UNIQUE,
      articulo TEXT NOT NULL,
      factor INTEGER NOT NULL DEFAULT 1
    )`;
    await sql`ALTER TABLE cost_map ADD COLUMN IF NOT EXISTS ignorar BOOLEAN DEFAULT false`;
    await sql`ALTER TABLE cost_map ADD COLUMN IF NOT EXISTS costo_ars NUMERIC DEFAULT 0`;
    // Cada línea del catálogo pertenece a un proveedor.
    await sql`ALTER TABLE cost_map ADD COLUMN IF NOT EXISTS supplier_id INTEGER`;

    await seedProveedores();

    // La carga inicial de datos no es crítica: si algo falla, las tablas ya
    // están creadas y la tienda sigue andando. Se reintenta en el próximo
    // arranque en frío mientras las tablas sigan vacías.
    try {
      await seedOnce();
    } catch (e) {
      console.error('No se pudo cargar la migración inicial:', (e && e.message) || e);
    }
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

// Deja creados los tres proveedores con su moneda y le pone dueño a cada
// línea del catálogo. Es idempotente: se puede correr todas las veces.
async function seedProveedores() {
  const nombres = await sql`SELECT id, nombre FROM suppliers`;
  if (!nombres.length) return;                     // todavía no corrió el seed inicial
  const buscar = (n) => nombres.find((x) => x.nombre.toLowerCase().startsWith(n));

  const martin = buscar('mart');
  if (martin) await sql`UPDATE suppliers SET moneda = 'USD' WHERE id = ${martin.id}`;

  // Fernando (franelas y estuches) y Juan (líquidos), los dos en pesos.
  for (const nombre of ['Fernando', 'Juan']) {
    if (!buscar(nombre.toLowerCase())) {
      await sql`INSERT INTO suppliers (nombre, moneda) VALUES (${nombre}, 'ARS')`;
    }
  }
  const todos = await sql`SELECT id, nombre FROM suppliers`;
  const idDe = (n) => {
    const p = todos.find((x) => x.nombre.toLowerCase().startsWith(n));
    return p ? p.id : null;
  };
  const idMartin = idDe('mart'), idFer = idDe('fernando'), idJuan = idDe('juan');

  // Lo que ya estaba mapeado sin dueño era todo de Martín.
  if (idMartin) {
    await sql`UPDATE cost_map SET supplier_id = ${idMartin}
      WHERE supplier_id IS NULL AND NOT COALESCE(ignorar, false)`;
  }

  // Franelas: el único costo que sabemos de Fernando.
  if (idFer) {
    await sql`INSERT INTO supplier_prices (supplier_id, articulo, precio_usd, precio)
      VALUES (${idFer}, 'FRANELAS PERSONALIZADAS', 199, 199)
      ON CONFLICT (supplier_id, upper(articulo)) DO NOTHING`;
    await sql`INSERT INTO cost_map (patron, articulo, factor, supplier_id)
      VALUES ('franelas personalizadas pack x100', 'FRANELAS PERSONALIZADAS', 100, ${idFer})
      ON CONFLICT (patron) DO UPDATE SET articulo = 'FRANELAS PERSONALIZADAS',
        factor = 100, supplier_id = ${idFer}, ignorar = false`;
    // Los estuches también son de él; el costo lo carga Tomás.
    await sql`INSERT INTO cost_map (patron, articulo, factor, supplier_id)
      VALUES ('estuche plastico personalizado pack x100', 'ESTUCHE PERSONALIZADO', 100, ${idFer})
      ON CONFLICT (patron) DO NOTHING`;
  }
  // El limpia cristales son los líquidos de Juan.
  if (idJuan) {
    await sql`INSERT INTO cost_map (patron, articulo, factor, supplier_id)
      VALUES ('limpia cristales personalizados pack x100', 'LIMPIA CRISTALES', 100, ${idJuan})
      ON CONFLICT (patron) DO NOTHING`;
  }
}

// Carga inicial: solo corre si las tablas están vacías. Se hace de a bloques
// (una sola consulta por tabla) para que el primer arranque no se demore.
async function seedOnce() {
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM suppliers`;
  if (!n) {
    const [prov] = await sql`INSERT INTO suppliers (nombre, email, moneda) VALUES ('Martín', NULL, 'USD') RETURNING id`;
    const sid = prov.id;

    const precios = SEED.PRECIOS.map(([articulo, precio_usd]) => ({ articulo, precio_usd }));
    await sql`
      INSERT INTO supplier_prices (supplier_id, articulo, precio_usd, precio)
      SELECT ${sid}, articulo, precio_usd, precio_usd
      FROM jsonb_to_recordset(${JSON.stringify(precios)}::jsonb) AS x(articulo text, precio_usd numeric)
      ON CONFLICT DO NOTHING`;

    const movs = SEED.MOVIMIENTOS.map((m) => ({
      fecha: m.fecha, tipo: m.tipo, monto_usd: m.monto,
      detalle: m.detalle || 'Migrado de la planilla',
      items: (m.items || []).map(([articulo, cantidad, precio_usd]) => ({ articulo, cantidad, precio_usd })),
    }));
    await sql`
      INSERT INTO supplier_moves (supplier_id, fecha, tipo, monto_usd, monto, detalle, items)
      SELECT ${sid}, fecha, tipo, monto_usd, monto_usd, detalle, items
      FROM jsonb_to_recordset(${JSON.stringify(movs)}::jsonb)
        AS x(fecha date, tipo text, monto_usd numeric, detalle text, items jsonb)`;

    const cons = SEED.CONSIGNACION.map(([fecha, articulo, cantidad, precio_usd, nota]) =>
      ({ fecha, articulo, cantidad, precio_usd, nota: nota || null }));
    await sql`
      INSERT INTO supplier_consign (supplier_id, fecha, articulo, cantidad, precio_usd, precio, nota)
      SELECT ${sid}, fecha, articulo, cantidad, precio_usd, precio_usd, nota
      FROM jsonb_to_recordset(${JSON.stringify(cons)}::jsonb)
        AS x(fecha date, articulo text, cantidad int, precio_usd numeric, nota text)`;
  }

  const [{ n: nc }] = await sql`SELECT count(*)::int AS n FROM cost_map`;
  if (!nc) {
    const costos = SEED.COSTOS.map(([patron, articulo, factor]) => ({ patron, articulo, factor }));
    await sql`
      INSERT INTO cost_map (patron, articulo, factor)
      SELECT patron, articulo, factor
      FROM jsonb_to_recordset(${JSON.stringify(costos)}::jsonb) AS x(patron text, articulo text, factor int)
      ON CONFLICT (patron) DO NOTHING`;
  }

  // Clientes migrados del artefacto "REC CRM" (130 fichas con su historial).
  const [{ n: ncrm }] = await sql`SELECT count(*)::int AS n FROM crm_clients`;
  if (!ncrm) {
    const CLIENTES = require('./_seed_crm');
    await sql`
      INSERT INTO crm_clients (nombre, zona, estado, ultimo_contacto, resumen,
                               proxima_accion, fecha_accion, comprado, pendiente)
      SELECT nombre, zona, estado, ultimo_contacto, resumen, proxima_accion, fecha_accion,
             COALESCE(comprado, 0), COALESCE(pendiente, 0)
      FROM jsonb_to_recordset(${JSON.stringify(CLIENTES)}::jsonb)
        AS x(nombre text, zona text, estado text, ultimo_contacto date, resumen text,
             proxima_accion text, fecha_accion date, comprado bigint, pendiente bigint)
      ON CONFLICT (lower(nombre)) DO NOTHING`;

    const eventos = CLIENTES.flatMap((c) =>
      (c.eventos || []).map((e) => ({ nombre: c.nombre, fecha: e.fecha, texto: e.texto })));
    await sql`
      INSERT INTO crm_events (client_id, fecha, texto)
      SELECT c.id, COALESCE(e.fecha, CURRENT_DATE), e.texto
      FROM jsonb_to_recordset(${JSON.stringify(eventos)}::jsonb) AS e(nombre text, fecha date, texto text)
      JOIN crm_clients c ON lower(c.nombre) = lower(e.nombre)`;
  }
}

/* ---------- Helpers compartidos ---------- */

// "Metal Receta Diseño (MS18)" -> { linea:'Metal Receta Diseño', modelo:'MS18' }
function splitNombre(name) {
  const s = String(name || '').trim();
  const m = s.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return { linea: m[1].trim() || 'Sin línea', modelo: m[2].trim() };
  return { linea: s || 'Sin línea', modelo: '' };
}

// Normaliza para comparar líneas: minúsculas, sin acentos, sin espacios de más.
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

async function getSettings() {
  const rows = await sql`SELECT key, value FROM settings`;
  const out = {};
  rows.forEach((r) => { out[r.key] = r.value; });
  return out;
}

async function setSetting(key, value) {
  await sql`INSERT INTO settings (key, value, updated_at) VALUES (${key}, ${value == null ? null : String(value)}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

// Cotización efectiva: si hay un valor cargado a mano, gana. Si no, el blue
// (cacheado 6 horas para no pegarle a la API en cada request).
async function usdRate() {
  const s = await getSettings();
  if (s.usd_manual && Number(s.usd_manual) > 0) {
    return { valor: Number(s.usd_manual), fuente: 'manual', fecha: s.usd_manual_at || null };
  }
  const cacheOk = s.usd_auto && s.usd_auto_at &&
    (Date.now() - new Date(s.usd_auto_at).getTime()) < 6 * 60 * 60 * 1000;
  if (cacheOk) return { valor: Number(s.usd_auto), fuente: 'blue', fecha: s.usd_auto_at };
  try {
    const r = await fetch('https://dolarapi.com/v1/dolares/blue');
    const d = await r.json();
    const valor = Number(d && d.venta);
    if (valor > 0) {
      const at = new Date().toISOString();
      await setSetting('usd_auto', valor);
      await setSetting('usd_auto_at', at);
      return { valor, fuente: 'blue', fecha: at };
    }
  } catch { /* si la API falla, seguimos con el último valor conocido */ }
  if (s.usd_auto) return { valor: Number(s.usd_auto), fuente: 'blue (viejo)', fecha: s.usd_auto_at };
  return { valor: 0, fuente: 'sin cotización', fecha: null };
}

// Tablas de costo (mapa de líneas + lista de precios del proveedor). Se leen
// una sola vez y después se reusan para todos los pedidos.
async function costTables() {
  const [mapRows, priceRows, provs] = await Promise.all([
    sql`SELECT patron, articulo, factor, supplier_id FROM cost_map`,
    sql`SELECT supplier_id, articulo, precio FROM supplier_prices WHERE activo`,
    sql`SELECT id, nombre, moneda FROM suppliers ORDER BY id`,
  ]);
  return {
    mapa: new Map(mapRows.map((r) => [r.patron, r])),
    // La clave lleva el proveedor: dos proveedores pueden tener el mismo artículo.
    precios: new Map(priceRows.map((r) => [r.supplier_id + '|' + String(r.articulo).toUpperCase(), Number(r.precio)])),
    provs: new Map(provs.map((p) => [p.id, p])),
  };
}

// Costo en dólares de los items de un pedido. Devuelve también qué líneas
// quedaron sin costo asignado, para poder avisarlo en el panel.
// Reparte el costo de un pedido entre los proveedores que correspondan.
// Devuelve un renglón por proveedor, cada uno en su moneda.
function costoDe(items, t) {
  return costoLineasDe(
    (items || []).map((it) => ({ linea: splitNombre(it.name).linea,
                                 qty: Math.max(1, parseInt(it.qty, 10) || 1) })), t);
}

function costoLineasDe(lineas, t) {
  const porProv = new Map();
  const sinCosto = [];
  const visto = new Set();
  lineas.forEach((l) => {
    const m = t.mapa.get(norm(l.linea));
    const prov = m && m.supplier_id ? t.provs.get(m.supplier_id) : null;
    const precio = prov ? t.precios.get(prov.id + '|' + String(m.articulo).toUpperCase()) : undefined;
    if (precio == null) {
      if (l.qty && !visto.has(l.linea)) {
        visto.add(l.linea);
        sinCosto.push({ linea: l.linea, proveedor: prov ? prov.nombre : null });
      }
      return;
    }
    const cantidad = l.qty * (m.factor || 1);
    if (!cantidad) return;
    if (!porProv.has(prov.id)) {
      porProv.set(prov.id, { supplier_id: prov.id, nombre: prov.nombre,
                             moneda: prov.moneda || 'USD', monto: 0, items: [] });
    }
    const p = porProv.get(prov.id);
    p.monto += precio * cantidad;
    const ya = p.items.find((x) => x.articulo === m.articulo);
    if (ya) ya.cantidad += cantidad;
    else p.items.push({ articulo: m.articulo, cantidad, precio });
  });
  const detalle = [...porProv.values()].map((p) => ({ ...p, monto: Math.round(p.monto * 100) / 100 }));
  return { detalle, sinCosto };
}

async function costoItems(items) {
  return costoDe(items, await costTables());
}

// Pasa a pesos el costo repartido, usando la cotización para lo que está en dólares.
function costoEnPesos(detalle, dolar) {
  return Math.round((detalle || []).reduce((a, d) =>
    a + (d.moneda === 'USD' ? d.monto * (Number(dolar) || 0) : d.monto), 0));
}

module.exports = {
  sql, ensureTables, splitNombre, norm,
  getSettings, setSetting, usdRate,
  costTables, costoDe, costoLineasDe, costoItems, costoEnPesos,
};
