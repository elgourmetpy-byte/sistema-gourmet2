// ═══════════════════════════════════════════════════════
// SERVIDOR — El Gourmet / Sistema Gourmet
// Este es el "cuaderno mágico" compartido: guarda toda la
// información del restaurante en un solo lugar y se la
// reparte a todos los dispositivos conectados (notebook,
// tablets, celulares).
// ═══════════════════════════════════════════════════════
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

app.use(express.json({ limit: "5mb" }));

// ── Página principal del sistema ────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ── Cargar lo último guardado en disco (si existe) ──────
function cargarEstado() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return { rev: 0, data: {} };
  }
}

function guardarEstado(estado) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(estado));
  } catch (e) {
    console.error("No se pudo guardar en disco:", e.message);
  }
}

let estado = cargarEstado();

// ── El sistema pide los datos compartidos ───────────────
app.get("/api/state", (req, res) => {
  res.json(estado);
});

// ── El sistema guarda cambios nuevos ────────────────────
app.post("/api/state", (req, res) => {
  const nuevaData = (req.body && req.body.data) || {};
  estado = { rev: estado.rev + 1, data: { ...estado.data, ...nuevaData } };
  guardarEstado(estado);
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

// El sistema deja una comanda en el buzón
app.post("/api/print-jobs", (req, res) => {
  const texto = (req.body && req.body.texto) || "";
  if (!String(texto).trim()) return res.status(400).json({ error: "texto vacío" });
  const job = { id: proximoJobId++, texto: String(texto), creado: new Date().toISOString() };
  colaImpresion.push(job);
  if (colaImpresion.length > 200) colaImpresion = colaImpresion.slice(-200);
  res.json({ ok: true, id: job.id });
});

// El Agente pregunta qué hay para imprimir
app.get("/api/print-jobs", (req, res) => {
  res.json({ jobs: colaImpresion });
});

// El Agente avisa que ya imprimió una comanda
app.post("/api/print-jobs/:id/done", (req, res) => {
  const id = Number(req.params.id);
  colaImpresion = colaImpresion.filter(j => j.id !== id);
  res.json({ ok: true, pendientes: colaImpresion.length });
});

// ── Para saber si el servidor está vivo ─────────────────
app.get("/health", (req, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`Sistema Gourmet escuchando en el puerto ${PORT}`);
});
