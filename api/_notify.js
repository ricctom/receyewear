// Aviso por email al admin cuando entra un pedido (Resend, best-effort, sin deps).
const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR');

async function notifyOrder(order, user, items) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return; // sin clave configurada, no se notifica (el pedido igual se guardó)
  const to = (process.env.ADMIN_EMAIL || 'ricciarditomas@gmail.com');

  const rows = items.map((it) =>
    `• ${it.name}${it.color ? ' — ' + it.color : ''} × ${it.qty} = ${money(it.price * it.qty)}`
  ).join('\n');

  const text =
    `Nuevo pedido #${order.id}\n\n` +
    `Cliente: ${user.name || ''} (${user.email})\n\n` +
    `${rows}\n\n` +
    `Total: ${money(order.total)}\n\n` +
    `Ver en el panel: https://visionline.com.ar/admin.html`;

  const html =
    `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">` +
    `<h2 style="margin:0 0 4px">🛒 Nuevo pedido #${order.id}</h2>` +
    `<p style="color:#666;margin:0 0 14px">Cliente: <b>${user.name || ''}</b> (${user.email})</p>` +
    `<div style="border-top:1px solid #eee;padding-top:10px">` +
    items.map((it) =>
      `<div style="padding:3px 0">• ${it.name}${it.color ? ` — <b style="color:#0f7a3d">${it.color}</b>` : ''} × ${it.qty} = ${money(it.price * it.qty)}</div>`
    ).join('') +
    `</div>` +
    `<p style="font-weight:700;margin:12px 0">Total: ${money(order.total)}</p>` +
    `<a href="https://visionline.com.ar/admin.html" style="display:inline-block;background:#000;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none">Ver en el panel</a>` +
    `</div>`;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'REC Eyewear <onboarding@resend.dev>',
        to: [to],
        subject: `🛒 Nuevo pedido #${order.id} — ${user.name || user.email}`,
        text,
        html,
      }),
    });
  } catch (e) { /* best-effort: nunca romper el pedido por el email */ }
}

module.exports = { notifyOrder };
