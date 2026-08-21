// Emails de pedido (Resend, best-effort, sin deps):
//   1) aviso al admin,  2) confirmación al cliente.
// Requiere dominio verificado en Resend para mandar desde @visionline.com.ar y a terceros.
const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR');
const FROM = process.env.MAIL_FROM || 'REC Eyewear <pedidos@visionline.com.ar>';

async function sendEmail(key, to, subject, text, html) {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
    });
    return r.ok;
  } catch (e) { return false; }
}

function itemsToText(items) {
  return items.map((it) =>
    `• ${it.name}${it.color ? ' — ' + it.color : ''} × ${it.qty} = ${money(it.price * it.qty)}`
  ).join('\n');
}
function itemsToHtml(items) {
  return items.map((it) =>
    `<div style="padding:3px 0">• ${it.name}${it.color ? ` — <b style="color:#0f7a3d">${it.color}</b>` : ''} × ${it.qty} = ${money(it.price * it.qty)}</div>`
  ).join('');
}

const FALTANTE_TXT = {
  cambiar: 'Si falta algo: cambiar por otro modelo/color parecido',
  consultar: 'Si falta algo: consultarle antes',
  baja: 'Si falta algo: darlo de baja del pedido',
};

// Datos de envío en texto y en HTML (para el aviso al admin).
function shipToText(sh) {
  if (!sh) return '';
  const d = sh.direccion || {};
  return [
    '', 'DATOS DE ENVÍO',
    'Nombre / Razón social: ' + (sh.razon_social || '-'),
    'DNI / CUIT: ' + (sh.dni_cuit || '-'),
    'Teléfono: ' + (sh.telefono || '-'),
    'Dirección: ' + (d.texto || '-') + (d.piso ? ' (piso/depto ' + d.piso + ')' : ''),
    FALTANTE_TXT[sh.faltante] || '',
  ].join('\n');
}
function shipToHtml(sh) {
  if (!sh) return '';
  const d = sh.direccion || {};
  return '<div style="border-top:1px solid #eee;margin-top:14px;padding-top:10px;font-size:13px;color:#444">' +
    '<b style="display:block;margin-bottom:6px">Datos de envío</b>' +
    (sh.razon_social || '-') + ' · DNI/CUIT ' + (sh.dni_cuit || '-') + '<br>' +
    'Tel: ' + (sh.telefono || '-') + '<br>' +
    (d.texto || '-') + (d.piso ? ' (piso/depto ' + d.piso + ')' : '') +
    '<div style="margin-top:8px;background:#fff4e0;border-radius:6px;padding:7px 10px;color:#8a5a00">' +
    (FALTANTE_TXT[sh.faltante] || '') + '</div></div>';
}

async function notifyOrder(order, user, items, ship) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return; // sin clave: el pedido igual se guardó
  const admin = (process.env.ADMIN_EMAIL || 'ricciarditomas@gmail.com');

  // 1) Aviso al ADMIN
  const adminText =
    `Nuevo pedido #${order.id}\n\nCliente: ${user.name || ''} (${user.email})\n\n` +
    `${itemsToText(items)}\n\nTotal: ${money(order.total)}\n\n` +
    `Ver en el panel: https://visionline.com.ar/admin.html`;
  const adminHtml =
    `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">` +
    `<h2 style="margin:0 0 4px">🛒 Nuevo pedido #${order.id}</h2>` +
    `<p style="color:#666;margin:0 0 14px">Cliente: <b>${user.name || ''}</b> (${user.email})</p>` +
    `<div style="border-top:1px solid #eee;padding-top:10px">${itemsToHtml(items)}</div>` +
    `<p style="font-weight:700;margin:12px 0">Total: ${money(order.total)}</p>` +
    shipToHtml(ship) +
    `<a href="https://visionline.com.ar/admin.html" style="display:inline-block;background:#000;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none">Ver en el panel</a>` +
    `</div>`;
  await sendEmail(key, admin, `🛒 Nuevo pedido #${order.id} — ${user.name || user.email}`, adminText, adminHtml);

  // 2) Confirmación al CLIENTE (si tiene email distinto del admin)
  if (user.email && user.email.toLowerCase() !== admin.toLowerCase()) {
    const cliText =
      `¡Hola ${user.name || ''}! Recibimos tu pedido #${order.id} en REC Eyewear.\n\n` +
      `${itemsToText(items)}\n\nTotal: ${money(order.total)}\n\n` +
      `Nos vamos a contactar para coordinar la entrega y el pago. ¡Gracias por tu compra!`;
    const cliHtml =
      `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">` +
      `<h2 style="margin:0 0 4px">¡Gracias por tu pedido! 🕶️</h2>` +
      `<p style="color:#666;margin:0 0 14px">Recibimos tu pedido <b>#${order.id}</b>. Te lo dejamos registrado:</p>` +
      `<div style="border-top:1px solid #eee;padding-top:10px">${itemsToHtml(items)}</div>` +
      `<p style="font-weight:700;margin:12px 0">Total: ${money(order.total)}</p>` +
      `<p style="color:#444">Nos vamos a contactar para coordinar la entrega y el pago. ¡Gracias por elegirnos!</p>` +
      `<p style="color:#999;font-size:12px">REC Eyewear · visionline.com.ar</p>` +
      `</div>`;
    await sendEmail(key, user.email, `Tu pedido #${order.id} en REC Eyewear`, cliText, cliHtml);
  }
}

module.exports = { notifyOrder };
