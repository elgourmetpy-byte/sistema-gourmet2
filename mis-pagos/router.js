// ════════════════════════════════════════════════════════════════
// Mis Pagos — servidor (se monta en /pagos dentro del servidor del
// Sistema Gourmet, pero con datos y PIN totalmente separados).
//
// Guarda todo en DATA_DIR/mis-pagos-datos/:
//   estado.json         pagos, registros, personal
//   respaldos/          una copia por día (se guardan 90 días)
//   acceso.json         PIN (encriptado) y sesiones abiertas
//   push.json           celulares suscriptos a los avisos
//   vapid.json          claves para mandar notificaciones (se crean solas)
// ════════════════════════════════════════════════════════════════
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const L = require("./public/logica.js");

let webpush = null;
try { webpush = require("web-push"); }
catch (e) { console.warn("[Mis Pagos] falta el paquete web-push: la app anda, pero sin notificaciones"); }

const ZONA = "America/Asuncion";
const HORA_AVISO = 8;            // a partir de las 8 de la mañana
const DIAS_DE_RESPALDO = 90;
const CONTACTO_PUSH = "https://sistema-gourmet2.onrender.com";

module.exports = function crearMisPagos({ dataDir, revisarCadaMs = 10 * 60 * 1000 } = {}) {
  const DIR = path.join(dataDir, "mis-pagos-datos");
  const DIR_RESPALDOS = path.join(DIR, "respaldos");
  fs.mkdirSync(DIR_RESPALDOS, { recursive: true });
  const ARCH = {
    estado: path.join(DIR, "estado.json"),
    acceso: path.join(DIR, "acceso.json"),
    push: path.join(DIR, "push.json"),
    vapid: path.join(DIR, "vapid.json"),
  };

  const leerJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return def; } };
  const escribirJSON = (f, obj) => { const tmp = f + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, f); };
  const hoy = () => L.hoyEnZona(ZONA);

  // ── Estado ──────────────────────────────────────────────────────
  function cargarEstado() {
    if (!fs.existsSync(ARCH.estado)) {
      const e = L.semilla(hoy());
      escribirJSON(ARCH.estado, e);
      console.log("[Mis Pagos] primera vez: se cargaron los pagos iniciales");
      return e;
    }
    const e = leerJSON(ARCH.estado, null);
    if (L.esEstadoValido(e)) return e;
    // Archivo dañado: NUNCA volver a empezar de cero, usar el último respaldo.
    const ultimos = fs.readdirSync(DIR_RESPALDOS).filter((f) => f.endsWith(".json")).sort().reverse();
    for (const f of ultimos) {
      const r = leerJSON(path.join(DIR_RESPALDOS, f), null);
      if (L.esEstadoValido(r)) { console.error(`[Mis Pagos] estado.json dañado, se recuperó ${f}`); return r; }
    }
    throw new Error("[Mis Pagos] estado.json dañado y sin respaldos válidos — revisar a mano");
  }
  let estado = cargarEstado();

  function guardarEstado() {
    escribirJSON(ARCH.estado, estado);
    const resp = path.join(DIR_RESPALDOS, `estado-${hoy()}.json`);
    // La copia del día se va pisando durante el día: queda la última versión de cada día.
    escribirJSON(resp, estado);
    const viejos = fs.readdirSync(DIR_RESPALDOS).filter((f) => f.endsWith(".json")).sort();
    while (viejos.length > DIAS_DE_RESPALDO) fs.unlinkSync(path.join(DIR_RESPALDOS, viejos.shift()));
  }

  // ── PIN y sesiones ──────────────────────────────────────────────
  let acceso = leerJSON(ARCH.acceso, { pin: null, sesiones: [] });
  const hashPin = (pin, sal) => crypto.scryptSync(String(pin), sal, 32).toString("hex");
  const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
  const pinValido = (pin) => /^\d{4,6}$/.test(String(pin || ""));
  function pinCorrecto(pin) {
    if (!acceso.pin) return false;
    const a = Buffer.from(hashPin(pin, acceso.pin.sal), "hex"), b = Buffer.from(acceso.pin.hash, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function abrirSesion() {
    const token = crypto.randomBytes(24).toString("hex");
    acceso.sesiones.push({ h: hashToken(token), creada: Date.now() });
    acceso.sesiones = acceso.sesiones.slice(-20);
    escribirJSON(ARCH.acceso, acceso);
    return token;
  }
  function exigirSesion(req, res, next) {
    const h = hashToken(req.get("X-Token") || "");
    if (!acceso.sesiones.some((s) => s.h === h)) return res.status(401).json({ error: "Entrá con tu PIN" });
    req.tokenHash = h;
    next();
  }
  const intentos = new Map(); // ip -> [tiempos]
  function demasiadosIntentos(ip) {
    const ahora = Date.now();
    const lista = (intentos.get(ip) || []).filter((t) => ahora - t < 15 * 60 * 1000);
    intentos.set(ip, lista);
    return lista.length >= 10;
  }
  const anotarIntento = (ip) => intentos.get(ip).push(Date.now());

  // ── Notificaciones ──────────────────────────────────────────────
  let push = leerJSON(ARCH.push, { suscripciones: [], ultimoAviso: null });
  let vapid = null;
  if (webpush) {
    vapid = leerJSON(ARCH.vapid, null);
    if (!vapid) { vapid = webpush.generateVAPIDKeys(); escribirJSON(ARCH.vapid, vapid); }
    webpush.setVapidDetails(CONTACTO_PUSH, vapid.publicKey, vapid.privateKey);
  }
  async function enviarATodos(mensaje) {
    if (!webpush) return { enviados: 0, error: "sin web-push" };
    let enviados = 0;
    const vivas = [];
    for (const s of push.suscripciones) {
      try {
        await webpush.sendNotification(s.sub, JSON.stringify(mensaje), { TTL: 12 * 3600 });
        enviados++; vivas.push(s);
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) continue; // el celular la dio de baja
        console.error("[Mis Pagos] no se pudo avisar:", e.statusCode || e.message);
        vivas.push(s);
      }
    }
    push.suscripciones = vivas;
    escribirJSON(ARCH.push, push);
    return { enviados };
  }
  async function revisarAvisos() {
    const dia = hoy();
    if (push.ultimoAviso === dia || L.horaEnZona(ZONA) < HORA_AVISO) return null;
    push.ultimoAviso = dia;
    escribirJSON(ARCH.push, push);
    const txt = L.textoAviso(L.avisosDelDia(estado, dia));
    if (!txt || !push.suscripciones.length) return null;
    return enviarATodos({ titulo: txt.titulo, cuerpo: txt.cuerpo, url: "./", tag: "avisos-" + dia });
  }
  if (revisarCadaMs > 0) {
    setTimeout(() => revisarAvisos().catch((e) => console.error("[Mis Pagos]", e)), 30 * 1000).unref();
    setInterval(() => revisarAvisos().catch((e) => console.error("[Mis Pagos]", e)), revisarCadaMs).unref();
  }

  // ── Rutas ───────────────────────────────────────────────────────
  const r = express.Router();
  r.use(express.json({ limit: "5mb" }));

  // "/pagos" → "/pagos/" (si no, el navegador busca los archivos en la raíz)
  r.get("/", (req, res, next) => {
    if (!req.originalUrl.split("?")[0].endsWith("/")) return res.redirect(301, req.baseUrl + "/");
    next();
  });

  r.get("/api/acceso", (req, res) => res.json({ tienePin: !!acceso.pin }));

  r.post("/api/crear-pin", (req, res) => {
    if (acceso.pin) return res.status(409).json({ error: "Ya hay un PIN. Entrá con ese." });
    if (!pinValido(req.body.pin)) return res.status(400).json({ error: "El PIN tiene que ser de 4 a 6 números" });
    const sal = crypto.randomBytes(16).toString("hex");
    acceso.pin = { sal, hash: hashPin(req.body.pin, sal) };
    res.json({ token: abrirSesion() });
  });

  r.post("/api/entrar", (req, res) => {
    const ip = req.ip;
    if (demasiadosIntentos(ip)) return res.status(429).json({ error: "Muchos intentos. Esperá 15 minutos." });
    if (!pinCorrecto(req.body.pin)) { anotarIntento(ip); return res.status(401).json({ error: "PIN incorrecto" }); }
    res.json({ token: abrirSesion() });
  });

  r.post("/api/cambiar-pin", exigirSesion, (req, res) => {
    if (!pinCorrecto(req.body.actual)) return res.status(401).json({ error: "El PIN actual no es correcto" });
    if (!pinValido(req.body.nuevo)) return res.status(400).json({ error: "El PIN nuevo tiene que ser de 4 a 6 números" });
    const sal = crypto.randomBytes(16).toString("hex");
    acceso.pin = { sal, hash: hashPin(req.body.nuevo, sal) };
    // Cierra todas las otras sesiones (por si un celular se perdió)
    acceso.sesiones = acceso.sesiones.filter((s) => s.h === req.tokenHash);
    escribirJSON(ARCH.acceso, acceso);
    res.json({ ok: true });
  });

  r.post("/api/salir", exigirSesion, (req, res) => {
    acceso.sesiones = acceso.sesiones.filter((s) => s.h !== req.tokenHash);
    escribirJSON(ARCH.acceso, acceso);
    res.json({ ok: true });
  });

  r.get("/api/estado", exigirSesion, (req, res) => res.json({ estado }));

  // El celular manda todo lo que tiene; se junta con lo del servidor por ítem
  // (gana el cambio más nuevo) y se le devuelve el resultado.
  r.post("/api/estado", exigirSesion, (req, res) => {
    const entrante = req.body && req.body.estado;
    if (!L.esEstadoValido(entrante)) return res.status(400).json({ error: "Datos inválidos" });
    const antes = JSON.stringify(estado);
    estado = L.fusionarEstado(estado, entrante);
    if (JSON.stringify(estado) !== antes) {
      try { guardarEstado(); }
      catch (e) { console.error("[Mis Pagos] error al guardar:", e); return res.status(500).json({ error: "No se pudo guardar" }); }
    }
    res.json({ estado });
  });

  r.get("/api/push/clave", exigirSesion, (req, res) => {
    if (!vapid) return res.status(503).json({ error: "Notificaciones no disponibles en el servidor" });
    res.json({ clave: vapid.publicKey });
  });
  r.post("/api/push/suscribir", exigirSesion, (req, res) => {
    const sub = req.body && req.body.sub;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: "Suscripción inválida" });
    push.suscripciones = push.suscripciones.filter((s) => s.sub.endpoint !== sub.endpoint);
    push.suscripciones.push({ sub, creada: Date.now() });
    escribirJSON(ARCH.push, push);
    res.json({ ok: true });
  });
  r.post("/api/push/probar", exigirSesion, async (req, res) => {
    const txt = L.textoAviso(L.avisosDelDia(estado, hoy()));
    const r2 = await enviarATodos({
      titulo: "🔔 Prueba de Mis Pagos",
      cuerpo: txt ? txt.cuerpo : "Los avisos funcionan. Hoy no vence nada en los próximos 2 días.",
      url: "./", tag: "prueba",
    });
    res.json(r2);
  });

  r.use(express.static(path.join(__dirname, "public"), {
    setHeaders: (res, archivo) => {
      if (/\.(html|js|webmanifest)$/.test(archivo)) res.setHeader("Cache-Control", "no-cache");
    },
  }));

  r._interno = { revisarAvisos, get estado() { return estado; }, get push() { return push; } };
  return r;
};
