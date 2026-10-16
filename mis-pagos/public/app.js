/* ════════════════════════════════════════════════════════════════
   Mis Pagos — la app del celular
   ════════════════════════════════════════════════════════════════ */
"use strict";
const L = window.Logica;
const $ = (s, el) => (el || document).querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

// ── Memoria del celular (si el navegador la bloquea, la app sigue andando) ──
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin memoria local */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* idem */ } },
};
const K = { estado: "mispagos.estado", token: "mispagos.token", tema: "mispagos.tema", grupo: "mispagos.grupo", avisos: "mispagos.avisos" };

let estado = (() => {
  try { const e = JSON.parse(LS.get(K.estado)); return L.esEstadoValido(e) ? e : L.estadoVacio(); }
  catch (e) { return L.estadoVacio(); }
})();
let token = LS.get(K.token);
let instalarEvt = null;
const ui = {
  tab: "pagos", grupo: LS.get(K.grupo) || "todo", mesHist: L.mesDe(L.hoyLocal()),
  sync: { estado: "nada", cuando: null }, hojaAbierta: false, borrador: null,
  pinModo: null, pin: "", pinPrimero: null, pinError: "", renderPendiente: false,
};
const hoy = () => L.hoyLocal();
const guardarLocal = () => LS.set(K.estado, JSON.stringify(estado));
const filtroGrupo = (g) => ui.grupo === "todo" || g === ui.grupo;
const esIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const instalada = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// ── Servidor ────────────────────────────────────────────────────
async function api(ruta, datos) {
  const r = await fetch("api/" + ruta, {
    method: datos ? "POST" : "GET",
    headers: Object.assign({ "Content-Type": "application/json" }, token ? { "X-Token": token } : {}),
    body: datos ? JSON.stringify(datos) : undefined,
  });
  let j = {};
  try { j = await r.json(); } catch (e) { /* respuesta vacía */ }
  if (r.status === 401 && token && !["entrar", "cambiar-pin"].includes(ruta)) sesionVencida();
  if (!r.ok) { const err = new Error(j.error || "Error " + r.status); err.status = r.status; throw err; }
  return j;
}

let sincronizando = false, otraVez = false, timerSync = null;
function programarSync() { clearTimeout(timerSync); timerSync = setTimeout(sincronizar, 700); }
async function sincronizar() {
  if (!token) return;
  if (sincronizando) { otraVez = true; return; }
  sincronizando = true;
  try {
    const j = await api("estado", { estado });
    const antes = JSON.stringify(estado);
    estado = L.fusionarEstado(estado, j.estado);
    guardarLocal();
    ui.sync = { estado: "ok", cuando: Date.now() };
    if (JSON.stringify(estado) !== antes) render(); else pintarSync();
  } catch (e) {
    if (e.status !== 401) { ui.sync = { estado: "mal", cuando: ui.sync.cuando }; pintarSync(); }
  } finally {
    sincronizando = false;
    if (otraVez) { otraVez = false; programarSync(); }
  }
}
/** Después de cualquier cambio: guardar en el celular, redibujar y mandar al servidor. */
function cambio() { guardarLocal(); render(true); programarSync(); }
const tocar = (obj) => { obj.updatedAt = Date.now(); return obj; };

function sesionVencida() {
  token = null; LS.del(K.token);
  ui.pinModo = null; ui.pin = ""; ui.pinError = "Entrá de nuevo con tu PIN";
  cerrarHoja(); render(true);
}

// ── Avisos en pantalla ──────────────────────────────────────────
let timerAviso = null;
function aviso(txt, ms) {
  const el = $("#aviso");
  el.textContent = txt; el.classList.remove("oculto");
  clearTimeout(timerAviso);
  timerAviso = setTimeout(() => el.classList.add("oculto"), ms || 3200);
}

// ── Tema ────────────────────────────────────────────────────────
function aplicarTema() {
  const t = LS.get(K.tema) || "auto";
  if (t === "auto") document.documentElement.removeAttribute("data-tema");
  else document.documentElement.setAttribute("data-tema", t);
  const oscuro = t === "oscuro" || (t === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  $('meta[name="theme-color"]').content = oscuro ? "#101310" : "#f4f5f2";
}

// ════════════════════════════════════════════════════════════════
//  DIBUJO
// ════════════════════════════════════════════════════════════════
function render(forzar) {
  const p = $("#principal");
  const foco = document.activeElement;
  // Si la persona está escribiendo, no le borramos el campo: redibujamos después.
  if (!forzar && foco && p.contains(foco) && foco.matches("input,select,textarea")) { ui.renderPendiente = true; return; }
  ui.renderPendiente = false;
  if (!token) { renderEntrada(); return; }
  const vistas = { pagos: vistaPagos, historial: vistaHistorial, personal: vistaPersonal, ajustes: vistaAjustes };
  p.innerHTML = cabecera() + `<main>${vistas[ui.tab]()}</main>`
    + (ui.tab === "pagos" ? `<button class="microfono" data-a="voz" aria-label="Marcar un pago hablando">🎤</button>` : "")
    + pestanas();
}

function cabecera() {
  const titulos = { pagos: "Mis Pagos", historial: "Historial", personal: "Personal del local", ajustes: "Ajustes" };
  const seg = ui.tab === "pagos" || ui.tab === "historial"
    ? `<div class="segmento">${[["todo", "Todo"], ["casa", "🏠 Casa"], ["local", "🍽️ Local"]]
      .map(([k, t]) => `<button class="${ui.grupo === k ? "activo" : ""}" data-a="grupo" data-v="${k}">${t}</button>`).join("")}</div>`
    : "";
  return `<header class="cabecera"><div><div class="titulo"><h1>${titulos[ui.tab]}</h1>${chipSync()}</div>${seg}</div></header>`;
}
function chipSync() {
  const s = ui.sync.estado;
  const txt = s === "ok" ? "Guardado" : s === "mal" ? "Sin conexión" : "Conectando…";
  return `<span class="sync ${s === "ok" ? "ok" : s === "mal" ? "mal" : ""}" id="sync"><i></i>${txt}</span>`;
}
function pintarSync() { const el = $("#sync"); if (el) el.outerHTML = chipSync(); }

function pestanas() {
  const t = [["pagos", "✅", "Pagos"], ["historial", "📊", "Historial"], ["personal", "👥", "Personal"], ["ajustes", "⚙️", "Ajustes"]];
  return `<nav class="pestanas">${t.map(([k, i, n]) =>
    `<button class="${ui.tab === k ? "activo" : ""}" data-a="tab" data-v="${k}"><span>${i}</span>${n}</button>`).join("")}</nav>`;
}

// ── Pestaña PAGOS ───────────────────────────────────────────────
function vistaPagos() {
  const h = hoy(), mes = L.mesDe(h);
  if (!estado.pagos.length) return `<div class="vacio">${ui.sync.estado === "mal" ? "Sin conexión. Tus pagos aparecen cuando vuelva internet." : "Cargando tus pagos…"}</div>`;
  const lista = L.listaActual(estado, h).filter((x) => filtroGrupo(x.pago.grupo));
  const pagadoMes = L.registrosDelMes(estado, mes).filter((r) => filtroGrupo(r.grupo)).reduce((s, r) => s + (Number(r.monto) || 0), 0);
  const c = { vencido: 0, pronto: 0, pendiente: 0, sinfecha: 0, pagado: 0 };
  lista.forEach((x) => c[x.estado]++);
  const cont = [
    c.vencido && `<span class="cont vencido">${plural(c.vencido, "vencido", "vencidos")}</span>`,
    c.pronto && `<span class="cont pronto">${plural(c.pronto, "vence pronto", "vencen pronto")}</span>`,
    (c.pendiente + c.sinfecha) && `<span class="cont pendiente">${c.pendiente + c.sinfecha} por pagar</span>`,
    c.pagado && `<span class="cont pagado">${plural(c.pagado, "pagado", "pagados")}</span>`,
  ].filter(Boolean).join("");
  let html = `<section class="tarjeta resumen">
      <div class="etq">Hoy es ${L.fechaLarga(h)}</div>
      <div class="etq" style="margin-top:8px">Pagado en ${L.nombreMes(mes)}${ui.grupo !== "todo" ? " · " + L.GRUPOS[ui.grupo] : ""}</div>
      <div class="grande">${L.fmtGs(pagadoMes)}</div>
      <div class="contadores">${cont}</div></section>`;
  const secciones = [["vencido", "🔴 Vencidos"], ["pronto", "🟠 Vencen pronto"], ["pendiente", "Próximos"], ["sinfecha", "Sin día fijo (este mes)"], ["pagado", "🟢 Pagados"]];
  for (const [k, titulo] of secciones) {
    const items = lista.filter((x) => x.estado === k);
    if (items.length) html += `<h2 class="seccion">${titulo}</h2>` + items.map(filaPago).join("");
  }
  if (!lista.length) html += `<div class="vacio">No hay pagos para mostrar.</div>`;
  return html;
}

function filaPago(x) {
  const p = x.pago, oc = x.oc;
  let cuando;
  if (x.estado === "pagado") cuando = `Pagado el ${L.fechaCorta(x.registro.fechaPago)}`;
  else if (!oc.venc) cuando = "Sin día fijo";
  else if (x.estado === "vencido") cuando = `Venció ${L.fechaCorta(oc.venc)} · hace ${plural(-x.dias, "día", "días")}`;
  else if (x.dias === 0) cuando = "Vence HOY";
  else if (x.dias === 1) cuando = "Vence mañana";
  else cuando = `Vence ${L.fechaCorta(oc.venc)}${x.dias === 2 ? " · en 2 días" : ""}`;
  const extra = [];
  if (p.frecuencia === "quincenal") extra.push(oc.periodo.endsWith("q1") ? "1ª quincena" : "2ª quincena");
  if (p.cuotasRestantes != null) extra.push(p.cuotasRestantes === 0 ? "¡última cuota pagada!" : `faltan ${plural(p.cuotasRestantes, "cuota", "cuotas")}`);
  if (x.estado !== "pagado") {
    const u = L.ultimoRegistro(p.id, estado.registros);
    if (u) extra.push(`la última vez ${L.fmtGs(u.monto)}`);
  }
  return `<button class="fila ${x.estado}" data-a="abrirPago" data-p="${esc(p.id)}" data-per="${esc(oc.periodo)}">
    <span class="tilde" aria-hidden="true">✓</span>
    <span class="info">
      <span class="nombre">${esc(p.nombre)}</span>
      <span class="detalle"><span class="chip ${p.grupo}">${L.GRUPOS[p.grupo]}</span><span class="cuando">${cuando}</span></span>
      ${extra.length ? `<span class="detalle">${esc(extra.join(" · "))}</span>` : ""}
    </span>
    ${x.estado === "pagado" ? `<span class="monto">${L.fmtGs(x.registro.monto)}</span>` : ""}
  </button>`;
}

/** Fecha de vencimiento de un pago puntual a partir de su "periodo". */
function vencDePeriodo(p, periodo) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(periodo)) return periodo;
  const [y, m] = periodo.slice(0, 7).split("-").map(Number);
  const dm = L.diasDelMes(y, m);
  if (p.frecuencia === "mensual") return p.dia ? L.aISO(y, m, Math.min(p.dia, dm)) : null;
  if (p.frecuencia === "quincenal") {
    const i = periodo.endsWith("q2") ? 1 : 0;
    return p.dias && p.dias[i] ? L.aISO(y, m, Math.min(p.dias[i], dm)) : null;
  }
  return null;
}
function periodoLegible(p, periodo) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(periodo)) return L.fechaDMA(periodo);
  const mes = L.nombreMes(periodo.slice(0, 7));
  if (periodo.endsWith("q1")) return "1ª quincena de " + mes;
  if (periodo.endsWith("q2")) return "2ª quincena de " + mes;
  return mes;
}

function abrirPago(pagoId, periodo, montoDicho) {
  const p = estado.pagos.find((x) => x.id === pagoId);
  if (!p) return;
  const reg = L.indexarRegistros(estado.registros).get(L.claveReg(pagoId, periodo));
  const venc = vencDePeriodo(p, periodo);
  const ult = L.ultimoRegistro(pagoId, estado.registros);
  const monto = reg ? reg.monto : montoDicho || "";
  abrirHoja(`
    <h2>${esc(p.nombre)} <span class="chip ${p.grupo}">${L.GRUPOS[p.grupo]}</span></h2>
    <p class="ayuda">${venc ? "Vence el " + L.fechaLarga(venc) : "Sin día fijo"} · ${esc(periodoLegible(p, periodo))}</p>
    ${p.cuotasRestantes != null ? `<p class="ayuda">Faltan ${plural(p.cuotasRestantes, "cuota", "cuotas")}${!reg && p.cuotasRestantes > 0 ? " (al pagar queda" + (p.cuotasRestantes - 1 === 1 ? " 1)" : `n ${p.cuotasRestantes - 1})`) : ""}</p>` : ""}
    <label class="etq" for="f-monto">¿Cuánto pagaste?</label>
    <input id="f-monto" class="campo monto" data-gs inputmode="numeric" autocomplete="off" placeholder="Gs. 0" value="${monto ? L.miles(monto) : ""}">
    ${ult && !reg ? `<p class="ayuda">La última vez: <b>${L.fmtGs(ult.monto)}</b> (${L.fechaDMA(ult.fechaPago)})
      <button class="boton chico" data-a="usarMonto" data-v="${ult.monto}">Usar ese</button></p>` : ""}
    <p class="error" id="f-error"></p>
    <label class="etq" for="f-fecha">Fecha en que pagaste</label>
    <input id="f-fecha" type="date" class="campo" value="${reg ? reg.fechaPago : hoy()}">
    <label class="etq" for="f-nota">Nota (opcional)</label>
    <input id="f-nota" class="campo" value="${esc(reg ? reg.nota : "")}" placeholder="Ej: por transferencia">
    <button class="boton primario" data-a="confirmarPago" data-p="${esc(p.id)}" data-per="${esc(periodo)}">✓ ${reg ? "Guardar cambios" : "Marcar como pagado"}</button>
    ${reg ? `<button class="boton peligro" data-a="desmarcar" data-p="${esc(p.id)}" data-per="${esc(periodo)}">Desmarcar (todavía no está pagado)</button>` : ""}
    <button class="boton" data-a="cerrar">Cancelar</button>`);
  if (!reg) setTimeout(() => { const el = $("#f-monto"); if (el) el.focus(); }, 250);
}

function confirmarPago(pagoId, periodo) {
  const p = estado.pagos.find((x) => x.id === pagoId);
  const monto = L.leerMonto($("#f-monto").value);
  if (!monto) { $("#f-error").textContent = "Escribí cuánto pagaste"; $("#f-monto").focus(); return; }
  const fecha = $("#f-fecha").value || hoy();
  const nota = $("#f-nota").value.trim();
  const reg = L.indexarRegistros(estado.registros).get(L.claveReg(pagoId, periodo));
  let msg;
  if (reg) {
    Object.assign(reg, { monto, fechaPago: fecha, nota });
    tocar(reg);
    msg = "Cambios guardados";
  } else {
    const descuenta = p.cuotasRestantes != null && p.cuotasRestantes > 0;
    estado.registros.push(tocar({
      id: L.nuevoId(), pagoId, periodo, venc: vencDePeriodo(p, periodo), fechaPago: fecha, monto, nota,
      nombre: p.nombre, grupo: p.grupo, tipo: p.tipo, descontoCuota: descuenta,
    }));
    if (descuenta) { p.cuotasRestantes--; tocar(p); }
    msg = `✅ Pagado: ${p.nombre} — ${L.fmtGs(monto)}`;
    if (descuenta) msg += p.cuotasRestantes === 0 ? " · ¡Era la última cuota! 🎉" : ` · faltan ${plural(p.cuotasRestantes, "cuota", "cuotas")}`;
  }
  cerrarHoja(); cambio(); aviso(msg, 4000);
}

function desmarcar(pagoId, periodo) {
  const p = estado.pagos.find((x) => x.id === pagoId);
  const reg = L.indexarRegistros(estado.registros).get(L.claveReg(pagoId, periodo));
  if (!reg || !confirm(`¿Desmarcar ${p ? p.nombre : "este pago"}? Se borra el monto que cargaste.`)) return;
  reg.borrado = true; tocar(reg);
  if (reg.descontoCuota && p && p.cuotasRestantes != null) { p.cuotasRestantes++; tocar(p); }
  cerrarHoja(); cambio(); aviso("Pago desmarcado");
}

// ── Voz ─────────────────────────────────────────────────────────
let reconocedor = null;
function abrirVoz() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  abrirHoja(`
    <h2>🎤 Decime qué pagaste</h2>
    <p class="ayuda">Por ejemplo: <i>“pagué la luz del local”</i> o <i>“pagué la tarjeta Bancop 1 millón 200 mil”</i></p>
    <div class="transcripcion" id="v-texto">${SR ? "Escuchando…" : ""}</div>
    <div id="v-res"></div>
    ${SR ? `<button class="boton primario" data-a="vozOtraVez">🎤 Escuchar de nuevo</button>` : ""}
    <label class="etq" for="v-escrito">${SR ? "O escribilo:" : "Este navegador no entiende la voz. Escribilo:"}</label>
    <div class="dos"><input id="v-escrito" class="campo" placeholder="pagué la luz del local" enterkeyhint="go">
      <button class="boton chico primario" data-a="vozEscrita" style="flex:0 0 auto">OK</button></div>
    <button class="boton" data-a="cerrar">Cancelar</button>`);
  if (SR) escuchar(SR, "es-PY");
}
function pararVoz() { if (reconocedor) { try { reconocedor.abort(); } catch (e) { /* ya estaba parado */ } reconocedor = null; } }
function escuchar(SR, idioma) {
  pararVoz();
  const rec = new SR();
  reconocedor = rec;
  rec.lang = idioma; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
  const texto = (t) => { const el = $("#v-texto"); if (el) el.textContent = t; };
  texto("Escuchando…"); $("#v-res").innerHTML = "";
  let final = "";
  rec.onresult = (e) => {
    let t = "";
    for (let i = 0; i < e.results.length; i++) { t += e.results[i][0].transcript; if (e.results[i].isFinal) final = t; }
    texto("“" + t + "”");
  };
  rec.onerror = (e) => {
    if (e.error === "language-not-supported" && idioma !== "es-ES") { escuchar(SR, "es-ES"); return; }
    const m = {
      "not-allowed": "No tengo permiso para usar el micrófono. Activalo en los permisos del navegador.",
      "service-not-allowed": "El micrófono está bloqueado en este navegador.",
      "no-speech": "No te escuché. Tocá “Escuchar de nuevo”.",
      network: "Para entender la voz hace falta internet.",
      "audio-capture": "No encuentro el micrófono.",
    };
    if (e.error !== "aborted") texto(m[e.error] || "No pude escuchar (" + e.error + ")");
  };
  rec.onend = () => { if (reconocedor === rec) reconocedor = null; if (final) procesarVoz(final); };
  try { rec.start(); } catch (e) { texto("No pude prender el micrófono."); }
}
function procesarVoz(texto) {
  const res = $("#v-res");
  if (!res) return;
  const vivos = L.pagosVivos(estado).filter((p) => !L.terminado(p));
  const r = L.interpretarVoz(texto, vivos);
  const lista = L.listaActual(estado, hoy());
  // El pendiente de la lista; si no hay, el próximo vencimiento (hasta 45 días adelante).
  const idx = L.indexarRegistros(estado.registros);
  const pendiente = (p) => lista.find((x) => x.pago.id === p.id && x.estado !== "pagado")
    || L.ocurrencias(p, hoy(), L.sumarDias(hoy(), 45)).filter((oc) => !idx.has(L.claveReg(p.id, oc.periodo))).map((oc) => ({ oc }))[0];
  if (!r.candidatos.length) {
    res.innerHTML = `<p class="error">No encontré ningún pago con “${esc(texto)}”. Decí el nombre como aparece en la lista (y “casa” o “local”).</p>`;
    return;
  }
  let cands = r.candidatos;
  const conPendiente = cands.filter(pendiente);
  if (conPendiente.length) cands = conPendiente;
  if (cands.length === 1) {
    const p = cands[0], x = pendiente(p);
    if (!x) { res.innerHTML = `<p class="ayuda">✅ <b>${esc(p.nombre)}</b> (${L.GRUPOS[p.grupo]}) ya está pagado.</p>`; return; }
    abrirPago(p.id, x.oc.periodo, r.monto);
    return;
  }
  res.innerHTML = `<label class="etq">¿Cuál de estos?</label>` + cands.map((p) => {
    const x = pendiente(p);
    return `<button class="boton opcion" data-a="vozElegir" data-p="${esc(p.id)}" data-per="${x ? esc(x.oc.periodo) : ""}" data-m="${r.monto || ""}">
      <span>${esc(p.nombre)}${!x ? " (ya pagado)" : x.oc.venc ? ` <span class="sub">· vence ${L.fechaCorta(x.oc.venc)}</span>` : ""}</span><span class="chip ${p.grupo}">${L.GRUPOS[p.grupo]}</span></button>`;
  }).join("");
}

// ── Pestaña HISTORIAL ───────────────────────────────────────────
const COLOR = { casa: "var(--casa)", local: "var(--local)" };
function vistaHistorial() {
  const mes = ui.mesHist;
  const t = L.totalesDelMes(estado, mes);
  const regs = L.registrosDelMes(estado, mes).filter((r) => filtroGrupo(r.grupo));
  const pc = (v) => (t.total ? Math.round(v / t.total * 100) : 0);
  const esteMes = L.mesDe(hoy());
  let html = `<div class="navmes">
      <button data-a="mes" data-v="-1" aria-label="Mes anterior">‹</button>
      <h2>${L.nombreMes(mes)}</h2>
      <button data-a="mes" data-v="1" aria-label="Mes siguiente" ${mes >= esteMes ? "disabled style='opacity:.3'" : ""}>›</button></div>
    <section class="tarjeta resumen">
      <div class="etq">Total pagado en el mes</div><div class="grande">${L.fmtGs(t.total)}</div>
      <div class="barra" style="margin-top:12px">${t.total ? `<i style="width:${pc(t.casa)}%;background:var(--casa)"></i><i style="width:${pc(t.local)}%;background:var(--local)"></i>` : ""}</div>
      <div class="leyenda"><span><b style="background:var(--casa)"></b>Casa ${L.fmtGs(t.casa)} (${pc(t.casa)}%)</span>
        <span><b style="background:var(--local)"></b>Local ${L.fmtGs(t.local)} (${pc(t.local)}%)</span></div>
    </section>`;

  // ¿En qué se va la plata?
  const tipos = Object.entries(t.porTipo).map(([k, v]) => ({ k, casa: filtroGrupo("casa") ? v.casa : 0, local: filtroGrupo("local") ? v.local : 0 }))
    .map((x) => Object.assign(x, { total: x.casa + x.local })).filter((x) => x.total > 0).sort((a, b) => b.total - a.total);
  if (tipos.length) {
    const max = tipos[0].total;
    html += `<section class="tarjeta"><h3>¿En qué se va la plata?</h3>` + tipos.map((x) => `
      <div class="tipo"><div class="linea"><span>${L.TIPOS[x.k] || x.k}</span><span>${L.fmtGs(x.total)}</span></div>
      <div class="barra"><i style="width:${x.casa / max * 100}%;background:var(--casa)"></i><i style="width:${x.local / max * 100}%;background:var(--local)"></i></div></div>`).join("")
      + `<div class="leyenda"><span><b style="background:var(--casa)"></b>Casa</span><span><b style="background:var(--local)"></b>Local</span></div></section>`;
  }

  html += `<section class="tarjeta"><h3>Últimos 6 meses</h3>${graficoMeses(mes)}<p class="ayuda">Tocá una columna para ver ese mes.</p></section>`;

  html += `<section class="tarjeta"><h3>Pagos de ${L.nombreMes(mes)}${ui.grupo !== "todo" ? " · " + L.GRUPOS[ui.grupo] : ""}</h3>`;
  html += regs.length ? regs.map((r) => `
      <button class="renglon" data-a="abrirPago" data-p="${esc(r.pagoId)}" data-per="${esc(r.periodo)}">
        <span><span style="font-weight:700">${esc(r.nombre)}</span><br><span class="sub"><span class="chip ${r.grupo}">${L.GRUPOS[r.grupo]}</span> ${L.fechaCorta(r.fechaPago)}${r.nota ? " · " + esc(r.nota) : ""}</span></span>
        <b>${L.fmtGs(r.monto)}</b></button>`).join("")
    : `<p class="ayuda">No hay pagos cargados en este mes.</p>`;
  return html + `</section>`;
}

function graficoMeses(mesSel) {
  const meses = [];
  for (let i = 5; i >= 0; i--) meses.push(L.sumarMeses(L.mesDe(hoy()), -i));
  const datos = meses.map((m) => Object.assign({ m }, L.totalesDelMes(estado, m)));
  const max = Math.max(1, ...datos.map((d) => d.total));
  const W = 330, H = 170, base = 140, alto = 120, ancho = 36, paso = W / 6;
  const barras = datos.map((d, i) => {
    const x = i * paso + (paso - ancho) / 2;
    const hc = d.casa / max * alto, hl = d.local / max * alto;
    const sel = d.m === mesSel;
    return `<g data-a="irMes" data-v="${d.m}" style="cursor:pointer">
      <rect x="${i * paso}" y="0" width="${paso}" height="${H}" fill="transparent"/>
      ${sel ? `<rect x="${x - 4}" y="${base - alto - 8}" width="${ancho + 8}" height="${alto + 12}" rx="6" fill="var(--superficie2)"/>` : ""}
      <rect x="${x}" y="${base - hc}" width="${ancho}" height="${hc}" rx="3" fill="${COLOR.casa}"/>
      <rect x="${x}" y="${base - hc - hl}" width="${ancho}" height="${hl}" rx="3" fill="${COLOR.local}"/>
      <text x="${x + ancho / 2}" y="${base + 18}" text-anchor="middle" style="font-weight:${sel ? 800 : 400}">${L.MESES[Number(d.m.slice(5)) - 1].slice(0, 3)}</text>
      ${d.total ? `<text x="${x + ancho / 2}" y="${base - hc - hl - 5}" text-anchor="middle" style="font-size:10px">${abreviar(d.total)}</text>` : ""}
    </g>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Gastos de los últimos 6 meses, casa y local">${barras}</svg>
    <div class="leyenda"><span><b style="background:var(--casa)"></b>Casa</span><span><b style="background:var(--local)"></b>Local</span></div>`;
}
function abreviar(n) { return n >= 1e6 ? (n / 1e6).toFixed(1).replace(".", ",") + " M" : Math.round(n / 1000) + " mil"; }

// ── Pestaña PERSONAL ────────────────────────────────────────────
function vistaPersonal() {
  const cfg = estado.config || {};
  const gente = L.personalVivo(estado);
  let html = `<section class="tarjeta resumen" id="p-total">${totalPersonal()}</section>
    <section class="tarjeta">
      <label class="etq" for="p-ips" style="margin-top:0">IPS patronal (%)</label>
      <input id="p-ips" class="campo" inputmode="decimal" data-cfg="ipsPatronal" value="${String(cfg.ipsPatronal != null ? cfg.ipsPatronal : 16.5).replace(".", ",")}">
      <p class="ayuda">Lo que paga el local al IPS sobre el sueldo de cada colaborador inscripto.</p>
    </section>`;
  html += gente.map((c) => `
    <section class="tarjeta persona">
      <div class="encabezado"><h3>${esc(c.nombre)}</h3><button class="boton chico" data-a="editarPersona" data-id="${esc(c.id)}" aria-label="Editar nombre">✏️</button></div>
      <label class="etq" for="s-${esc(c.id)}">Sueldo semanal</label>
      <input id="s-${esc(c.id)}" class="campo" data-gs inputmode="numeric" data-persona="${esc(c.id)}" data-campo="sueldoSemanal" value="${c.sueldoSemanal ? L.miles(c.sueldoSemanal) : ""}" placeholder="Gs. 0">
      <label class="interruptor">Inscripto en IPS<input type="checkbox" data-persona="${esc(c.id)}" data-campo="ips" ${c.ips ? "checked" : ""}></label>
      <label class="interruptor">Sumar aguinaldo (prorrateado)<input type="checkbox" data-persona="${esc(c.id)}" data-campo="aguinaldo" ${c.aguinaldo !== false ? "checked" : ""}></label>
      <label class="etq" for="e-${esc(c.id)}">Otros extras por mes (bonos, horas extra…)</label>
      <input id="e-${esc(c.id)}" class="campo" data-gs inputmode="numeric" data-persona="${esc(c.id)}" data-campo="extras" value="${c.extras ? L.miles(c.extras) : ""}" placeholder="Gs. 0">
      <div class="desglose" id="d-${esc(c.id)}">${desglose(c)}</div>
    </section>`).join("");
  return html + `<button class="boton primario" data-a="agregarPersona">+ Agregar colaborador</button>`;
}
function totalPersonal() {
  const cfg = estado.config || {};
  const gente = L.personalVivo(estado);
  const total = gente.reduce((s, c) => s + L.costoColaborador(c, cfg).total, 0);
  const semana = gente.reduce((s, c) => s + (Number(c.sueldoSemanal) || 0), 0);
  const faltan = gente.filter((c) => !Number(c.sueldoSemanal)).length;
  return `<div class="etq">Costo mensual real del personal (${plural(gente.length, "persona", "personas")})</div>
    <div class="grande">${L.fmtGs(total)}</div>
    <p class="ayuda">Sueldos de cada sábado: <b>${L.fmtGs(semana)}</b> por semana.</p>
    ${faltan ? `<p class="ayuda" style="color:var(--naranja)">⚠️ Falta cargar el sueldo de ${plural(faltan, "persona", "personas")}.</p>` : ""}`;
}
function desglose(c) {
  const k = L.costoColaborador(c, estado.config || {});
  const pct = String((estado.config || {}).ipsPatronal != null ? estado.config.ipsPatronal : 16.5).replace(".", ",");
  return `<div><span>Sueldo mensual (semanal × 52 ÷ 12)</span><span>${L.fmtGs(k.mensual)}</span></div>
    ${c.ips ? `<div><span>IPS patronal (${pct}%)</span><span>${L.fmtGs(k.ips)}</span></div>` : ""}
    ${c.aguinaldo !== false ? `<div><span>Aguinaldo (1/12)</span><span>${L.fmtGs(k.aguinaldo)}</span></div>` : ""}
    ${k.extras ? `<div><span>Extras</span><span>${L.fmtGs(k.extras)}</span></div>` : ""}
    <div class="total"><span>Costo real por mes</span><span>${L.fmtGs(k.total)}</span></div>`;
}
/** Actualiza los números sin redibujar toda la pantalla (para no perder el campo donde escribís). */
function actualizarCostos() {
  const t = $("#p-total"); if (t) t.innerHTML = totalPersonal();
  for (const c of L.personalVivo(estado)) { const d = $("#d-" + CSS.escape(c.id)); if (d) d.innerHTML = desglose(c); }
}

function hojaPersona(c) {
  abrirHoja(`<h2>${c ? "Editar colaborador" : "Nuevo colaborador"}</h2>
    <label class="etq" for="pe-nombre">Nombre</label>
    <input id="pe-nombre" class="campo" value="${esc(c ? c.nombre : "")}" autocomplete="off">
    <p class="error" id="pe-error"></p>
    <button class="boton primario" data-a="guardarPersona" data-id="${c ? esc(c.id) : ""}">Guardar</button>
    ${c ? `<button class="boton peligro" data-a="borrarPersona" data-id="${esc(c.id)}">Quitar del personal</button>` : ""}
    <button class="boton" data-a="cerrar">Cancelar</button>`);
  setTimeout(() => { const el = $("#pe-nombre"); if (el && !c) el.focus(); }, 250);
}

// ── Pestaña AJUSTES ─────────────────────────────────────────────
function vistaAjustes() {
  const tema = LS.get(K.tema) || "auto";
  const permiso = "Notification" in window ? Notification.permission : "no";
  const avisosOn = permiso === "granted" && LS.get(K.avisos) === "1";
  const mesActual = L.mesDe(hoy()), mesAnt = L.sumarMeses(mesActual, -1), anio = hoy().slice(0, 4);
  const pendientesCuotas = L.pagosVivos(estado).filter((p) => p.usaCuotas && p.cuotasRestantes == null);

  let html = `<section class="tarjeta"><h3>🔔 Avisos</h3>
    <p class="ayuda">Te aviso a las 8 de la mañana: 2 días antes de cada vencimiento y el mismo día.</p>
    ${avisosOn ? `<p style="color:var(--verde);font-weight:700">✅ Activados en este celular</p>
        <button class="boton" data-a="probarAvisos">Mandar un aviso de prueba</button>`
      : permiso === "denied" ? `<p class="error">Las notificaciones están bloqueadas. Activalas en los permisos del navegador para este sitio.</p>`
      : `<button class="boton primario" data-a="activarAvisos">Activar avisos en este celular</button>`}
    ${esIOS() && !instalada() ? `<p class="ayuda">En iPhone los avisos solo funcionan con la app instalada (ver abajo).</p>` : ""}
  </section>`;

  if (!instalada()) {
    html += `<section class="tarjeta"><h3>📲 Instalar en el celular</h3>
      ${instalarEvt ? `<button class="boton primario" data-a="instalar">Instalar Mis Pagos</button>`
        : esIOS() ? `<p class="ayuda">En Safari tocá <b>Compartir</b> (el cuadrado con la flecha) → <b>Agregar a inicio</b>.</p>`
        : `<p class="ayuda">En Chrome tocá los <b>tres puntitos ⋮</b> → <b>Agregar a la pantalla principal</b> (o “Instalar app”).</p>`}
    </section>`;
  }

  const grupos = ["casa", "local"].map((g) => {
    const ps = L.pagosVivos(estado).concat(estado.pagos.filter((p) => !p.borrado && p.activo === false))
      .filter((p) => p.grupo === g).sort((a, b) => a.nombre.localeCompare(b.nombre));
    return `<h3 class="seccion">${g === "casa" ? "🏠 Casa" : "🍽️ Local"} (${ps.length})</h3>` + ps.map((p) => `
      <button class="renglon" data-a="editarPago" data-p="${esc(p.id)}">
        <span><span style="font-weight:700">${esc(p.nombre)}</span><br><span class="sub">${esc(L.describirFrecuencia(p))}${
          p.activo === false ? " · pausado" : ""}${p.cuotasRestantes != null ? " · " + (p.cuotasRestantes === 0 ? "✔ terminado" : "faltan " + p.cuotasRestantes + " cuotas") : ""}${
          p.usaCuotas && p.cuotasRestantes == null ? ` · <span style="color:var(--naranja)">cargá las cuotas</span>` : ""}</span></span>
        <span aria-hidden="true">›</span></button>`).join("");
  }).join("");
  html += `<section class="tarjeta"><h3>📋 Mis pagos</h3>
    ${pendientesCuotas.length ? `<p class="ayuda" style="color:var(--naranja)">⚠️ Cargá cuántas cuotas faltan en: ${pendientesCuotas.map((p) => esc(p.nombre)).join(", ")}.</p>` : ""}
    ${grupos}
    <button class="boton primario" data-a="nuevoPago">+ Agregar un pago</button></section>`;

  html += `<section class="tarjeta"><h3>📄 Para el contador</h3>
    <label class="etq" for="exp-per">Período</label>
    <select id="exp-per" class="campo">
      <option value="${mesActual}">${L.nombreMes(mesActual)}</option>
      <option value="${mesAnt}" selected>${L.nombreMes(mesAnt)}</option>
      <option value="${anio}">Todo ${anio}</option>
      <option value="${Number(anio) - 1}">Todo ${Number(anio) - 1}</option>
    </select>
    <button class="boton primario" data-a="exportarLocal">Planilla de pagos del local</button>
    <button class="boton" data-a="exportarPersonal">Planilla de costo del personal</button>
    <p class="ayuda">Se abre en Excel. En el celular podés mandarla directo por WhatsApp o correo.</p></section>`;

  html += `<section class="tarjeta"><h3>💾 Respaldo</h3>
    <p class="ayuda">Tus datos quedan guardados en este celular <b>y</b> en el servidor, que además guarda una copia por día de los últimos 90 días.
    ${ui.sync.cuando ? `<br>Última vez guardado en el servidor: <b>${new Date(ui.sync.cuando).toLocaleTimeString("es-PY", { hour: "2-digit", minute: "2-digit" })}</b>` : ""}</p>
    <button class="boton" data-a="descargarRespaldo">Descargar una copia</button>
    <button class="boton" data-a="restaurar">Recuperar desde una copia</button>
    <input type="file" id="f-restaurar" accept=".json,application/json" class="oculto"></section>`;

  html += `<section class="tarjeta"><h3>🌓 Apariencia</h3>
    <div class="segmento">${[["auto", "Automático"], ["claro", "☀️ Claro"], ["oscuro", "🌙 Oscuro"]].map(([k, t]) =>
      `<button class="${tema === k ? "activo" : ""}" data-a="tema" data-v="${k}">${t}</button>`).join("")}</div></section>`;

  html += `<section class="tarjeta"><h3>🔒 Seguridad</h3>
    <button class="boton" data-a="cambiarPin">Cambiar el PIN</button>
    <button class="boton peligro" data-a="salir">Cerrar sesión en este celular</button></section>`;
  return html;
}

// ── Formulario de un pago (nuevo o editar) ─────────────────────
function borradorDe(p) {
  const f = (p && p.fechas) || [];
  const fecha = (i) => (f[i] ? { m: Number(f[i].split("-")[0]), d: Number(f[i].split("-")[1]) } : { m: "", d: "" });
  return {
    id: p ? p.id : null, nombre: p ? p.nombre : "", grupo: p ? p.grupo : (ui.grupo === "local" ? "local" : "casa"),
    tipo: p ? p.tipo || "otro" : "servicio", frecuencia: p ? p.frecuencia : "mensual",
    dia: p && p.dia ? p.dia : "", diaSemana: p && p.diaSemana != null ? p.diaSemana : 5,
    dias: p && p.dias ? p.dias.slice() : [15, 31], f0: fecha(0), f1: fecha(1),
    usaCuotas: !!(p && (p.usaCuotas || p.cuotasRestantes != null)), cuotasRestantes: p && p.cuotasRestantes != null ? p.cuotasRestantes : "",
    activo: p ? p.activo !== false : true,
  };
}
function opciones(lista, sel) { return lista.map(([v, t]) => `<option value="${v}" ${String(v) === String(sel) ? "selected" : ""}>${t}</option>`).join(""); }
const DIAS_MES = Array.from({ length: 31 }, (_, i) => [i + 1, String(i + 1)]);
function hojaPago() {
  const b = ui.borrador;
  const meses = [["", "—"]].concat(L.MESES.map((m, i) => [i + 1, m]));
  const diasF = [["", "—"]].concat(DIAS_MES);
  let cuando = "";
  if (b.frecuencia === "mensual") cuando = `<label class="etq" for="b-dia">Día de vencimiento</label>
    <select id="b-dia" class="campo" data-b="dia">${opciones([["", "Sin día fijo"]].concat(DIAS_MES), b.dia)}</select>`;
  if (b.frecuencia === "semanal") cuando = `<label class="etq" for="b-ds">Qué día de la semana</label>
    <select id="b-ds" class="campo" data-b="diaSemana">${opciones(L.DIAS_SEMANA.map((d, i) => [i, d]), b.diaSemana)}</select>`;
  if (b.frecuencia === "quincenal") {
    const d2 = DIAS_MES.map(([v, t]) => [v, v === 31 ? "Fin de mes" : t]);
    cuando = `<div class="dos"><div><label class="etq">1ª quincena, día</label><select class="campo" data-b="dias0">${opciones(DIAS_MES, b.dias[0])}</select></div>
      <div><label class="etq">2ª quincena, día</label><select class="campo" data-b="dias1">${opciones(d2, b.dias[1])}</select></div></div>`;
  }
  if (b.frecuencia === "anual") cuando = `<label class="etq">Fecha de vencimiento</label>
    <div class="dos"><select class="campo" data-b="f0d" aria-label="Día">${opciones(diasF, b.f0.d)}</select><select class="campo" data-b="f0m" aria-label="Mes">${opciones(meses, b.f0.m)}</select></div>
    <label class="etq">Segunda fecha en el año (opcional)</label>
    <div class="dos"><select class="campo" data-b="f1d" aria-label="Día">${opciones(diasF, b.f1.d)}</select><select class="campo" data-b="f1m" aria-label="Mes">${opciones(meses, b.f1.m)}</select></div>`;

  abrirHoja(`<h2>${b.id ? "Editar pago" : "Nuevo pago"}</h2>
    <label class="etq" for="b-nombre">Nombre</label>
    <input id="b-nombre" class="campo" data-b="nombre" value="${esc(b.nombre)}" placeholder="Ej: Luz" autocomplete="off">
    <label class="etq">Es de</label>
    <div class="segmento">${[["casa", "🏠 Casa"], ["local", "🍽️ Local"]].map(([k, t]) =>
      `<button class="${b.grupo === k ? "activo" : ""}" data-a="bGrupo" data-v="${k}">${t}</button>`).join("")}</div>
    <label class="etq" for="b-tipo">Rubro</label>
    <select id="b-tipo" class="campo" data-b="tipo">${opciones(Object.entries(L.TIPOS), b.tipo)}</select>
    <label class="etq" for="b-frec">Cada cuánto</label>
    <select id="b-frec" class="campo" data-b="frecuencia" data-redibujar>${opciones(Object.entries(L.FRECUENCIAS), b.frecuencia)}</select>
    ${cuando}
    <label class="interruptor" style="margin-top:14px">Se paga en cuotas (crédito, auto…)<input type="checkbox" data-b="usaCuotas" data-redibujar ${b.usaCuotas ? "checked" : ""}></label>
    ${b.usaCuotas ? `<label class="etq" for="b-cuotas">¿Cuántas cuotas faltan pagar?</label>
      <input id="b-cuotas" class="campo" data-b="cuotasRestantes" inputmode="numeric" value="${b.cuotasRestantes}" placeholder="Ej: 24">
      <p class="ayuda">Cada vez que lo tildes como pagado, se descuenta una.</p>` : ""}
    ${b.id ? `<label class="interruptor">Activo (si lo apagás, deja de aparecer)<input type="checkbox" data-b="activo" ${b.activo ? "checked" : ""}></label>` : ""}
    <p class="error" id="b-error"></p>
    <button class="boton primario" data-a="guardarPago">Guardar</button>
    ${b.id ? `<button class="boton peligro" data-a="borrarPago">Eliminar este pago</button>` : ""}
    <button class="boton" data-a="cerrar">Cancelar</button>`);
}
function leerCampoBorrador(el) {
  const b = ui.borrador, k = el.dataset.b;
  const v = el.type === "checkbox" ? el.checked : el.value;
  if (k === "dias0") b.dias[0] = Number(v);
  else if (k === "dias1") b.dias[1] = Number(v);
  else if (/^f[01][dm]$/.test(k)) b["f" + k[1]][k[2]] = v === "" ? "" : Number(v);
  else b[k] = v;
}
function guardarPago() {
  const b = ui.borrador;
  const nombre = b.nombre.trim();
  if (!nombre) { $("#b-error").textContent = "Poné un nombre"; return; }
  const fechas = [b.f0, b.f1].filter((f) => f.d && f.m).map((f) => `${String(f.m).padStart(2, "0")}-${String(f.d).padStart(2, "0")}`);
  const cuotas = b.usaCuotas && String(b.cuotasRestantes).trim() !== "" ? Math.max(0, parseInt(b.cuotasRestantes, 10) || 0) : null;
  const datos = {
    nombre, grupo: b.grupo, tipo: b.tipo, frecuencia: b.frecuencia,
    dia: b.frecuencia === "mensual" && b.dia ? Number(b.dia) : null,
    diaSemana: Number(b.diaSemana), dias: b.dias.map(Number), fechas,
    usaCuotas: !!b.usaCuotas, cuotasRestantes: cuotas, activo: !!b.activo,
  };
  if (b.id) {
    const p = estado.pagos.find((x) => x.id === b.id);
    Object.assign(p, datos); tocar(p);
  } else {
    estado.pagos.push(tocar(Object.assign({ id: L.nuevoId(), desde: hoy() }, datos)));
  }
  cerrarHoja(); cambio(); aviso(b.id ? "Pago actualizado" : `“${nombre}” agregado`);
}

// ── Exportar ────────────────────────────────────────────────────
function aCSV(filas) {
  return "﻿" + filas.map((f) => f.map((c) => {
    const s = String(c == null ? "" : c);
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(";")).join("\r\n");
}
async function descargar(nombre, contenido, tipo) {
  const blob = new Blob([contenido], { type: tipo });
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare) {
    try {
      const archivo = new File([blob], nombre, { type: tipo });
      if (navigator.canShare({ files: [archivo] })) { await navigator.share({ files: [archivo], title: nombre }); return; }
    } catch (e) { if (e.name === "AbortError") return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const etiquetaPeriodo = (per) => (per.length === 4 ? "Año " + per : L.nombreMes(per));
function exportarLocal() {
  const per = $("#exp-per").value;
  const regs = L.registrosVigentes(estado.registros).filter((r) => r.grupo === "local" && r.fechaPago.startsWith(per))
    .sort((a, b) => a.fechaPago.localeCompare(b.fechaPago));
  if (!regs.length) { aviso("No hay pagos del local cargados en " + etiquetaPeriodo(per)); return; }
  const total = regs.reduce((s, r) => s + (Number(r.monto) || 0), 0);
  const porRubro = {};
  regs.forEach((r) => { const k = L.TIPOS[r.tipo] || "Otros"; porRubro[k] = (porRubro[k] || 0) + Number(r.monto); });
  const pago = (r) => estado.pagos.find((p) => p.id === r.pagoId) || { frecuencia: "" };
  const filas = [
    ["Pagos del local — " + etiquetaPeriodo(per)], [],
    ["Fecha de pago", "Concepto", "Rubro", "Corresponde a", "Vencimiento", "Monto (Gs)", "Nota"],
    ...regs.map((r) => [L.fechaDMA(r.fechaPago), r.nombre, L.TIPOS[r.tipo] || "", periodoLegible(pago(r), r.periodo),
      r.venc ? L.fechaDMA(r.venc) : "", Number(r.monto), r.nota || ""]),
    ["", "", "", "", "TOTAL", total], [],
    ["Totales por rubro"], ...Object.entries(porRubro).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]),
  ];
  descargar(`pagos-local-${per}.csv`, aCSV(filas), "text/csv");
}
function exportarPersonal() {
  const cfg = estado.config || {};
  const gente = L.personalVivo(estado);
  const filas = [["Costo mensual del personal del local"], ["IPS patronal", (cfg.ipsPatronal != null ? cfg.ipsPatronal : 16.5) + "%"], [],
    ["Colaborador", "Sueldo semanal", "Sueldo mensual (×52÷12)", "IPS patronal", "Aguinaldo prorrateado", "Extras", "Costo mensual real"]];
  let tot = 0;
  gente.forEach((c) => { const k = L.costoColaborador(c, cfg); tot += k.total;
    filas.push([c.nombre, Number(c.sueldoSemanal) || 0, k.mensual, k.ips, k.aguinaldo, k.extras, k.total]); });
  filas.push(["TOTAL", "", "", "", "", "", tot]);
  descargar(`costo-personal-${hoy()}.csv`, aCSV(filas), "text/csv");
}

// ── Notificaciones ──────────────────────────────────────────────
function claveAUint8(base64) {
  const relleno = "=".repeat((4 - (base64.length % 4)) % 4);
  const bin = atob((base64 + relleno).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function suscribirAvisos() {
  const reg = await navigator.serviceWorker.ready;
  const { clave } = await api("push/clave");
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    // Si el servidor cambió de clave, hay que suscribirse de nuevo
    const actual = sub.options && sub.options.applicationServerKey;
    if (actual && btoa(String.fromCharCode(...new Uint8Array(actual))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== clave) {
      await sub.unsubscribe(); sub = null;
    }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: claveAUint8(clave) });
  await api("push/suscribir", { sub: sub.toJSON() });
}
async function activarAvisos() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    aviso(esIOS() ? "En iPhone primero instalá la app (Compartir → Agregar a inicio) y abrila desde el ícono." : "Este navegador no permite notificaciones.", 6000);
    return;
  }
  const permiso = await Notification.requestPermission();
  if (permiso !== "granted") { aviso("No se dio permiso para las notificaciones.", 5000); render(true); return; }
  try {
    await suscribirAvisos();
    LS.set(K.avisos, "1");
    aviso("✅ Listo. Te aviso 2 días antes y el mismo día del vencimiento.", 5000);
  } catch (e) { aviso("No se pudo activar: " + e.message, 6000); }
  render(true);
}

// ── Entrada con PIN ─────────────────────────────────────────────
async function renderEntrada() {
  const p = $("#principal");
  if (ui.pinModo === null) {
    p.innerHTML = `<div class="entrada"><p>Cargando…</p></div>`;
    try { const j = await api("acceso"); ui.pinModo = j.tienePin ? "entrar" : "crear"; }
    catch (e) {
      p.innerHTML = `<div class="entrada"><h2>Sin conexión</h2><p class="ayuda">Para entrar hace falta internet.</p>
        <button class="boton primario" data-a="reintentar" style="max-width:300px">Reintentar</button></div>`;
      return;
    }
  }
  const titulo = ui.pinModo === "entrar" ? "Ingresá tu PIN" : ui.pinPrimero == null ? "Elegí un PIN de 4 números" : "Repetí el PIN para confirmar";
  const sub = ui.pinModo === "crear" ? "Lo vas a usar para entrar desde cualquier celular." : "";
  const teclas = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"];
  p.innerHTML = `<div class="entrada">
    <img src="icono-192.png" alt="">
    <h1 style="font-size:1.5rem">Mis Pagos</h1>
    <p style="font-size:1.15rem;font-weight:700;margin:18px 0 4px">${titulo}</p>
    <p class="ayuda">${sub}</p>
    <div class="puntos">${[0, 1, 2, 3].map((i) => `<i class="${i < ui.pin.length ? "lleno" : ""}"></i>`).join("")}</div>
    <p class="error">${esc(ui.pinError)}</p>
    <div class="teclado">${teclas.map((t) => t === "" ? "<span></span>"
      : `<button class="${t === "⌫" ? "sin" : ""}" data-a="tecla" data-v="${t}" aria-label="${t === "⌫" ? "Borrar" : t}">${t}</button>`).join("")}</div>
  </div>`;
}
async function tecla(v) {
  if (v === "⌫") { ui.pin = ui.pin.slice(0, -1); renderEntrada(); return; }
  if (ui.pin.length >= 4) return;
  ui.pin += v; ui.pinError = "";
  renderEntrada();
  if (ui.pin.length < 4) return;
  const pin = ui.pin;
  try {
    let j;
    if (ui.pinModo === "entrar") j = await api("entrar", { pin });
    else if (ui.pinPrimero == null) { ui.pinPrimero = pin; ui.pin = ""; renderEntrada(); return; }
    else if (ui.pinPrimero !== pin) { ui.pinPrimero = null; throw new Error("No coinciden. Empecemos de nuevo."); }
    else j = await api("crear-pin", { pin });
    token = j.token; LS.set(K.token, token);
    ui.pin = ""; ui.pinPrimero = null; ui.pinError = ""; ui.pinModo = null;
    render(true); sincronizar(); reactivarAvisos();
  } catch (e) {
    ui.pin = ""; ui.pinError = e.message; renderEntrada();
  }
}

// ── Hoja (ventana desde abajo) ─────────────────────────────────
function abrirHoja(html) {
  $("#hoja-cont").innerHTML = `<div class="velo" data-fondo><div class="hoja" role="dialog" aria-modal="true"><div class="agarre"></div>${html}</div></div>`;
  ui.hojaAbierta = true;
}
function cerrarHoja() {
  pararVoz();
  $("#hoja-cont").innerHTML = "";
  ui.hojaAbierta = false; ui.borrador = null;
  if (ui.renderPendiente) render();
}

// ════════════════════════════════════════════════════════════════
//  ACCIONES (toques)
// ════════════════════════════════════════════════════════════════
const acciones = {
  tab: (el) => { ui.tab = el.dataset.v; render(true); scrollTo(0, 0); },
  grupo: (el) => { ui.grupo = el.dataset.v; LS.set(K.grupo, ui.grupo); render(true); },
  abrirPago: (el) => abrirPago(el.dataset.p, el.dataset.per),
  usarMonto: (el) => { $("#f-monto").value = L.miles(el.dataset.v); },
  confirmarPago: (el) => confirmarPago(el.dataset.p, el.dataset.per),
  desmarcar: (el) => desmarcar(el.dataset.p, el.dataset.per),
  cerrar: () => cerrarHoja(),
  voz: () => abrirVoz(),
  vozOtraVez: () => escuchar(window.SpeechRecognition || window.webkitSpeechRecognition, "es-PY"),
  vozEscrita: () => { const t = $("#v-escrito").value.trim(); if (t) { $("#v-texto").textContent = "“" + t + "”"; procesarVoz(t); } },
  vozElegir: (el) => {
    if (!el.dataset.per) { aviso("Ese ya está pagado"); return; }
    abrirPago(el.dataset.p, el.dataset.per, Number(el.dataset.m) || null);
  },
  mes: (el) => {
    const n = L.sumarMeses(ui.mesHist, Number(el.dataset.v));
    if (n <= L.mesDe(hoy())) { ui.mesHist = n; render(true); }
  },
  irMes: (el) => { ui.mesHist = el.dataset.v; render(true); },
  editarPersona: (el) => hojaPersona(estado.personal.find((c) => c.id === el.dataset.id)),
  agregarPersona: () => hojaPersona(null),
  guardarPersona: (el) => {
    const nombre = $("#pe-nombre").value.trim();
    if (!nombre) { $("#pe-error").textContent = "Poné un nombre"; return; }
    if (el.dataset.id) tocar(Object.assign(estado.personal.find((c) => c.id === el.dataset.id), { nombre }));
    else estado.personal.push(tocar({ id: L.nuevoId(), nombre, sueldoSemanal: 0, ips: true, aguinaldo: true, extras: 0 }));
    cerrarHoja(); cambio();
  },
  borrarPersona: (el) => {
    const c = estado.personal.find((x) => x.id === el.dataset.id);
    if (!confirm(`¿Quitar a ${c.nombre} del personal?`)) return;
    c.borrado = true; tocar(c); cerrarHoja(); cambio();
  },
  nuevoPago: () => { ui.borrador = borradorDe(null); hojaPago(); },
  editarPago: (el) => { ui.borrador = borradorDe(estado.pagos.find((p) => p.id === el.dataset.p)); hojaPago(); },
  bGrupo: (el) => { ui.borrador.grupo = el.dataset.v; hojaPago(); },
  guardarPago: () => guardarPago(),
  borrarPago: () => {
    const p = estado.pagos.find((x) => x.id === ui.borrador.id);
    if (!confirm(`¿Eliminar “${p.nombre}”? Lo que ya pagaste queda en el historial.`)) return;
    p.borrado = true; tocar(p); cerrarHoja(); cambio(); aviso("Pago eliminado");
  },
  exportarLocal: () => exportarLocal(),
  exportarPersonal: () => exportarPersonal(),
  descargarRespaldo: () => descargar(`mis-pagos-respaldo-${hoy()}.json`, JSON.stringify(estado, null, 1), "application/json"),
  restaurar: () => $("#f-restaurar").click(),
  tema: (el) => { LS.set(K.tema, el.dataset.v); aplicarTema(); render(true); },
  activarAvisos: () => activarAvisos(),
  probarAvisos: async () => {
    try { await suscribirAvisos(); const r = await api("push/probar", {}); aviso(r.enviados ? "Aviso enviado. Debería llegarte en unos segundos." : "No hay celulares para avisar."); }
    catch (e) { aviso("No se pudo: " + e.message, 5000); }
  },
  instalar: async () => { if (!instalarEvt) return; instalarEvt.prompt(); await instalarEvt.userChoice; instalarEvt = null; render(true); },
  cambiarPin: () => abrirHoja(`<h2>Cambiar el PIN</h2>
    <label class="etq" for="cp-a">PIN actual</label><input id="cp-a" class="campo" type="password" inputmode="numeric" maxlength="6" autocomplete="off">
    <label class="etq" for="cp-n">PIN nuevo (4 números)</label><input id="cp-n" class="campo" type="password" inputmode="numeric" maxlength="4" autocomplete="off">
    <p class="ayuda">Al cambiarlo, se cierra la sesión en todos los otros celulares.</p>
    <p class="error" id="cp-e"></p>
    <button class="boton primario" data-a="guardarPin">Cambiar</button><button class="boton" data-a="cerrar">Cancelar</button>`),
  guardarPin: async () => {
    const nuevo = $("#cp-n").value;
    if (!/^\d{4}$/.test(nuevo)) { $("#cp-e").textContent = "El PIN nuevo tiene que ser de 4 números"; return; }
    try { await api("cambiar-pin", { actual: $("#cp-a").value, nuevo }); cerrarHoja(); aviso("PIN cambiado ✅"); }
    catch (e) { $("#cp-e").textContent = e.message; }
  },
  salir: async () => {
    if (!confirm("¿Cerrar sesión en este celular? Vas a necesitar el PIN para volver a entrar.")) return;
    try { await api("salir", {}); } catch (e) { /* igual se cierra acá */ }
    token = null; LS.del(K.token); ui.pinModo = null; render(true);
  },
  tecla: (el) => tecla(el.dataset.v),
  reintentar: () => render(true),
};

document.addEventListener("click", (e) => {
  if (e.target.matches && e.target.matches("[data-fondo]")) { cerrarHoja(); return; }
  const el = e.target.closest("[data-a]");
  if (el && acciones[el.dataset.a]) { e.preventDefault(); acciones[el.dataset.a](el, e); }
});

document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.matches("[data-gs]")) { const v = L.leerMonto(el.value); el.value = v ? L.miles(v) : ""; }
  if (el.matches("[data-b]") && ui.borrador) leerCampoBorrador(el);
});

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.matches("[data-b]") && ui.borrador) { leerCampoBorrador(el); if (el.matches("[data-redibujar]")) hojaPago(); return; }
  if (el.matches("[data-persona]")) {
    const c = estado.personal.find((x) => x.id === el.dataset.persona);
    const k = el.dataset.campo;
    c[k] = el.type === "checkbox" ? el.checked : L.leerMonto(el.value);
    tocar(c); guardarLocal(); programarSync(); actualizarCostos();
    return;
  }
  if (el.matches("[data-cfg]")) {
    const v = Number(String(el.value).replace(",", "."));
    if (!Number.isFinite(v) || v < 0 || v > 100) { aviso("Poné un porcentaje válido, ej: 16,5"); return; }
    estado.config = tocar(Object.assign({}, estado.config, { [el.dataset.cfg]: v }));
    guardarLocal(); programarSync(); actualizarCostos();
    return;
  }
  if (el.id === "f-restaurar" && el.files[0]) {
    el.files[0].text().then((txt) => {
      let e2;
      try { e2 = JSON.parse(txt); } catch (err) { aviso("Ese archivo no es una copia de Mis Pagos"); return; }
      if (!L.esEstadoValido(e2)) { aviso("Ese archivo no es una copia de Mis Pagos"); return; }
      if (!confirm(`La copia tiene ${e2.pagos.length} pagos y ${e2.registros.length} registros. ¿Recuperarla? (Se suma a lo que ya hay, no borra nada.)`)) return;
      estado = L.fusionarEstado(estado, e2); cambio(); aviso("Copia recuperada ✅");
    });
  }
});

document.addEventListener("keydown", (e) => {
  if (!token && /^[0-9]$/.test(e.key)) tecla(e.key);
  else if (!token && e.key === "Backspace") tecla("⌫");
  else if (e.key === "Escape" && ui.hojaAbierta) cerrarHoja();
  else if (e.key === "Enter" && e.target.id === "v-escrito") acciones.vozEscrita();
});
document.addEventListener("focusout", () => {
  setTimeout(() => {
    const f = document.activeElement;
    if (ui.renderPendiente && !(f && f.matches("input,select,textarea"))) render();
  }, 200);
});

// ── Arranque ────────────────────────────────────────────────────
async function reactivarAvisos() {
  if (LS.get(K.avisos) === "1" && "Notification" in window && Notification.permission === "granted" && "serviceWorker" in navigator) {
    try { await suscribirAvisos(); } catch (e) { /* se reintenta la próxima vez */ }
  }
}
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); instalarEvt = e; if (ui.tab === "ajustes") render(); });
window.addEventListener("online", () => sincronizar());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { render(); sincronizar(); } });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", aplicarTema);
setInterval(() => { if (document.visibilityState === "visible") sincronizar(); }, 30000);

$("#app").innerHTML = `<div id="principal"></div><div id="hoja-cont"></div>`;
aplicarTema();
render(true);
if (token) { sincronizar(); reactivarAvisos(); }
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { /* sin modo sin conexión */ });
