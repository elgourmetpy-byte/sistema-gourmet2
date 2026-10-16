// ═══════════════════════════════════════════════════════
// SERVIDOR — El Gourmet / Sistema Gourmet
// Este es el "cuaderno mágico" compartido: guarda toda la
// información del restaurante en un solo lugar y se la
// reparte a todos los dispositivos conectados (notebook,
// tablets, celulares).
//
// CAMBIOS respecto a la versión anterior (servr.js):
//  1. Los guardados ya no reemplazan un pedido/mesa entero:
//     cada dispositivo manda solo lo que efectivamente tocó
//     ("dirty") y el servidor lo combina con lo que ya había,
//     sin pisar lo que otro dispositivo guardó mientras tanto.
//     Ver aplicarCambios() más abajo.
//  2. Los datos se guardan en DATA_DIR (configurable por variable
//     de entorno). Si en Render se monta un Disco persistente ahí,
//     los pedidos sobreviven a reinicios y redeploys. Sin esa
//     variable, se guarda en la carpeta del proyecto (sirve para
//     probar en la compu, pero en Render se perdería igual).
//  3. Escritura atómica (archivo temporal + rename) para que un
//     corte de luz a mitad de un guardado no deje el archivo roto.
//  4. Auditoría: cada guardado deja un renglón en auditoria.log con
//     quién, cuándo y qué cambió.
//  5. Copias de respaldo periódicas por si hay que volver atrás a mano.
// ═══════════════════════════════════════════════════════
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Dónde se guardan los datos ──────────────────────────
// IMPORTANTE: en Render, un "Web Service" sin Disco agregado NO
// conserva archivos entre reinicios/redeploys, sin importar el plan
// que se pague. Para que esto sea permanente hay que:
//   1. En el dashboard de Render → el servicio → "Disks" → Add Disk.
//   2. Mount Path, por ejemplo: /data
//   3. Variable de entorno DATA_DIR = /data
// Instrucciones completas en README-DESPLIEGUE.md.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, "data.json");
const AUDIT_FILE = path.join(DATA_DIR, "auditoria.log");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

app.use(express.json({ limit: "5mb" }));
// Render pone un intermediario adelante: así req.ip es la IP real del dispositivo.
app.set("trust proxy", 1);

// ── Traba de acceso: hay que entrar con usuario y PIN ───
// ⚠️ ARREGLO oct-2026 (robo de tablets): antes cualquiera que conociera
// la dirección del sistema podía leer y modificar TODO (mesas, ventas,
// clientes, y hasta la lista de usuarios con sus PIN) sin ningún login.
// El login con PIN existía solo en la pantalla; el servidor no lo pedía.
// (La clave fija APP_SECRET de set-2026 no servía: quedaba escrita en
// index.html, que cualquiera puede descargar.)
// Ahora el servidor es el que controla:
//  - /api/login recibe usuario + PIN, los compara con la lista de
//    usuarios guardada y, si están bien, le da una "llave" (token) a
//    ese dispositivo.
//  - /api/state (leer y guardar) solo responde con una llave válida en
//    el encabezado "X-Sesion".
//  - La llave queda atada al PIN con que se entró: si después se cambia
//    el PIN de ese usuario, TODAS sus llaves viejas dejan de servir (una
//    tablet robada queda afuera apenas se cambia el PIN). El dispositivo
//    que hizo el cambio sigue adentro.
//  - Muchos PIN equivocados seguidos bloquean el login por 15 minutos.
const crypto = require("crypto");
const SESIONES_FILE = path.join(DATA_DIR, "sesiones.json");
const hashPin = (pin) => crypto.createHash("sha256").update("gourmet:" + String(pin)).digest("hex");

let sesiones = {};
try { sesiones = JSON.parse(fs.readFileSync(SESIONES_FILE, "utf8")) || {}; } catch (e) { sesiones = {}; }
let colaSesiones = Promise.resolve();
function guardarSesiones() {
  colaSesiones = colaSesiones
    .then(() => fs.promises.writeFile(SESIONES_FILE, JSON.stringify(sesiones)))
    .catch(e => console.error("No se pudieron guardar las sesiones:", e.message));
  return colaSesiones;
}

function usuariosGuardados() {
  const u = estado && estado.data && estado.data.usuarios;
  return Array.isArray(u) && u.length ? u : null;
}

// La sesión, si la llave existe y el PIN de ese usuario no cambió desde que entró.
function sesionValida(token) {
  if (!token || typeof token !== "string") return null;
  const s = sesiones[token];
  if (!s) return null;
  const u = (usuariosGuardados() || []).find(x => x && x.id === s.userId);
  if (!u || hashPin(u.pin) !== s.pinHash) return null;
  return s;
}

function exigirSesion(req, res, next) {
  // Sistema recién instalado, sin usuarios todavía en el servidor: no hay
  // contra qué validar, se deja pasar (igual que antes).
  if (!usuariosGuardados()) return next();
  const token = req.headers["x-sesion"];
  const s = sesionValida(token);
  if (!s) return res.status(401).json({ error: "sesion" });
  req.sesion = { token, userId: s.userId };
  next();
}

// Freno a quien prueba PIN al azar: máx. 10 errores por conexión y 30 por
// usuario cada 15 minutos.
const intentosFallidos = new Map();
const VENTANA_INTENTOS = 15 * 60 * 1000;
function demasiadosIntentos(clave, max) {
  const ahora = Date.now();
  const lista = (intentosFallidos.get(clave) || []).filter(t => ahora - t < VENTANA_INTENTOS);
  intentosFallidos.set(clave, lista);
  return lista.length >= max;
}
function anotarFallo(clave) {
  const lista = intentosFallidos.get(clave) || [];
  lista.push(Date.now());
  intentosFallidos.set(clave, lista);
}

// ── Página principal del sistema ────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ── Cargar lo último guardado en disco (si existe) ──────
function cargarEstado() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const est = JSON.parse(raw);
    if (!est || typeof est !== "object") throw new Error("formato inválido");
    if (!est.data || typeof est.data !== "object") est.data = {};
    if (typeof est.rev !== "number") est.rev = 0;
    return est;
  } catch (e) {
    return { rev: 0, data: {} };
  }
}

// Escritura atómica: primero a un archivo temporal, y recién cuando
// terminó bien se reemplaza el archivo real (rename es una operación
// instantánea). Así, si la PC se apaga o Render reinicia el proceso a
// mitad de un guardado, nunca queda un data.json a medio escribir.
//
// IMPORTANTE: usamos las versiones ASÍNCRONAS de fs (fs.promises), no
// las "Sync". Las versiones "Sync" congelan TODO el servidor mientras
// escriben — ninguna otra tablet puede recibir respuesta mientras
// tanto. Con archivos chicos no se nota, pero cuando el restaurante
// tiene muchos pedidos acumulados, esa pausa se hace larga y una
// tablet que se está por conectar se queda con la pantalla de
// "Cargando..." trabada hasta que termina el guardado de la otra.
//
// `colaGuardado` encadena los guardados uno atrás de otro (nunca dos
// al mismo tiempo, para no pisarse), pero sin bloquear el servidor
// mientras cada uno ocurre.
let colaGuardado = Promise.resolve();
function guardarEstado(estado) {
  colaGuardado = colaGuardado
    .then(async () => {
      const tmp = DATA_FILE + ".tmp";
      await fs.promises.writeFile(tmp, JSON.stringify(estado));
      await fs.promises.rename(tmp, DATA_FILE);
    })
    .catch(e => console.error("No se pudo guardar en disco:", e.message));
  return colaGuardado;
}

// Cada 100 guardados dejamos una copia de respaldo con fecha, por si
// algún día hay que volver atrás a mano. Se conservan como máximo 20.
let guardadosDesdeBackup = 0;
function backupPeriodico(estado) {
  guardadosDesdeBackup++;
  if (guardadosDesdeBackup < 100) return;
  guardadosDesdeBackup = 0;
  colaGuardado = colaGuardado
    .then(async () => {
      const nombre = `data.${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      await fs.promises.writeFile(path.join(BACKUP_DIR, nombre), JSON.stringify(estado));
      const viejos = (await fs.promises.readdir(BACKUP_DIR)).filter(f => f.startsWith("data.")).sort();
      while (viejos.length > 20) await fs.promises.unlink(path.join(BACKUP_DIR, viejos.shift()));
    })
    .catch(e => console.error("No se pudo hacer backup:", e.message));
  return colaGuardado;
}

function registrarAuditoria(entrada) {
  fs.promises.appendFile(AUDIT_FILE, JSON.stringify(entrada) + "\n").catch(() => {
    // la auditoría nunca debe tumbar un guardado real
  });
}

let estado = cargarEstado();

// ═══════════════════════════════════════════════════════
// EL CORAZÓN DEL ARREGLO
// En vez de que cada guardado reemplace un array entero (mesas,
// pedidosDelivery, clientes, etc.), el cliente manda SOLO los ítems
// que efectivamente creó/modificó (upsert) o borró explícitamente
// (del), identificados por su "id". Acá se combinan con lo que ya
// había, así un dispositivo nunca pisa lo que otro guardó y todavía
// no vio.
//
// Los ítems que un dispositivo no menciona quedan exactamente como
// estaban: un pedido no puede desaparecer si nadie mandó su id en
// "del".
// ═══════════════════════════════════════════════════════
// ⚠️ ARREGLO set-2026 (mesa cobrada dos veces — Patio 2, 26/9):
// Una mesa que ya se cobró y quedó "libre" NO puede volver a aparecer
// ocupada con el MISMO pedido porque un dispositivo con una foto vieja
// la reenvió. Al cerrar, la mesa guarda en "cerrada" la marca de la
// sesión que se cerró (sesion, o la hora de apertura en mesas viejas).
// Si llega esa misma sesión otra vez, se descarta: para volver a ocupar
// la mesa hay que abrirla de nuevo (eso genera una sesión nueva).
const claveSesionMesa = (m) => (m && (m.sesion || m.hora)) || null;
function esMesaRevivida(actual, entrante) {
  if (!actual || !entrante) return false;
  if (actual.estado !== "libre" || !actual.cerrada) return false;
  if (entrante.estado === "libre") return false;
  return claveSesionMesa(entrante) === actual.cerrada;
}

function aplicarCambios(dataPrevia, dirty, scalars) {
  const data = { ...dataPrevia };
  const resumen = [];
  const rechazados = [];

  for (const [clave, cambios] of Object.entries(dirty || {})) {
    if (!cambios || typeof cambios !== "object") continue;
    const actual = Array.isArray(data[clave]) ? data[clave] : [];
    const porId = new Map(actual.filter(it => it && it.id !== undefined).map(it => [it.id, it]));
    const upsert = Array.isArray(cambios.upsert) ? cambios.upsert : [];
    const del = Array.isArray(cambios.del) ? cambios.del : [];
    upsert.forEach(it => {
      if (!it || it.id === undefined) return;
      if (clave === "mesas" && esMesaRevivida(porId.get(it.id), it)) {
        rechazados.push(it.id);
        return;
      }
      porId.set(it.id, it);
    });
    del.forEach(id => porId.delete(id));
    let fusion = Array.from(porId.values());
    // Si todos los ids son numéricos (Date.now(), como usa casi todo
    // el sistema), lo más nuevo primero — así listas como "ventas" o
    // "log" no cambian de orden al fusionarse.
    if (fusion.length && fusion.every(it => typeof it.id === "number")) {
      fusion = fusion.sort((a, b) => b.id - a.id);
    }
    data[clave] = fusion;
    if (upsert.length || del.length) {
      resumen.push(`${clave}: +${upsert.length}/-${del.length}`);
    }
  }

  for (const [clave, valor] of Object.entries(scalars || {})) {
    data[clave] = valor;
    resumen.push(`${clave}: actualizado`);
  }

  if (rechazados.length) {
    resumen.push(`mesas ya cobradas que se intentaron revivir (descartado): ${rechazados.join(", ")}`);
  }
  return { data, resumen, rechazados };
}

// ── Entrar con usuario y PIN ────────────────────────────
app.post("/api/login", (req, res) => {
  const { usuario, pin } = req.body || {};
  const lista = usuariosGuardados();
  // Sin usuarios en el servidor (sistema nuevo): la pantalla usa su lista
  // de fábrica y no hace falta llave.
  if (!lista) return res.json({ sinUsuarios: true });
  const claveIp = "ip:" + req.ip;
  const claveUsr = "u:" + String(usuario || "").toLowerCase();
  if (demasiadosIntentos(claveIp, 10) || demasiadosIntentos(claveUsr, 30)) {
    return res.status(429).json({ error: "Demasiados intentos. Esperá 15 minutos." });
  }
  const u = lista.find(x => x && x.usuario === usuario && String(x.pin) === String(pin));
  if (!u) {
    anotarFallo(claveIp); anotarFallo(claveUsr);
    registrarAuditoria({ hora: new Date().toISOString(), login: "fallido", usuario: String(usuario || ""), ip: req.ip });
    return res.status(401).json({ error: "Usuario o PIN incorrecto" });
  }
  const token = crypto.randomBytes(24).toString("hex");
  sesiones[token] = { userId: u.id, pinHash: hashPin(u.pin), creado: new Date().toISOString(), ip: req.ip };
  // No acumular llaves para siempre: se conservan las 300 más nuevas.
  const tokens = Object.keys(sesiones);
  if (tokens.length > 300) {
    tokens.sort((a, b) => String(sesiones[a].creado).localeCompare(String(sesiones[b].creado)))
      .slice(0, tokens.length - 300).forEach(t => delete sesiones[t]);
  }
  guardarSesiones();
  registrarAuditoria({ hora: new Date().toISOString(), login: "ok", usuario: u.nombre, rol: u.rol, ip: req.ip });
  res.json({ token, usuario: { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol } });
});

// ── Salir: la llave de este dispositivo deja de servir ──
app.post("/api/logout", (req, res) => {
  const token = req.headers["x-sesion"];
  if (token && sesiones[token]) { delete sesiones[token]; guardarSesiones(); }
  res.json({ ok: true });
});

// ── El sistema pide los datos compartidos ───────────────
app.get("/api/state", exigirSesion, (req, res) => {
  res.json(estado);
});

// ── El sistema guarda cambios nuevos ────────────────────
app.post("/api/state", exigirSesion, async (req, res) => {
  const body = req.body || {};
  const origen = body.origen || {};
  let resumen = [];
  let rechazados = [];

  if (body.dirty || body.scalars) {
    // Protocolo nuevo: el cliente manda solo lo que efectivamente cambió.
    const r = aplicarCambios(estado.data, body.dirty, body.scalars);
    estado = { rev: estado.rev + 1, data: r.data };
    resumen = r.resumen;
    rechazados = r.rechazados;
    if (rechazados.length) console.warn(`[sync] Se descartó revivir mesas ya cobradas: ${rechazados.join(", ")} (${origen.usuario || "?"})`);
  } else if (body.data) {
    // Protocolo viejo (compatibilidad hacia atrás): un dispositivo con
    // la pantalla vieja todavía en el navegador (sin refrescar) manda
    // el bloque entero. Se acepta para no cortarle el servicio a nadie,
    // pero puede pisar cambios de otro dispositivo — por eso conviene
    // que, después de este despliegue, cada tablet/PC se refresque una
    // vez (F5 o cerrar y volver a abrir el navegador).
    console.warn("[sync] Aviso: un dispositivo mandó el protocolo viejo (pantalla sin refrescar).");
    estado = { rev: estado.rev + 1, data: { ...estado.data, ...body.data } };
    resumen = ["(protocolo viejo: reemplazo completo — conviene refrescar ese dispositivo)"];
  } else {
    return res.status(400).json({ error: "cuerpo inválido" });
  }

  // Estas tres esperan a que el guardado en disco realmente termine
  // (para no responder "ok" antes de que el dato esté a salvo), pero
  // como ahora son asíncronas, el servidor puede seguir atendiendo a
  // otras tablets mientras tanto — ya no se congela nadie más.
  // Si quien guardó cambió su PROPIO PIN, su llave se actualiza para que
  // no lo saque del sistema (las llaves de otros dispositivos con el PIN
  // viejo sí dejan de servir).
  if (req.sesion && sesiones[req.sesion.token]) {
    const u = (usuariosGuardados() || []).find(x => x && x.id === req.sesion.userId);
    if (u && hashPin(u.pin) !== sesiones[req.sesion.token].pinHash) {
      sesiones[req.sesion.token].pinHash = hashPin(u.pin);
      guardarSesiones();
    }
  }

  await guardarEstado(estado);
  await backupPeriodico(estado);
  registrarAuditoria({
    hora: new Date().toISOString(),
    rev: estado.rev,
    usuario: origen.usuario || null,
    rol: origen.rol || null,
    ip: req.ip,
    cambios: resumen,
  });
  res.json(rechazados.length ? { ...estado, rechazados } : estado);
});

// ═══════════════════════════════════════════════════════
// BUZÓN DE IMPRESIÓN
// Las tablets y la PC dejan acá el texto de cada comanda.
// El Agente de Impresión que corre en la PC del local lo
// retira cada pocos segundos y lo manda a la impresora.
// Se guarda solo en memoria: si el servidor se reinicia,
// las comandas viejas se descartan (ya no sirven).
// ═══════════════════════════════════════════════════════
let colaImpresion = [];
let proximoJobId = 1;

app.post("/api/print-jobs", (req, res) => {
  const texto = (req.body && req.body.texto) || "";
  if (!String(texto).trim()) return res.status(400).json({ error: "texto vacío" });
  // origen: rol de quien pidió la impresión (mozo, cajero, dueno, etc.)
  // — lo usa el Agente de Impresión para elegir a qué impresora mandarlo.
  const origen = (req.body && req.body.origen) || "";
  const job = { id: proximoJobId++, texto: String(texto), origen: String(origen), creado: new Date().toISOString() };
  colaImpresion.push(job);
  if (colaImpresion.length > 200) colaImpresion = colaImpresion.slice(-200);
  res.json({ ok: true, id: job.id });
});

// ── Candado del agente (oct-2026) ──────────────────────
// Antes CUALQUIER programa podía retirar comandas del buzón. Apareció un
// segundo agente (en otro aparato del local) que se llevaba las mismas
// comandas que el de la caja → salían en las dos impresoras a la vez.
// Ahora el agente manda su llave en "X-Agente". La PRIMERA llave que
// llega queda anotada en DATA_DIR/agente-impresion.json y desde ahí solo
// esa puede retirar comandas; cualquier otro agente (o uno viejo sin
// llave) recibe 401 y no imprime nada. Para cambiar de PC: el dueño
// llama a POST /api/print-agent/reset con su sesión, y el próximo agente
// que se conecte queda como el nuevo autorizado.
const AGENTE_FILE = path.join(DATA_DIR, "agente-impresion.json");
const hashLlave = (k) => crypto.createHash("sha256").update("agente:" + String(k)).digest("hex");
let agenteAutorizado = null;
try { agenteAutorizado = JSON.parse(fs.readFileSync(AGENTE_FILE, "utf8")).llave || null; } catch (e) { agenteAutorizado = null; }

function exigirAgente(req, res, next) {
  const llave = req.headers["x-agente"];
  if (!llave || typeof llave !== "string" || llave.length < 16) return res.status(401).json({ error: "agente" });
  const h = hashLlave(llave);
  if (!agenteAutorizado) {
    agenteAutorizado = h;
    fs.promises.writeFile(AGENTE_FILE, JSON.stringify({ llave: h, desde: new Date().toISOString(), ip: req.ip }))
      .catch(e => console.error("No se pudo guardar la llave del agente:", e.message));
    console.log(`[impresion] Agente autorizado desde ${req.ip}`);
  } else if (h !== agenteAutorizado) {
    return res.status(401).json({ error: "agente" });
  }
  next();
}

app.post("/api/print-agent/reset", exigirSesion, (req, res) => {
  const u = (usuariosGuardados() || []).find(x => x && req.sesion && x.id === req.sesion.userId);
  if (usuariosGuardados() && (!u || u.rol !== "dueno")) return res.status(403).json({ error: "solo dueño" });
  agenteAutorizado = null;
  fs.promises.unlink(AGENTE_FILE).catch(() => {});
  res.json({ ok: true });
});

app.get("/api/print-jobs", exigirAgente, (req, res) => {
  res.json({ jobs: colaImpresion });
});

app.post("/api/print-jobs/:id/done", exigirAgente, (req, res) => {
  const id = Number(req.params.id);
  colaImpresion = colaImpresion.filter(j => j.id !== id);
  res.json({ ok: true, pendientes: colaImpresion.length });
});

// ── Para saber si el servidor está vivo ─────────────────
app.get("/health", (req, res) => res.send("ok"));

// ── Mis Pagos (pagos de la casa y del local) ────────────
// App aparte que vive en /pagos, con su propio PIN y sus datos en
// DATA_DIR/mis-pagos-datos. Si algo falla al cargarla, el sistema sigue igual.
try {
  app.use("/pagos", require("./mis-pagos/router")({ dataDir: DATA_DIR }));
} catch (e) {
  console.error("Mis Pagos no se pudo cargar:", e.message);
}

module.exports = { app, aplicarCambios, DATA_FILE };

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Sistema Gourmet escuchando en el puerto ${PORT} (datos en ${DATA_FILE})`);
  });
}
