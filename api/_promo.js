// ============================================================================
//  CAMPAÑA "CUPÓN POR INICIAR SESIÓN"
//  El cliente entra, toca "Ingresar con Google" y le queda cargado un cupón.
//  Lo gana cualquiera que inicie sesión durante la campaña: no importa si la
//  cuenta es nueva o si ya la tenía.
//
//  PARA CAMBIAR LA PROMO (monto, mínimo o fechas) SE TOCA SOLO ESTE BLOQUE
//  y se vuelve a subir con SUBIR-A-PRODUCCION.bat. Nada más.
//
//  Hay DOS fechas: hasta cuándo se puede reclamar el cupón (vence) y hasta
//  cuándo se puede usar el que ya está entregado (venceUso).
//
//  Ojo con las fechas: van en UTC. Argentina es UTC-3, así que la medianoche
//  de acá se escribe como las 03:00 del día siguiente en UTC.
// ============================================================================
const PROMO = {
  codigo:  'BIENVENIDA50',
  monto:   50000,   // lo que descuenta del total
  minimo:  600000,  // compra mínima para poder usarlo

  // Se entrega desde el lunes 31/8/2026 a las 00:00 de Argentina...
  desde:  new Date('2026-08-31T03:00:00Z'),
  // ...y se puede reclamar hasta el lunes 7/9/2026 a las 23:59 de Argentina.
  vence:  new Date('2026-09-08T02:59:59Z'),

  // El que ya se lo llevó tiene tiempo de usarlo hasta fin de septiembre:
  // martes 30/9/2026 a las 23:59 de Argentina. Esta es la fecha que queda
  // guardada en cada cupón y la que se le muestra al cliente.
  venceUso: new Date('2026-10-01T02:59:59Z'),
};

// El acceso a la base se pide recién cuando hace falta, para que /api/config
// pueda leer los datos de la promo sin depender de la conexión a Neon.
function db() { return require('./_db').sql; }

function ahora() { return new Date(); }

// ¿La campaña está corriendo en este momento?
function promoActiva(t = ahora()) {
  return t >= PROMO.desde && t <= PROMO.vence;
}

// Le da el cupón al usuario. Si ya lo tiene no hace nada (el índice único
// sobre (user_id, codigo) se encarga de que no se dupliquen).
// Devuelve el cupón vigente, o null si la campaña ya terminó.
async function otorgar(userId) {
  if (!promoActiva()) return null;
  const sql = db();
  await sql`
    INSERT INTO vouchers (user_id, codigo, monto, minimo, vence)
    VALUES (${userId}, ${PROMO.codigo}, ${PROMO.monto}, ${PROMO.minimo}, ${PROMO.venceUso.toISOString()})
    ON CONFLICT (user_id, codigo) DO NOTHING`;
  return vigente(userId);
}

// El cupón que el usuario puede usar ahora: sin gastar y sin vencer.
async function vigente(userId) {
  const sql = db();
  const rows = await sql`
    SELECT id, codigo, monto, minimo, vence, created_at
      FROM vouchers
     WHERE user_id = ${userId} AND used_at IS NULL AND vence > now()
     ORDER BY id LIMIT 1`;
  return rows[0] || null;
}

// Cuánto descuenta este cupón sobre un subtotal dado.
// Es todo o nada: o llega al mínimo y descuenta los $50.000, o no descuenta.
function descuentoDe(subtotal, v) {
  if (!v) return 0;
  if (subtotal < Number(v.minimo)) return 0;
  return Math.min(Number(v.monto), subtotal);
}

// Marca el cupón como gastado ANTES de crear el pedido, para que dos pedidos
// simultáneos no lo puedan usar los dos. Devuelve true si lo pudo tomar.
async function tomar(voucherId) {
  const sql = db();
  const rows = await sql`
    UPDATE vouchers SET used_at = now()
     WHERE id = ${voucherId} AND used_at IS NULL
     RETURNING id`;
  return rows.length > 0;
}

// Le engancha el pedido al cupón ya tomado (para el reporte).
async function asociar(voucherId, orderId) {
  const sql = db();
  await sql`UPDATE vouchers SET order_id = ${orderId} WHERE id = ${voucherId}`;
}

// Si el pedido no se llegó a crear, se devuelve el cupón.
async function devolver(voucherId) {
  const sql = db();
  await sql`UPDATE vouchers SET used_at = NULL, order_id = NULL WHERE id = ${voucherId}`;
}

module.exports = { PROMO, promoActiva, otorgar, vigente, descuentoDe, tomar, asociar, devolver };
