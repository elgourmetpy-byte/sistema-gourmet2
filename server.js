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
    const cargado = JSON.parse(raw);
    // revPorClave puede no existir todavia en archivos guardados por
    // una version anterior del servidor: arranca vacio, sin problema.
    if (!cargado.revPorClave) cargado.revPorClave = {};
    return cargado;
  } catch (e) {
    return { rev: 0, data: {}, revPorClave: {} };
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

// ═══════════════════════════════════════════════════════
// EL SISTEMA GUARDA CAMBIOS NUEVOS
//
// PROBLEMA QUE ESTO RESUELVE (agosto 2026 — "se borran mesas"):
// La app manda SIEMPRE el paquete completo de las 17 claves
// compartidas (mesas, pedidosDelivery, clientes, etc.) cada vez
// que cambia UNA sola cosa, aunque las otras 16 no se hayan
// tocado en ese aparato. Si dos dispositivos guardan casi al
// mismo tiempo, el segundo guardado traía una copia VIEJA de
// las claves que no cambió en ESE aparato (porque hacia rato
// que no se actualizaba con lo del otro aparato), y esa copia
// vieja pisaba por completo lo que el primer aparato acababa de
// guardar. Por eso desaparecian mesas: no era que el codigo del
// PowerShell ni la impresora tuvieran nada que ver, era este
// "pisado" de datos en el servidor.
//
// SOLUCION: cada clave lleva su propio numero de revision
// (revPorClave). Cuando un aparato guarda, viene con el "rev"
// del servidor que tenia la ULTIMA VEZ que se actualizo (lo
// manda desde hace tiempo, pero antes el servidor lo ignoraba).
// Para cada clave del paquete:
//   - Si nadie cambio esa clave despues de que este aparato la
//     vio por ultima vez -> se guarda tal cual (caso normal).
//   - Si OTRO aparato ya cambio esa clave mas reciente que lo
//     que este aparato vio -> se ignora la copia vieja de ESA
//     clave nada mas (las demas claves del mismo paquete se
//     guardan igual si estan al dia). Asi nunca se pisa un
//     cambio mas nuevo con uno mas viejo.
// ═══════════════════════════════════════════════════════
app.post("/api/state", (req, res) => {
  const revCliente = Number(req.body && req.body.rev) || 0;
  const nuevaData = (req.body && req.body.data) || {};
  const revPorClave = { ...(estado.revPorClave || {}) };
  const dataFinal = { ...estado.data };
  const nuevoRev = estado.rev + 1;
  let huboCambios = false;
  const ignoradasPorConflicto = [];

  for (const clave of Object.keys(nuevaData)) {
    const revDeEstaClave = revPorClave[clave] || 0;
    if (revDeEstaClave <= revCliente) {
      // Este aparato tenia la version mas nueva de esta clave: se confia en lo que manda.
      const valorNuevo = nuevaData[clave];
      if (JSON.stringify(dataFinal[clave]) !== JSON.stringify(valorNuevo)) {
        dataFinal[clave] = valorNuevo;
        revPorClave[clave] = nuevoRev;
        huboCambios = true;
      }
    } else {
      // Otro aparato ya actualizo esta clave despues de que este la vio por
      // ultima vez: no se pisa. Se descarta solo la copia vieja de esta clave.
      ignoradasPorConflicto.push(clave);
    }
  }

  if (huboCambios) {
    estado = { rev: nuevoRev, data: dataFinal, revPorClave };
    guardarEstado(estado);
  }

  if (ignoradasPorConflicto.length > 0) {
    console.log(`[sync] Se ignoro una copia vieja de: ${ignoradasPorConflicto.join(", ")} (otro aparato ya la habia actualizado)`);
  }

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
