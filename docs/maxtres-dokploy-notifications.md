# Notificaciones de Dokploy a WhatsApp

Esta integración acepta el JSON que envía **Custom** de Dokploy, sin cambiar el body.
Reutiliza el envío de OpenWA y requiere una sesión de WhatsApp conectada y una clave
con rol **operator** o **admin**, autorizada para esa sesión. La cuenta debe pertenecer
al grupo y tener permiso para publicar en él.

## Configuración en Dokploy

En **Notifications → Custom**, configura:

- **Name:** `WhatsApp failed builds`
- **Webhook URL:** `https://openwa.example.com/api/integration/dokploy/ID_SESION/ID_GRUPO@g.us`
- **Header:** `X-API-Key` con el valor de una clave de OpenWA.
- **Header:** `Content-Type` con el valor `application/json`.
- **Actions:** activa únicamente **App Build Error**.

`ID_SESION` es el UUID de la sesión, no su nombre. Usa el ID completo del grupo,
incluido `@g.us`. Se puede obtener con `GET /api/sessions/ID_SESION/groups`.
Elimina cualquier header `Authentication: Credencial Header Auth`: no corresponde
a esta API. La clave viaja en el header; no la incluyas en la URL ni en Git.

Pulsa **Test** y comprueba que llega al grupo. También se acepta el payload mínimo
de prueba de Dokploy (`title`, `message`, `timestamp`). Después verifica un build
fallido en una aplicación de prueba. El endpoint envía cada notificación recibida;
la selección de eventos se hace en Dokploy.

Cloudflare Tunnel puede conservar la URL pública actual. Si el hostname además
está protegido con Cloudflare Access, el cliente debe presentar sus credenciales
de servicio de Access. El túnel por sí solo no exige esos headers.

## Mensajes y respuestas

El mensaje incluye título, descripción, proyecto, aplicación, enlace al build y
error, cuando están presentes. Se limita a 4096 caracteres, con el enlace antes
del error para conservar el acceso a los logs completos. La descripción usa sus
primeros 500 caracteres; el error de entrada admite hasta 65536 caracteres.

- `201`: OpenWA aceptó el envío y devuelve `messageId` y `timestamp`; no confirma lectura.
- `400`: payload o destinatario inválido. Solo se admiten grupos de WhatsApp.
- `401` / `403`: clave ausente, inválida o sin los permisos correspondientes.
- Los fallos de la sesión o del envío se devuelven al cliente; no se reportan como éxito.

Las claves de esta base de producción (v0.14.2) permiten limitar sesiones, pero no
grupos individuales. Usa una clave dedicada a la sesión de notificaciones. No hay
deduplicación: repetir un POST puede enviar otra notificación.

## Despliegue y reversión

La rama `feat/dokploy-notifications` parte del commit
`831bfa5800bf81744a1c1b830915b4558375d47a` (v0.14.2), identificado en el historial
de despliegues de Dokploy y coincidente con la versión de la instancia. Esto
conserva la base desplegada y evita actualizar a v0.26.0 como efecto de esta integración.

Selecciona la nueva rama en el servicio Compose **OpenWA**, guarda y despliega.
El Compose construye la imagen desde el repositorio con su Dockerfile. No requiere
cambios de variables, nuevas dependencias ni migraciones de base de datos.
Conserva los volúmenes existentes; no uses **Fresh Volumes**.

Para revertir, despliega el commit de base indicado arriba. No vuelvas a `main`
como reversión: actualmente contiene una actualización a v0.26.0. Las sesiones y
los datos permanecen en los mismos volúmenes.

## Dependencias de la base

La auditoría del lockfile heredado, realizada el 29 de octubre de 2026, reportó
104 alertas altas y 6 críticas en el árbol completo, incluidas herramientas de
desarrollo. Esta integración no añade dependencias ni modifica el lockfile.
La actualización y clasificación por exposición de esas dependencias queda
pendiente como trabajo independiente, con revisión prevista para el 30 de octubre
de 2026; este despliegue no debe interpretarse como una auditoría de seguridad aprobada.
