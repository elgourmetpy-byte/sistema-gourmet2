/* ════════════════════════════════════════════════════════════════
   Mis Pagos — lógica compartida (la usan el celular y el servidor)
   Fechas siempre como texto "AAAA-MM-DD" (sin horas ni zonas).
   ════════════════════════════════════════════════════════════════ */
(function (raiz, fabrica) {
  if (typeof module === "object" && module.exports) module.exports = fabrica();
  else raiz.Logica = fabrica();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DIAS_SEMANA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const DIAS_CORTOS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
    "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const TIPOS = {
    servicio: "Servicios", tarjeta: "Tarjetas", credito: "Créditos y cuotas",
    seguro: "Seguros y salud", educacion: "Educación", impuesto: "Impuestos y patentes",
    personal: "Personal y ayuda", otro: "Otros",
  };
  const FRECUENCIAS = { semanal: "Semanal", quincenal: "Quincenal", mensual: "Mensual", anual: "Anual" };
  const GRUPOS = { casa: "Casa", local: "Local" };

  // ── Fechas ──────────────────────────────────────────────────────
  const pad = (n) => String(n).padStart(2, "0");
  const aISO = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`; // m de 1 a 12
  function partes(iso) { const [y, m, d] = iso.split("-").map(Number); return { y, m, d }; }
  const diasDelMes = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  function sumarDias(iso, n) {
    const { y, m, d } = partes(iso);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return aISO(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  /** Días desde `a` hasta `b` (positivo si b es después). */
  function diferenciaDias(a, b) {
    const pa = partes(a), pb = partes(b);
    return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
  }
  function diaSemana(iso) { const { y, m, d } = partes(iso); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
  function hoyLocal() { const t = new Date(); return aISO(t.getFullYear(), t.getMonth() + 1, t.getDate()); }
  function hoyEnZona(zona) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
  function horaEnZona(zona) {
    return Number(new Intl.DateTimeFormat("en-GB", { timeZone: zona, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  }
  const mesDe = (iso) => iso.slice(0, 7);
  const inicioDeMes = (iso) => iso.slice(0, 8) + "01";
  function finDeMes(iso) { const { y, m } = partes(iso); return aISO(y, m, diasDelMes(y, m)); }
  function sumarMeses(mes, n) {
    let [y, m] = mes.split("-").map(Number);
    m += n;
    while (m > 12) { m -= 12; y++; }
    while (m < 1) { m += 12; y--; }
    return `${y}-${pad(m)}`;
  }
  function nombreMes(mes) { const [y, m] = mes.split("-").map(Number); return `${MESES[m - 1]} ${y}`; }
  function fechaLarga(iso) { const { m, d } = partes(iso); return `${DIAS_SEMANA[diaSemana(iso)]} ${d} de ${MESES[m - 1]}`; }
  function fechaCorta(iso) { const { m, d } = partes(iso); return `${DIAS_CORTOS[diaSemana(iso)]} ${d}/${pad(m)}`; }
  function fechaDMA(iso) { const { y, m, d } = partes(iso); return `${pad(d)}/${pad(m)}/${y}`; }

  // ── Plata ───────────────────────────────────────────────────────
  function miles(n) {
    const v = Math.round(Number(n) || 0);
    return (v < 0 ? "-" : "") + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }
  const fmtGs = (n) => "Gs. " + miles(n);
  /** "1.250.000" o "1250000" → 1250000 */
  function leerMonto(txt) { const v = Number(String(txt || "").replace(/[^\d]/g, "")); return Number.isFinite(v) ? v : 0; }

  function nuevoId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // ── Cuándo vence cada pago ──────────────────────────────────────
  /**
   * Todas las veces que vence un pago entre `desde` y `hasta` (inclusive).
   * Cada vez tiene un `periodo` fijo que identifica ese pago puntual
   * (mensual "2026-10", quincenal "2026-10-q1", semanal y anual = la fecha).
   * `venc` es null para los pagos "sin día fijo".
   */
  function ocurrencias(p, desde, hasta) {
    const res = [];
    if (!p || p.borrado) return res;
    const inicio = p.desde && p.desde > desde ? p.desde : desde;
    if (inicio > hasta) return res;
    const agregar = (periodo, venc, mes) => res.push({ pagoId: p.id, periodo, venc, mes: mes || mesDe(venc) });
    const enRango = (v) => v >= inicio && v <= hasta;

    if (p.frecuencia === "semanal") {
      const ds = p.diaSemana == null ? 5 : Number(p.diaSemana);
      let f = sumarDias(inicio, (ds - diaSemana(inicio) + 7) % 7);
      for (; f <= hasta; f = sumarDias(f, 7)) agregar(f, f);
      return res;
    }
    for (let mes = mesDe(inicio); mes <= mesDe(hasta); mes = sumarMeses(mes, 1)) {
      const [y, m] = mes.split("-").map(Number);
      const dm = diasDelMes(y, m);
      if (p.frecuencia === "mensual") {
        if (p.dia) { const v = aISO(y, m, Math.min(p.dia, dm)); if (enRango(v)) agregar(mes, v); }
        else agregar(mes, null, mes);
      } else if (p.frecuencia === "quincenal") {
        const dias = Array.isArray(p.dias) && p.dias.length === 2 && p.dias[0] && p.dias[1] ? p.dias : null;
        [0, 1].forEach((i) => {
          const per = `${mes}-q${i + 1}`;
          if (dias) { const v = aISO(y, m, Math.min(dias[i], dm)); if (enRango(v)) agregar(per, v); }
          else agregar(per, null, mes);
        });
      } else if (p.frecuencia === "anual") {
        (p.fechas || []).forEach((md) => {
          const [mm, dd] = String(md).split("-").map(Number);
          if (mm !== m || !dd) return;
          const v = aISO(y, m, Math.min(dd, dm));
          if (enRango(v)) agregar(v, v);
        });
      }
    }
    return res;
  }

  const claveReg = (pagoId, periodo) => pagoId + "|" + periodo;
  /** Registros de pago válidos; si dos celulares tildaron el mismo pago, queda uno solo. */
  function registrosVigentes(regs) {
    const m = new Map();
    for (const r of regs || []) {
      if (r.borrado) continue;
      const k = claveReg(r.pagoId, r.periodo);
      const prev = m.get(k);
      if (!prev || (r.updatedAt || 0) > (prev.updatedAt || 0)) m.set(k, r);
    }
    return [...m.values()];
  }
  function indexarRegistros(regs) {
    const m = new Map();
    for (const r of registrosVigentes(regs)) m.set(claveReg(r.pagoId, r.periodo), r);
    return m;
  }
  /** pagado | vencido | pronto (2 días o menos) | pendiente | sinfecha */
  function estadoDe(oc, idx, hoy) {
    const r = idx.get(claveReg(oc.pagoId, oc.periodo));
    if (r) return { estado: "pagado", registro: r };
    if (!oc.venc) return { estado: "sinfecha" };
    const d = diferenciaDias(hoy, oc.venc);
    if (d < 0) return { estado: "vencido", dias: d };
    if (d <= 2) return { estado: "pronto", dias: d };
    return { estado: "pendiente", dias: d };
  }
  const terminado = (p) => p.cuotasRestantes === 0;
  const pagosVivos = (est) => (est.pagos || []).filter((p) => !p.borrado && p.activo !== false);

  const ORDEN = { vencido: 0, pronto: 1, pendiente: 2, sinfecha: 3, pagado: 4 };
  /**
   * Lo que se ve en la pantalla principal: los pagos de este mes, los
   * vencidos que quedaron sin pagar (hasta 60 días atrás) y lo que vence
   * en los próximos 7 días aunque sea del mes que viene.
   */
  function listaActual(est, hoy) {
    const idx = indexarRegistros(est.registros);
    const ini = inicioDeMes(hoy), fin = finDeMes(hoy);
    const atras = sumarDias(hoy, -60), adelante = sumarDias(hoy, 7);
    const hasta = adelante > fin ? adelante : fin;
    const out = [];
    for (const p of pagosVivos(est)) {
      for (const oc of ocurrencias(p, atras, hasta)) {
        const e = estadoDe(oc, idx, hoy);
        const pagado = e.estado === "pagado";
        if (terminado(p) && !pagado) continue;
        if (p.frecuencia === "semanal") {
          if (pagado) { if (oc.venc < ini || oc.venc > fin) continue; }
          else if (oc.venc > sumarDias(hoy, 6)) continue;
        } else if (oc.venc === null) {
          if (oc.mes !== mesDe(hoy)) continue;
        } else if (oc.venc < ini || oc.venc > fin) {
          if (pagado) continue;
        }
        out.push({ pago: p, oc, ...e });
      }
    }
    out.sort((a, b) => ORDEN[a.estado] - ORDEN[b.estado]
      || String(a.oc.venc || "9999").localeCompare(String(b.oc.venc || "9999"))
      || a.pago.nombre.localeCompare(b.pago.nombre));
    return out;
  }

  /** Pagos sin pagar que vencen hoy o dentro de 2 días (para la notificación). */
  function avisosDelDia(est, hoy) {
    const idx = indexarRegistros(est.registros);
    const en2 = sumarDias(hoy, 2);
    const res = { hoy: [], en2: [] };
    for (const p of pagosVivos(est)) {
      if (terminado(p)) continue;
      for (const oc of ocurrencias(p, hoy, en2)) {
        if (idx.has(claveReg(oc.pagoId, oc.periodo))) continue;
        if (oc.venc === hoy) res.hoy.push(p);
        else if (oc.venc === en2) res.en2.push(p);
      }
    }
    return res;
  }
  function textoAviso(av) {
    const nom = (p) => `${p.nombre} (${GRUPOS[p.grupo]})`;
    const lineas = [];
    if (av.hoy.length) lineas.push("Vence HOY: " + av.hoy.map(nom).join(", "));
    if (av.en2.length) lineas.push("Vence en 2 días: " + av.en2.map(nom).join(", "));
    if (!lineas.length) return null;
    return {
      titulo: av.hoy.length ? `⚠️ Hoy vence${av.hoy.length > 1 ? "n" : ""} ${av.hoy.length} pago${av.hoy.length > 1 ? "s" : ""}` : "🟠 Pagos que vencen pronto",
      cuerpo: lineas.join("\n"),
    };
  }

  function ultimoRegistro(pagoId, regs) {
    let u = null;
    for (const r of registrosVigentes(regs)) {
      if (r.pagoId !== pagoId) continue;
      if (!u || r.fechaPago > u.fechaPago || (r.fechaPago === u.fechaPago && (r.updatedAt || 0) > (u.updatedAt || 0))) u = r;
    }
    return u;
  }

  function describirFrecuencia(p) {
    const f = FRECUENCIAS[p.frecuencia] || p.frecuencia;
    if (p.frecuencia === "semanal") return `${f} · los ${DIAS_SEMANA[p.diaSemana == null ? 5 : p.diaSemana]}`;
    if (p.frecuencia === "mensual") return p.dia ? `${f} · día ${p.dia}` : `${f} · sin día fijo`;
    if (p.frecuencia === "quincenal") {
      if (!(Array.isArray(p.dias) && p.dias[0] && p.dias[1])) return `${f} · sin día fijo`;
      const d2 = p.dias[1] >= 31 ? "fin de mes" : p.dias[1];
      return `${f} · días ${p.dias[0]} y ${d2}`;
    }
    if (p.frecuencia === "anual") {
      const fs = (p.fechas || []).map((md) => { const [m, d] = md.split("-"); return `${d}/${m}`; });
      return fs.length ? `${f} · ${fs.join(" y ")}` : `${f} · fecha a definir`;
    }
    return f;
  }

  // ── Historial ───────────────────────────────────────────────────
  function registrosDelMes(est, mes) {
    return registrosVigentes(est.registros).filter((r) => mesDe(r.fechaPago) === mes)
      .sort((a, b) => b.fechaPago.localeCompare(a.fechaPago) || a.nombre.localeCompare(b.nombre));
  }
  function totalesDelMes(est, mes) {
    const t = { casa: 0, local: 0, total: 0, porTipo: {} };
    for (const r of registrosDelMes(est, mes)) {
      const v = Number(r.monto) || 0;
      t[r.grupo] = (t[r.grupo] || 0) + v;
      t.total += v;
      const k = r.tipo || "otro";
      t.porTipo[k] = t.porTipo[k] || { casa: 0, local: 0, total: 0 };
      t.porTipo[k][r.grupo] += v;
      t.porTipo[k].total += v;
    }
    return t;
  }

  // ── Personal ────────────────────────────────────────────────────
  /** Costo mensual real = sueldo semanal × 52 ÷ 12 + IPS patronal + aguinaldo prorrateado + extras. */
  function costoColaborador(c, cfg) {
    const sem = Number(c.sueldoSemanal) || 0;
    const mensual = sem * 52 / 12;
    const pct = Number((cfg && cfg.ipsPatronal) != null ? cfg.ipsPatronal : 16.5) || 0;
    const ips = c.ips ? mensual * pct / 100 : 0;
    const aguinaldo = c.aguinaldo !== false ? mensual / 12 : 0;
    const extras = Number(c.extras) || 0;
    return {
      mensual: Math.round(mensual), ips: Math.round(ips), aguinaldo: Math.round(aguinaldo),
      extras: Math.round(extras), total: Math.round(mensual + ips + aguinaldo + extras),
    };
  }
  const personalVivo = (est) => (est.personal || []).filter((c) => !c.borrado);

  // ── Voz: "pagué la luz del local 350 mil" ──────────────────────
  function normalizar(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/(\d),(\d{3})\b/g, "$1.$2")
      .replace(/[^a-z0-9\s.,]/g, " ").replace(/\s+/g, " ").trim();
  }
  const VACIAS = new Set(("ya pague pagamos pago pagado pagada pagar pagaste pague cancele abone abonamos " +
    "la el los las de del al a y con en por para se me lo le un una mi mis su sus que es son esta este hoy " +
    "guarani guaranies gs mil millon millones lucas km").split(" "));
  const PALABRAS_GRUPO = ["local", "negocio", "restaurante", "restaurant", "gourmet", "comercio", "casa", "hogar"];
  const SINONIMOS = {
    ande: "luz", electricidad: "luz", energia: "luz", corriente: "luz", essap: "agua",
    wifi: "internet", telefono: "claro", telefonia: "claro", celular: "claro", linea: "claro",
    cable: "satelital", tele: "satelital", television: "satelital", tv: "satelital", imagen: "satelital",
    facu: "facundo", universidad: "universitaria", facultad: "universitaria", uni: "universitaria",
    coope: "cooperativa", coop: "cooperativa", depto: "departamento", dpto: "departamento",
    carro: "auto", vehiculo: "auto", camioneta: "auto", municipalidad: "patente", municipal: "patente",
    bus: "colectivo", omnibus: "colectivo", bnf: "fomento", tarjetas: "tarjeta", prestamo: "credito",
    creditos: "credito", garrafa: "gas", jardin: "jardinero", seguros: "seguro",
  };
  function palabras(s) {
    return normalizar(s).replace(/[.,]/g, " ").split(" ")
      .filter((t) => t && !VACIAS.has(t) && !/^\d+$/.test(t))
      .map((t) => SINONIMOS[t] || t);
  }
  const coincide = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

  function extraerMonto(texto) {
    const s = " " + normalizar(texto).replace(/\bun millon\b/g, "1 millon").replace(/\bmedio millon\b/g, "500000") + " ";
    const re = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?\s*(millones|millon|mil|lucas)?/g;
    let total = 0, hay = false, m;
    while ((m = re.exec(s))) {
      let v = Number(m[1].replace(/\./g, ""));
      if (m[2] === "mil" || m[2] === "lucas") v *= 1000;
      else if (m[2]) v *= 1000000;
      if (m[2] || v >= 1000) { total += v; hay = true; }
    }
    return hay ? total : null;
  }

  /** Devuelve qué pago(s) nombró la persona, de qué grupo y si dijo un monto. */
  function interpretarVoz(texto, pagos) {
    const n = normalizar(texto);
    let grupo = null;
    if (/\b(local|negocio|restaurante|restaurant|gourmet|comercio)\b/.test(n)) grupo = "local";
    else if (/\b(casa|hogar)\b/.test(n)) grupo = "casa";
    const dichas = palabras(n).filter((t) => !PALABRAS_GRUPO.includes(t));
    let mejores = [], max = 0;
    for (const p of pagos) {
      if (grupo && p.grupo !== grupo) continue;
      const delNombre = [...new Set(palabras(p.nombre))];
      let ok = 0;
      for (const t of delNombre) if (dichas.some((d) => coincide(d, t))) ok++;
      if (!ok) continue;
      const puntos = ok * 10 - (delNombre.length - ok);
      if (puntos > max) { max = puntos; mejores = [p]; } else if (puntos === max) mejores.push(p);
    }
    return { texto, grupo, monto: extraerMonto(texto), candidatos: mejores };
  }

  // ── Juntar datos de dos celulares (gana el cambio más nuevo) ───
  function fusionarLista(a, b) {
    const m = new Map();
    for (const x of a || []) m.set(x.id, x);
    for (const y of b || []) {
      const x = m.get(y.id);
      if (!x || (y.updatedAt || 0) > (x.updatedAt || 0)) m.set(y.id, y);
    }
    return [...m.values()];
  }
  function estadoVacio() { return { version: 1, pagos: [], registros: [], personal: [], config: {} }; }
  function fusionarEstado(a, b) {
    if (!a) return b; if (!b) return a;
    const ca = a.config || {}, cb = b.config || {};
    return {
      version: 1,
      pagos: fusionarLista(a.pagos, b.pagos),
      registros: fusionarLista(a.registros, b.registros),
      personal: fusionarLista(a.personal, b.personal),
      config: (cb.updatedAt || 0) > (ca.updatedAt || 0) ? cb : ca,
    };
  }
  function esEstadoValido(e) {
    return !!e && typeof e === "object" && Array.isArray(e.pagos) && Array.isArray(e.registros)
      && (e.personal == null || Array.isArray(e.personal));
  }

  // ── Datos iniciales (los pagos que pasó Raúl) ──────────────────
  function semilla(hoy) {
    const t = Date.now();
    const P = (nombre, grupo, tipo, frecuencia, extra) => Object.assign({
      id: nuevoId(), nombre, grupo, tipo, frecuencia, dia: null, cuotasRestantes: null,
      desde: hoy, activo: true, updatedAt: t,
    }, extra || {});
    const mens = (nombre, grupo, tipo, dia, extra) => P(nombre, grupo, tipo, "mensual", Object.assign({ dia }, extra));
    const quin = (nombre, grupo, tipo) => P(nombre, grupo, tipo, "quincenal", { dias: [15, 31] });
    const credito = { usaCuotas: true };
    const pagos = [
      // Casa — mensuales
      mens("Luz", "casa", "servicio", 10),
      mens("Agua", "casa", "servicio", 10),
      mens("Claro telefonía", "casa", "servicio", 10),
      mens("Tigo imagen satelital", "casa", "servicio", 10),
      mens("Tigo internet de Facundo", "casa", "servicio", 10),
      mens("Luz del departamento de Facundo", "casa", "servicio", 10),
      mens("Cuota universitaria de Facundo", "casa", "educacion", 4),
      mens("Colectivo universitario de Naomi", "casa", "educacion", null),
      mens("Cuota del auto 0 km", "casa", "credito", 14, credito),
      mens("IPS de Claudia", "casa", "seguro", 14),
      mens("Seguro CEMEP", "casa", "seguro", 15),
      mens("Seguro médico familiar Colonias Unidas", "casa", "seguro", null),
      // Casa — tarjetas
      mens("Tarjeta Bancop", "casa", "tarjeta", 6),
      mens("Tarjeta Continental", "casa", "tarjeta", 7),
      mens("Tarjeta Sudameris", "casa", "tarjeta", 7),
      mens("Tarjeta Cooperativa Universitaria", "casa", "tarjeta", 7),
      // Casa — créditos
      mens("Crédito Banco de Fomento", "casa", "credito", 10, credito),
      mens("Crédito Cooperativa Universitaria", "casa", "credito", 18, credito),
      mens("Crédito Cooperativa San Florián", "casa", "credito", 25, credito),
      // Casa — otros
      P("Irma", "casa", "personal", "semanal", { diaSemana: 5 }),
      quin("Jardinero", "casa", "personal"),
      P("Patente de los autos", "casa", "impuesto", "anual", { fechas: ["06-30"] }),
      // Local
      mens("Luz", "local", "servicio", 10),
      mens("Agua", "local", "servicio", 10),
      mens("Internet Tigo", "local", "servicio", 10),
      mens("Alarma", "local", "servicio", 10),
      mens("Seguros", "local", "seguro", 29),
      P("Patente comercial", "local", "impuesto", "anual", { fechas: ["01-31", "07-31"] }),
      quin("Gas", "local", "servicio"),
      quin("Jardinero", "local", "personal"),
    ];
    const personal = ["Mirta", "Erna", "Leo", "Carolina", "Mario", "Manu", "Zulma", "Gloria", "Irene"]
      .map((nombre) => ({ id: nuevoId(), nombre, sueldoSemanal: 0, ips: true, aguinaldo: true, extras: 0, updatedAt: t }));
    return { version: 1, pagos, registros: [], personal, config: { ipsPatronal: 16.5, updatedAt: t } };
  }

  return {
    DIAS_SEMANA, DIAS_CORTOS, MESES, TIPOS, FRECUENCIAS, GRUPOS,
    aISO, partes, diasDelMes, sumarDias, diferenciaDias, diaSemana, hoyLocal, hoyEnZona, horaEnZona,
    mesDe, inicioDeMes, finDeMes, sumarMeses, nombreMes, fechaLarga, fechaCorta, fechaDMA,
    miles, fmtGs, leerMonto, nuevoId,
    ocurrencias, claveReg, registrosVigentes, indexarRegistros, estadoDe, terminado, pagosVivos,
    listaActual, avisosDelDia, textoAviso, ultimoRegistro, describirFrecuencia,
    registrosDelMes, totalesDelMes, costoColaborador, personalVivo,
    normalizar, extraerMonto, interpretarVoz,
    fusionarLista, fusionarEstado, estadoVacio, esEstadoValido, semilla,
  };
});
