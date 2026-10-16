// Para probar Mis Pagos sola en la compu:  node mis-pagos/servidor-local.js
// (En Render no hace falta: se monta desde el server.js del Sistema Gourmet.)
const express = require("express");
const path = require("path");
const app = express();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "datos-prueba");
app.use("/pagos", require("./router")({ dataDir: DATA_DIR }));
app.get("/", (req, res) => res.redirect("/pagos/"));
const PORT = process.env.PORT || 3100;
app.listen(PORT, () => console.log(`Mis Pagos en http://localhost:${PORT}/pagos/  (datos en ${DATA_DIR})`));
