---
description: actualizar la rama del fork al VPS y redeployar OpenClaw con validaciones y recovery de build/proxy
---

# Workflow: actualizar `stable-custom` al VPS

Usa esta guía cuando quieras subir cambios de tu fork a GitHub y desplegarlos en tu VPS donde corre OpenClaw.

## Supuestos

- Repo local: `openclaw-plus`
- Rama a desplegar: `stable-custom`
- Host del VPS: `root@your-vps-host`
- Repo en el VPS: `/srv/openclaw`
- Clave GitHub del fork: `/path/to/github_deploy_key`
- Clave SSH del VPS: `/path/to/vps_ssh_key`
- Dominio del dashboard: `https://your-dashboard.example.com`
- Servicio principal: `openclaw-gateway`
- Proxy público: contenedor `openclaw-nginx`

## 1. Validar localmente antes de subir

Desde la raíz del repo local, corre:

```bash
pnpm build
```

Si falla, no despliegues todavía.

## 2. Hacer commit y push al fork

Haz commit solo de los archivos que quieras desplegar. En este repo se prefiere:

```bash
scripts/committer "Mensaje corto del cambio" <archivo1> <archivo2> ...
```

Luego empuja la rama usando la llave de GitHub del fork:

```bash
eval "$(ssh-agent -s)"
ssh-add /path/to/github_deploy_key
git push origin stable-custom
```

Verifica que el push termine con algo como:

```text
stable-custom -> stable-custom
```

## 3. Actualizar el checkout del VPS

Conéctate al VPS y actualiza el checkout remoto:

```bash
eval "$(ssh-agent -s)"
ssh-add /path/to/vps_ssh_key
ssh root@your-vps-host
```

Ya dentro del VPS:

```bash
cd /srv/openclaw
git fetch origin stable-custom
git checkout stable-custom
git reset --hard origin/stable-custom
```

Verifica la rama y el commit actual:

```bash
git branch --show-current
git rev-parse --short HEAD
```

## 4. Reconstruir y levantar el gateway

### Camino normal

Primero intenta la ruta normal:

```bash
cd /srv/openclaw
docker compose up -d --build openclaw-gateway
```

Después revisa el estado:

```bash
docker compose ps
```

## 5. Si el gateway sigue usando una imagen vieja

Si ves que el cambio no entra realmente, o si antes te apareció algo como `No services to build`, fuerza la reconstrucción de la imagen local:

```bash
cd /srv/openclaw
docker build -t openclaw:local .
docker compose up -d --force-recreate openclaw-gateway
```

## 6. Si el build falla por memoria (OOM)

Si durante `docker build` falla con algo como:

- `FATAL ERROR: Reached heap limit`
- `Allocation failed - JavaScript heap out of memory`
- `NODE_OPTIONS="--max-old-space-size=1024" pnpm build`

entonces usa este workaround solo en el VPS, sin modificar el repo:

```bash
cd /srv/openclaw
sed 's/max-old-space-size=1024/max-old-space-size=3072/g' Dockerfile | docker build -t openclaw:local -f - .
docker compose up -d --force-recreate openclaw-gateway
```

Esto recompila la misma imagen, pero con más memoria durante el build.

## 7. Verificar salud del gateway

Comprueba que el contenedor quede sano:

```bash
docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' openclaw-openclaw-gateway-1
```

Debe responder:

```text
healthy
```

También puedes revisar logs:

```bash
docker logs --tail 80 openclaw-openclaw-gateway-1
```

## 8. Si el sitio público responde `502`

A veces `openclaw-nginx` se queda apuntando a la IP anterior del contenedor del gateway después de recrearlo. El síntoma típico es:

- `https://your-dashboard.example.com/` responde `502`
- en logs de nginx aparece `connect() failed (113: Host is unreachable)`

En ese caso, reinicia el proxy:

```bash
docker restart openclaw-nginx
```

Luego valida de nuevo:

```bash
curl -I https://your-dashboard.example.com/
```

Debe responder `200`.

## 9. Validar el addon de forma correcta

Sin auth, este endpoint debe seguir respondiendo `401`, y eso es normal:

```bash
curl -I https://your-dashboard.example.com/__openclaw__/addons/mission-control/index.js
```

Para comprobar que el gateway sí acepta auth por header, prueba con tu token:

```bash
curl -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" -I https://your-dashboard.example.com/__openclaw__/addons/mission-control/index.js
```

Eso debe responder `200`.

## 10. Validación final en navegador

En el navegador:

1. abre `https://your-dashboard.example.com`
2. haz hard refresh
3. vuelve a abrir `Mission Control`

Si sigue fallando, revisa DevTools:

- Network: `__openclaw__/addons/mission-control/index.js`
- Console: errores de import dinámico

## 11. Diagnóstico rápido

### Caso A: `index.js` responde `401` en navegador

Probables causas:

- el loader viejo sigue cacheado
- el gateway viejo sigue corriendo
- no se reconstruyó `openclaw:local`

Acciones:

- hard refresh
- rebuild de imagen
- recreate de `openclaw-gateway`

### Caso B: el sitio responde `502`

Probable causa:

- `openclaw-nginx` sigue apuntando al upstream anterior

Acción:

```bash
docker restart openclaw-nginx
```

### Caso C: `Authorization` da `200`, pero el navegador falla igual

Probables causas:

- el frontend cacheado sigue viejo
- el bundle recién desplegado aún no estaba corriendo

Acciones:

- hard refresh
- incógnito
- confirmar que el gateway fue recreado con la imagen nueva

## 12. Comandos mínimos de referencia

### Push

```bash
eval "$(ssh-agent -s)"
ssh-add /path/to/github_deploy_key
git push origin stable-custom
```

### Update del VPS

```bash
eval "$(ssh-agent -s)"
ssh-add /path/to/vps_ssh_key
ssh root@your-vps-host
cd /srv/openclaw
git fetch origin stable-custom
git checkout stable-custom
git reset --hard origin/stable-custom
```

### Rebuild normal

```bash
docker compose up -d --build openclaw-gateway
```

### Rebuild forzado de imagen local

```bash
docker build -t openclaw:local .
docker compose up -d --force-recreate openclaw-gateway
```

### Rebuild con workaround de memoria

```bash
sed 's/max-old-space-size=1024/max-old-space-size=3072/g' Dockerfile | docker build -t openclaw:local -f - .
docker compose up -d --force-recreate openclaw-gateway
```

### Reparar `502`

```bash
docker restart openclaw-nginx
```
