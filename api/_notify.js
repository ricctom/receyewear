// Emails de pedido (Resend, best-effort, sin deps):
//   1) aviso al admin,  2) confirmación al cliente. Los dos llevan el PDF del pedido.
// Requiere dominio verificado en Resend para mandar desde @visionline.com.ar y a terceros.
const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR');
const FROM = process.env.MAIL_FROM || 'REC Eyewear <pedidos@visionline.com.ar>';

async function sendEmail(key, to, subject, text, html, attachments) {
  try {
    const body = { from: FROM, to: [to], subject, text, html };
    if (attachments && attachments.length) body.attachments = attachments;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch (e) { return false; }
}

function itemsToText(items) {
  return items.map((it) =>
    `• ${it.name}${it.color ? ' — ' + it.color : ''} × ${it.qty} (${money(it.price)} c/u) = ${money(it.price * it.qty)}`
  ).join('\n');
}
function itemsToHtml(items) {
  return items.map((it) =>
    `<div style="padding:3px 0">• ${it.name}${it.color ? ` — <b style="color:#0f7a3d">${it.color}</b>` : ''} × ${it.qty}` +
    ` <span style="color:#888">(${money(it.price)} c/u)</span> = ${money(it.price * it.qty)}</div>`
  ).join('');
}

// Subtotal, cupón y total. El total del pedido ya viene con el cupón restado.
function totalesText(order) {
  const desc = Number(order.descuento) || 0;
  return (desc > 0
    ? `Subtotal: ${money(order.total + desc)}\nCupón de descuento: -${money(desc)}\n`
    : '') + `Total: ${money(order.total)}`;
}
function totalesHtml(order) {
  const desc = Number(order.descuento) || 0;
  return (desc > 0
    ? `<p style="margin:12px 0 2px;color:#444">Subtotal: ${money(order.total + desc)}</p>` +
      `<p style="margin:0 0 2px;color:#0f7a3d">Cupón de descuento: -${money(desc)}</p>`
    : '') + `<p style="font-weight:700;margin:${desc > 0 ? '6px' : '12px'} 0 12px">Total: ${money(order.total)}</p>`;
}

// Qué pidió que se haga en cada escenario de faltante.
const COLOR_TXT = {
  mismo:     'mandarle el mismo modelo en otro color',
  parecido:  'mandarle uno parecido',
  consultar: 'CONSULTARLE antes de mandarlo',
  baja:      'darlo de baja y mandarle el resto',
};
const MODELO_TXT = {
  parecido:  'mandarle uno parecido',
  consultar: 'CONSULTARLE antes de mandarlo',
  baja:      'darlo de baja y mandarle el resto',
};
function faltanteLineas(sh) {
  const d = sh && sh.faltante_detalle;
  if (!d) return [];
  const l = [];
  if (COLOR_TXT[d.color]) l.push('Si no está el COLOR: ' + COLOR_TXT[d.color]);
  if (MODELO_TXT[d.modelo]) l.push('Si no está el MODELO: ' + MODELO_TXT[d.modelo]);
  if (d.sin_repetir) l.push('¡OJO! Está pidiendo de a uno para probar: NO repetirle colores ni modelos');
  if (d.nota) l.push('Aclaró: «' + d.nota + '»');
  return l;
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
    ...faltanteLineas(sh).map((x) => '  · ' + x),
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
    (FALTANTE_TXT[sh.faltante] || '') +
    faltanteLineas(sh).map((x) => '<div style="margin-left:12px;color:#666">· ' + x + '</div>').join('') +
    '</div></div>';
}

async function notifyOrder(order, user, items, ship) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return; // sin clave: el pedido igual se guardó
  const admin = (process.env.ADMIN_EMAIL || 'ricciarditomas@gmail.com');

  // El PDF del pedido, adjunto a los dos mails. Si no se puede armar, los
  // mails salen igual sin el adjunto.
  let adjuntos = [];
  try {
    const { pedidoPdf } = require('./_pdf');
    const pdf = await pedidoPdf(order, user, items, ship);
    adjuntos = [{ filename: `Pedido-${order.id}-REC-Eyewear.pdf`, content: pdf.toString('base64') }];
  } catch (e) {
    console.error('No se pudo armar el PDF del pedido', order.id, (e && e.message) || e);
  }

  // 1) Aviso al ADMIN
  const adminText =
    `Nuevo pedido #${order.id}\n\nCliente: ${user.name || ''} (${user.email})\n\n` +
    `${itemsToText(items)}\n\n${totalesText(order)}\n\n` +
    `Ver en el panel: https://visionline.com.ar/admin.html`;
  const adminHtml =
    `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">` +
    `<h2 style="margin:0 0 4px">🛒 Nuevo pedido #${order.id}</h2>` +
    `<p style="color:#666;margin:0 0 14px">Cliente: <b>${user.name || ''}</b> (${user.email})</p>` +
    `<div style="border-top:1px solid #eee;padding-top:10px">${itemsToHtml(items)}</div>` +
    totalesHtml(order) +
    shipToHtml(ship) +
    `<a href="https://visionline.com.ar/admin.html" style="display:inline-block;background:#000;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none">Ver en el panel</a>` +
    `</div>`;
  await sendEmail(key, admin, `🛒 Nuevo pedido #${order.id} — ${user.name || user.email}`, adminText, adminHtml, adjuntos);

  // 2) Confirmación al CLIENTE (si tiene email distinto del admin)
  if (user.email && user.email.toLowerCase() !== admin.toLowerCase()) {
    const pdfTxt = adjuntos.length ? 'Te adjuntamos el detalle del pedido en PDF.\n\n' : '';
    const cliText =
      `¡Hola ${user.name || ''}! Recibimos tu pedido #${order.id} en REC Eyewear.\n\n` +
      `${itemsToText(items)}\n\n${totalesText(order)}\n\n${pdfTxt}` +
      `Nos vamos a contactar para coordinar la entrega y el pago. ¡Gracias por tu compra!`;
    const cliHtml =
      `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">` +
      `<h2 style="margin:0 0 4px">¡Gracias por tu pedido! 🕶️</h2>` +
      `<p style="color:#666;margin:0 0 14px">Recibimos tu pedido <b>#${order.id}</b>. Te lo dejamos registrado:</p>` +
      `<div style="border-top:1px solid #eee;padding-top:10px">${itemsToHtml(items)}</div>` +
      totalesHtml(order) +
      (adjuntos.length ? `<p style="color:#444">Te adjuntamos el detalle del pedido en PDF.</p>` : '') +
      `<p style="color:#444">Nos vamos a contactar para coordinar la entrega y el pago. ¡Gracias por elegirnos!</p>` +
      `<p style="color:#999;font-size:12px">REC Eyewear · visionline.com.ar</p>` +
      `</div>`;
    await sendEmail(key, user.email, `Tu pedido #${order.id} en REC Eyewear`, cliText, cliHtml, adjuntos);
  }
}

module.exports = { notifyOrder };
