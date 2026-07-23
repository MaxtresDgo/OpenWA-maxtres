#!/usr/bin/env node
/*
 * socks-relay.js — puente SOCKS5 local -> SOCKS5 con autenticacion.
 *
 * Chromium (el navegador de whatsapp-web.js) no puede autenticar proxies SOCKS.
 * microsocks en la Raspberry corre con usuario/contrasena. Este relay expone un
 * SOCKS5 SIN credenciales en 127.0.0.1 y reenvia cada conexion al proxy de la Pi
 * inyectando el usuario/contrasena. Node puro, sin dependencias.
 *
 *   node socks-relay.js --listen 127.0.0.1:1080 --upstream USER:PASS@100.104.50.91:1080
 */
'use strict';
const net = require('net');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--listen') a.listen = argv[++i];
    else if (argv[i] === '--upstream') a.upstream = argv[++i];
  }
  if (!a.listen || !a.upstream) {
    console.error('uso: node socks-relay.js --listen HOST:PORT --upstream USER:PASS@HOST:PORT');
    process.exit(2);
  }
  const [lHost, lPort] = a.listen.split(':');
  const at = a.upstream.lastIndexOf('@');
  const creds = a.upstream.slice(0, at);
  const hostport = a.upstream.slice(at + 1);
  const colon = creds.indexOf(':');
  const user = creds.slice(0, colon);
  const pass = creds.slice(colon + 1);
  const lastColon = hostport.lastIndexOf(':');
  const upHost = hostport.slice(0, lastColon);
  const upPort = parseInt(hostport.slice(lastColon + 1), 10);
  return { lHost, lPort: parseInt(lPort, 10), upHost, upPort, user, pass };
}

const cfg = parseArgs(process.argv);

function handleClient(client) {
  client.on('error', () => client.destroy());

  // 1) Saludo del cliente (Chromium): [0x05, nmethods, methods...]. Respondemos "sin auth".
  client.once('data', greeting => {
    if (greeting[0] !== 0x05) return client.destroy();
    client.write(Buffer.from([0x05, 0x00]));

    // 2) Peticion CONNECT del cliente: la reenviamos tal cual a la Pi tras autenticarnos alla.
    client.once('data', request => connectUpstream(client, request));
  });
}

function connectUpstream(client, request) {
  const up = net.connect(cfg.upPort, cfg.upHost, () => {
    // Ofrecemos user/pass (0x02) y tambien no-auth (0x00) por robustez.
    up.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
  });

  const fail = () => { client.destroy(); up.destroy(); };
  up.on('error', fail);
  client.on('error', fail);
  up.on('close', () => client.destroy());
  client.on('close', () => up.destroy());

  let stage = 'method';
  const onData = data => {
    if (stage === 'method') {
      if (data[0] !== 0x05) return fail();
      if (data[1] === 0x02) {
        const u = Buffer.from(cfg.user);
        const p = Buffer.from(cfg.pass);
        up.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        stage = 'auth';
      } else if (data[1] === 0x00) {
        goTransparent();
      } else {
        return fail(); // metodo no soportado
      }
    } else if (stage === 'auth') {
      // Respuesta a la autenticacion: [0x01, 0x00] = ok.
      if (data[0] !== 0x01 || data[1] !== 0x00) return fail();
      goTransparent();
    }
  };
  up.on('data', onData);

  function goTransparent() {
    up.removeListener('data', onData);
    up.pipe(client);
    client.pipe(up);
    up.write(request); // la peticion CONNECT original; la respuesta fluye por el pipe
    stage = 'pipe';
  }
}

const server = net.createServer(handleClient);
server.on('error', err => {
  console.error(`[relay] error del servidor: ${err.message}`);
  process.exit(1);
});
server.listen(cfg.lPort, cfg.lHost, () => {
  console.log(`[relay] SOCKS5 ${cfg.lHost}:${cfg.lPort}  ->  ${cfg.upHost}:${cfg.upPort} (auth como ${cfg.user})`);
});
