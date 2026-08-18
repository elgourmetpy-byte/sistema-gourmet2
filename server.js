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
function guardarEstado(estado) {
  try {
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(estado));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error("No se pudo guardar en disco:", e.message);
  }
}

// Cada 100 guardados dejamos una copia de respaldo con fecha, por si
// algún día hay que volver atrás a mano. Se conservan como máximo 20.
let guardadosDesdeBackup = 0;
function backupPeriodico(estado) {
  guardadosDesdeBackup++;
  if (guardadosDesdeBackup < 100) return;
  guardadosDesdeBackup = 0;
  try {
    const nombre = `data.${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    fs.writeFileSync(path.join(BACKUP_DIR, nombre), JSON.stringify(estado));
    const viejos = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith("data.")).sort();
    while (viejos.length > 20) fs.unlinkSync(path.join(BACKUP_DIR, viejos.shift()));
  } catch (e) {
    console.error("No se pudo hacer backup:", e.message);
  }
}

function registrarAuditoria(entrada) {
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entrada) + "\n");
  } catch (e) {
    // la auditoría nunca debe tumbar un guardado real
  }
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
function aplicarCambios(dataPrevia, dirty, scalars) {
  const data = { ...dataPrevia };
  const resumen = [];

  for (const [clave, cambios] of Object.entries(dirty || {})) {
    if (!cambios || typeof cambios !== "object") continue;
    const actual = Array.isArray(data[clave]) ? data[clave] : [];
    const porId = new Map(actual.filter(it => it && it.id !== undefined).map(it => [it.id, it]));
    const upsert = Array.isArray(cambios.upsert) ? cambios.upsert : [];
    const del = Array.isArray(cambios.del) ? cambios.del : [];
    upsert.forEach(it => {
      if (it && it.id !== undefined) porId.set(it.id, it);
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

  return { data, resumen };
}

// ── El sistema pide los datos compartidos ───────────────
app.get("/api/state", (req, res) => {
  res.json(estado);
});

// ── El sistema guarda cambios nuevos ────────────────────
app.post("/api/state", (req, res) => {
  const body = req.body || {};
  const origen = body.origen || {};
  let resumen = [];

  if (body.dirty || body.scalars) {
    // Protocolo nuevo: el cliente manda solo lo que efectivamente cambió.
    const r = aplicarCambios(estado.data, body.dirty, body.scalars);
    estado = { rev: estado.rev + 1, data: r.data };
    resumen = r.resumen;
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

  guardarEstado(estado);
  backupPeriodico(estado);
  registrarAuditoria({
    hora: new Date().toISOString(),
    rev: estado.rev,
    usuario: origen.usuario || null,
    rol: origen.rol || null,
    cambios: resumen,
  });
  res.json(estado);
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
  const job = { id: proximoJobId++, texto: String(texto), creado: new Date().toISOString() };
  colaImpresion.push(job);
  if (colaImpresion.length > 200) colaImpresion = colaImpresion.slice(-200);
  res.json({ ok: true, id: job.id });
});

app.get("/api/print-jobs", (req, res) => {
  res.json({ jobs: colaImpresion });
});

app.post("/api/print-jobs/:id/done", (req, res) => {
  const id = Number(req.params.id);
  colaImpresion = colaImpresion.filter(j => j.id !== id);
  res.json({ ok: true, pendientes: colaImpresion.length });
});

// ── Para saber si el servidor está vivo ─────────────────
app.get("/health", (req, res) => res.send("ok"));

module.exports = { app, aplicarCambios, DATA_FILE };

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Sistema Gourmet escuchando en el puerto ${PORT} (datos en ${DATA_FILE})`);
  });
}
