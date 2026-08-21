/* Piezas compartidas por las tres pantallas del panel
   (admin.html = pedidos, crm.html = clientes, proveedor.html = Martín). */

let session = JSON.parse(localStorage.getItem('rec4_session') || 'null');
let onReady = null;
let requiereAdmin = true;   // proveedor.html lo pone en false

const fmt = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR');
const usd = (n) => 'US$ ' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

// "Metal Receta Diseño (MS18)" -> { linea:'Metal Receta Diseño', modelo:'MS18' }
function splitNombre(name){
  const s = String(name || '').trim();
  const m = s.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if(m) return { linea: m[1].trim() || 'Sin línea', modelo: m[2].trim() };
  return { linea: s || 'Sin línea', modelo: '' };
}

function fechaCorta(f){
  if(!f) return '—';
  const d = new Date(String(f).length <= 10 ? f + 'T12:00:00' : f);
  if(isNaN(d)) return '—';
  return d.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'2-digit' });
}
function diasDesde(f){
  if(!f) return null;
  const d = new Date(String(f).length <= 10 ? f + 'T12:00:00' : f);
  if(isNaN(d)) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
function hoyISO(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

async function api(path, opts = {}){
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if(session && session.token) headers['Authorization'] = 'Bearer ' + session.token;
  const r = await fetch(path, Object.assign({}, opts, { headers }));
  const data = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(data.error || ('Error ' + r.status));
  return data;
}

const esSesion = (e) => /sesi|admin|403|401/i.test(String(e && e.message));

function saveSession(s){ session = s; localStorage.setItem('rec4_session', JSON.stringify(s)); }
function logout(){ localStorage.removeItem('rec4_session'); location.reload(); }

async function onCredential(resp){
  const msg = document.getElementById('gateMsg');
  msg.textContent = '';
  try{
    const data = await api('/api/auth', { method:'POST', body: JSON.stringify({ credential: resp.credential }) });
    if(requiereAdmin && !data.user.admin){ msg.textContent = 'Esa cuenta no tiene acceso al panel.'; return; }
    saveSession(data);
    mostrarPanel();
  }catch(e){ msg.textContent = e.message; }
}

async function initGoogle(){
  const msg = document.getElementById('gateMsg');
  try{
    const cfg = await api('/api/config');
    if(!cfg.googleClientId){ msg.textContent = 'Falta configurar GOOGLE_CLIENT_ID en Vercel.'; return; }
    const start = () => {
      google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: onCredential });
      google.accounts.id.renderButton(document.getElementById('gbtn'),
        { theme:'filled_black', size:'large', text:'signin_with', shape:'pill' });
    };
    if(window.google && google.accounts) start();
    else { const t = setInterval(() => { if(window.google && google.accounts){ clearInterval(t); start(); } }, 150); }
  }catch(e){ msg.textContent = e.message; }
}

function mostrarPanel(){
  document.getElementById('gate').style.display = 'none';
  document.getElementById('panel').style.display = 'block';
  document.getElementById('who').innerHTML =
    esc(session.user.name || session.user.email) + ' <button onclick="logout()">Salir</button>';
  if(onReady) onReady();
}

// Arranque común: si ya hay sesión válida entra directo, si no muestra el login.
function bootPanel(cb, opts){
  onReady = cb;
  if(opts && opts.admin === false) requiereAdmin = false;
  if(session && session.user && (!requiereAdmin || session.user.admin)) mostrarPanel();
  else initGoogle();
}

/* ---------------- modal y toast ---------------- */
function abrirModal(html){
  document.getElementById('modalBody').innerHTML = html;
  document.getElementById('ov').classList.add('open');
  document.getElementById('modal').classList.add('open');
  const primero = document.querySelector('#modalBody input, #modalBody textarea, #modalBody select');
  if(primero) setTimeout(() => primero.focus(), 60);
}
function cerrarModal(){
  document.getElementById('ov').classList.remove('open');
  document.getElementById('modal').classList.remove('open');
}
document.addEventListener('keydown', (e) => { if(e.key === 'Escape') cerrarModal(); });

let toastT = null;
function showToast(msg){
  let el = document.getElementById('toastEl');
  if(!el){
    el = document.createElement('div');
    el.id = 'toastEl'; el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('on'), 2200);
}
