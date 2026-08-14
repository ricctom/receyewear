# Activar los pedidos con login (Neon + Google)

Mientras esto no esté configurado, la tienda **sigue funcionando igual que antes**
(el botón "Finalizar" abre WhatsApp directo). El login y el panel se activan solos
cuando termines estos 3 pasos. Todo es en el panel de Vercel + una vuelta por Google.

---

## 1) Base de datos (Neon) — la crea Vercel sola

1. Entrá a Vercel → proyecto **receyewear** → pestaña **Storage**.
2. **Create Database** → elegí **Neon (Postgres)** → nombre cualquiera → región
   *US East* o *South America* → **Create / Connect**.
3. Listo. Vercel deja sola la variable `DATABASE_URL`.
   **No hay que correr ningún SQL:** las tablas se crean solas con el primer pedido.

## 2) Login con Google — sacar un "Client ID" (2 min)

1. Entrá a https://console.cloud.google.com/ (con tu cuenta).
2. Creá un proyecto (arriba, "Select a project" → New project → nombre "REC Eyewear").
3. Menú ☰ → **APIs y servicios** → **Pantalla de consentimiento OAuth**:
   - Tipo: **Externo** → Crear.
   - Nombre de la app: `REC Eyewear`. Email de asistencia: el tuyo. Guardá y seguí
     (podés dejar el resto en blanco y publicar/o dejar en "Testing").
4. Menú → **Credenciales** → **+ Crear credenciales** → **ID de cliente de OAuth**:
   - Tipo de aplicación: **Aplicación web**.
   - En **Orígenes autorizados de JavaScript** agregá (uno por línea):
     - `https://visionline.com.ar`
     - `https://www.visionline.com.ar`
   - **Crear** → te muestra el **Client ID** (`xxxx.apps.googleusercontent.com`). Copialo.

## 3) Variables en Vercel

Vercel → proyecto **receyewear** → **Settings** → **Environment Variables** → agregá:

| Nombre | Valor |
|---|---|
| `GOOGLE_CLIENT_ID` | el Client ID que copiaste de Google |
| `JWT_SECRET` | un texto largo al azar (te lo paso por chat) |
| `ADMIN_EMAIL` | `ricciarditomas@gmail.com` *(opcional, ya viene por defecto)* |
| `DATABASE_URL` | *(ya lo puso Neon solo, no lo toques)* |

Después: **Deployments** → el último → menú **···** → **Redeploy** (para que tome las variables).

---

## Cómo se usa

- **Clientes:** arman el carrito normal; al tocar **Finalizar**, recién ahí les pide
  *"Iniciá sesión con Google"*. El pedido queda guardado y además se abre el WhatsApp
  como siempre. Pueden ver **"Mis pedidos"** desde arriba.
- **Vos (admin):** entrá a **https://visionline.com.ar/admin.html** con tu cuenta de
  Google. Ves todos los pedidos y podés cambiarles el estado
  (nuevo → preparando → enviado → entregado).

## Notas

- El `GOOGLE_CLIENT_ID` no es secreto (va en el navegador). El `JWT_SECRET` sí: no lo
  compartas ni lo subas al repo.
- Si algún día cambia el dominio, agregá el nuevo origen en el paso 2.4.
