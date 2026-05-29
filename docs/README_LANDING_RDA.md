# Landing Rey de Ases RdA

Landing mobile-first servida desde el backend Fastify en `GET /landing`.

## Objetivo

- Mostrar una landing de Rey de Ases para RdA.
- Enviar al usuario a WhatsApp de `luqui10:luqui10`.
- Medir el click con Meta Pixel y Meta CAPI como evento `Contact`.
- No crear clientes, leads ni links CRM desde el click de landing.

## URLs

- Landing: `GET /landing`
- Privacidad: `GET /landing/privacidad`
- Terminos: `GET /landing/terminos`
- Tracking backend: `POST /landing/contact`

CTA final:

```text
https://wa.me/5493516549344?text=Hola%20quiero%20mi%20usuario%20en%20Rey%20de%20Ases
```

## Archivos front

```text
public/landing/index.html
public/landing/styles.css
public/landing/landing.js
public/landing/privacidad.html
public/landing/terminos.html
public/landing/assets/hero-monkey-king.webp
public/landing/assets/logo-rey-de-ases.svg
public/landing/assets/whatsapp.svg
```

El hero `hero-monkey-king.webp` esta optimizado para mobile y pesa cerca de `92 KB`.
El peso critico aproximado de HTML + CSS + JS + SVGs + hero es `~110 KB`, sin contar scripts externos de Meta.

## Configuracion

Variables nuevas:

```env
LANDING_ENABLED=true
LANDING_ALLOWED_ORIGINS=
META_PIXEL_ID=
META_LANDING_ACTION_SOURCE=website
```

Variables Meta existentes requeridas para CAPI real:

```env
META_ENABLED=true
META_DATASET_ID=2123208205169806
META_ACCESS_TOKEN=...
META_API_VERSION=v25.0
META_ACTION_SOURCE=system_generated
```

`META_ACTION_SOURCE` se mantiene en `system_generated` para CTWA/CRM.
La landing usa `META_LANDING_ACTION_SOURCE=website` solo para `Contact`.

## Tracking

En carga de pagina:

- Si `META_PIXEL_ID` existe, carga Pixel async.
- Dispara `PageView`.

En click del CTA:

- Genera `event_id`.
- Lee `_fbp`, `_fbc`, `fbclid`, UTMs, URL actual y referrer.
- Dispara Pixel `Contact` con `{ eventID: event_id }`.
- Envia `POST /landing/contact`.
- Redirige a WhatsApp incluso si Pixel o CAPI fallan.

Backend CAPI:

- Evento: `Contact`.
- `action_source`: `website`.
- Deduplicacion: usa el mismo `event_id` del browser.
- `event_source_url`: URL de landing.
- `user_data`: `fbp`, `fbc`, `client_ip_address`, `client_user_agent`.
- `custom_data`: owner, variante, CTA, fbclid, referrer, UTMs y WhatsApp URL.

No se manda telefono del jugador porque todavia no existe antes de WhatsApp.
El `Lead` real sigue entrando por `/whatsapp/intake`.

## Owner destino

```text
owner_key: luqui10:luqui10
owner_label: Lucas10
pagina: RdA
telefono: +5493516549344
```

## Desarrollo local

```powershell
$env:API_PORT='3010'
$env:LANDING_ENABLED='true'
$env:META_ENABLED='false'
$env:REPORT_WORKER_ENABLED='false'
npm start -- server
```

Abrir:

```text
http://127.0.0.1:3010/landing
```

## Publicacion temporal con Cloudflare Tunnel

```powershell
cloudflared tunnel --url http://127.0.0.1:3010 --no-autoupdate
```

Esto genera una URL `https://*.trycloudflare.com/landing`.
Es solo para QA: no tiene garantia de uptime y depende de que la PC y el proceso sigan activos.

## Deploy definitivo recomendado

Para que un push a GitHub actualice el front automaticamente, usar una de estas opciones:

- VPS con `git pull`, `npm run build` y restart por CI/CD.
- Render/Railway/Fly con deploy conectado al repo.
- Cloudflare Tunnel nombrado apuntando a un servicio persistente.
- Separar la landing en hosting estatico solo si se reemplaza `/landing/contact` por una API publica estable.

Repo actual:

```text
https://github.com/AEyeSecurity/scrap2.git
```

## Autodeploy desde GitHub

Estado validado el `2026-05-29`:

- Tarea programada Windows: `Megascrap Git AutoDeploy`.
- Frecuencia: cada 1 minuto.
- Script: `C:\ServerCIT\scripts\update_megascrap_from_main_if_new.ps1`.
- Deploy usado: `C:\ServerCIT\scripts\deploy_megascrap_from_main.ps1`.
- Fuente observada: `origin/main` del repo `https://github.com/AEyeSecurity/scrap2.git`.
- Estado ultimo deploy: `C:\ServerCIT\state\megascrap-last-deployed-sha.txt`.
- Logs: `C:\ServerCIT\logs\megascrap\autodeploy-YYYYMMDD.log`.

Funcionamiento:

- Si alguien pushea a `main` desde otra PC, la tarea hace `git fetch origin --prune`.
- Si `origin/main` cambio respecto del ultimo SHA desplegado, ejecuta el deploy productivo.
- El deploy crea una imagen Docker `scrap2:main-auto-<sha>` y reemplaza `scrap2-api`.
- El script usa un lock global para evitar ejecuciones solapadas.
- No es webhook instantaneo: el cambio deberia verse en el siguiente ciclo de 1 minuto, mas el tiempo de build/redeploy.
- Si el push se hizo desde el mismo ServerCIT y `local HEAD` ya coincide con `origin/main`, el script fuerza rebuild/redeploy cuando ese SHA todavia no esta marcado como desplegado.

Cache de frontend:

- El HTML de `/landing` se sirve con `cache-control: no-store`.
- CSS, JS e imagenes se referencian con `?v=<version-de-arranque>`.
- Cada deploy reinicia el proceso y cambia esa version, evitando que navegadores o Cloudflare mantengan assets viejos con el mismo nombre.

## Deploy productivo actual en ServerCIT

Estado validado el `2026-05-29`:

- URL productiva principal: `https://reydeases.imperial-support.com/landing`.
- URL productiva alternativa: `https://reydeasesluck.aeye.com.ar/landing`.
- URL tecnica alternativa: `https://apiscrap.mastercrmrl.com/landing`.
- Contenedor: `scrap2-api`.
- Imagen: `scrap2:main-auto-f3bb163`.
- Commit: `f3bb163 Document Rey de Ases production landing deploy`.
- Cloudflare Tunnel persistente: `Polo52` (`f1d4679b-5d4a-4528-b897-bc5f4868dd1b`).
- Origen local: `http://127.0.0.1:3000`.

Variables productivas locales agregadas en `.env.production`:

```env
LANDING_ENABLED=true
LANDING_ALLOWED_ORIGINS=https://apiscrap.mastercrmrl.com,https://reydeasesluck.aeye.com.ar,https://reydeases.imperial-support.com,https://reydeasesluck.com.ar,https://www.reydeasesluck.com.ar,https://reydeasesluck.mastercrmrl.com,https://landing.mastercrmrl.com,https://reydeasesluck.com,https://www.reydeasesluck.com
META_PIXEL_ID=2123208205169806
META_LANDING_ACTION_SOURCE=website
```

DNS/Cloudflare aplicado:

```text
Zone: aeye.com.ar
Record: reydeasesluck.aeye.com.ar
Type: CNAME
Target: f1d4679b-5d4a-4528-b897-bc5f4868dd1b.cfargotunnel.com
Proxy: ON
Tunnel origin: http://localhost:3000
```

DNS/Cloudflare principal aplicado:

```text
Zone: imperial-support.com
Record: reydeases.imperial-support.com
Type: CNAME
Target: f1d4679b-5d4a-4528-b897-bc5f4868dd1b.cfargotunnel.com
Proxy: ON
Tunnel origin: http://localhost:3000
```

Hostnames adicionales preparados a nivel backend pero pendientes de DNS/Cloudflare:

- `https://reydeasesluck.com.ar/landing`
- `https://www.reydeasesluck.com.ar/landing`
- `https://reydeasesluck.mastercrmrl.com/landing`
- `https://landing.mastercrmrl.com/landing`
- `https://reydeasesluck.com/landing`
- `https://www.reydeasesluck.com/landing`

Nota `reydeasesluck.com.ar`: validado el `2026-05-29` contra RDAP de NIC Argentina y DNS publico; el dominio no esta registrado/delegado y devuelve NXDOMAIN. Para usarlo hay que registrarlo en NIC Argentina, agregarlo como zona en Cloudflare, delegar los nameservers indicados por Cloudflare y crear el CNAME del tunnel.

Para activar cualquiera de esos hostnames hay que entrar al dashboard de Cloudflare con permisos sobre la zona y agregar un Public Hostname al tunnel `cloudflared-apiscrap`, apuntando a:

```text
http://localhost:3000
```

Si se usa un dominio nuevo como `reydeasesluck.com`, primero hay que registrar el dominio y sumarlo a Cloudflare. Luego crear `reydeasesluck.com` y `www.reydeasesluck.com` como hostnames del tunnel.

## QA ejecutado

```powershell
npm run build
npx vitest run tests/meta-conversions.test.ts tests/server.test.ts
```

Resultado:

- Build TypeScript: OK.
- Tests focales landing/CAPI/server: OK.
- QA visual mobile `390x844`: OK.
- QA visual mobile chico `360x640`: OK.
- CTA final verificado contra `wa.me/5493516549344`.
- Deploy Docker productivo: OK.
- `GET https://reydeases.imperial-support.com/landing`: OK.
- Assets/legales productivos en `reydeases.imperial-support.com`: OK.
- `POST https://reydeases.imperial-support.com/landing/contact`: OK, `tracked=true`.
- `GET https://reydeasesluck.aeye.com.ar/landing`: OK.
- Assets/legales productivos en `reydeasesluck.aeye.com.ar`: OK.
- `POST https://reydeasesluck.aeye.com.ar/landing/contact`: OK, `tracked=true`.
- `GET https://apiscrap.mastercrmrl.com/landing`: OK.
- Assets/legales productivos: OK.
- `POST https://apiscrap.mastercrmrl.com/landing/contact`: OK, `tracked=true`.

Nota: `npm test` completo tiene un fallo no relacionado en `tests/report-run-system.test.ts`, caso `retries a failed username and finishes the run without losing state`, que queda en `running` en vez de `completed`.

## Consideraciones Meta

- La landing incluye `18+`, juego responsable, privacidad y terminos.
- No promete ganancias ni resultados.
- El boton no muestra porcentaje de bono.
- Meta Pixel Helper debe mostrar `PageView` y `Contact`.
- Events Manager Test Events debe mostrar Browser + Server deduplicado para `Contact` cuando `META_PIXEL_ID`, `META_ENABLED`, `META_DATASET_ID` y `META_ACCESS_TOKEN` esten configurados.
