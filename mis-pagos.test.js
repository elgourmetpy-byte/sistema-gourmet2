// Pruebas de Mis Pagos:  node test/mis-pagos.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("../mis-pagos/public/logica.js");

let ok = 0;
async function prueba(nombre, fn) {
  try { await fn(); ok++; console.log("  ✔", nombre); }
  catch (e) { console.error("  ✘", nombre, "\n", e); process.exitCode = 1; }
}
const pago = (extra) => Object.assign({ id: "p", nombre: "Luz", grupo: "casa", tipo: "servicio", frecuencia: "mensual", dia: 10, desde: "2026-01-01" }, extra);

(async () => {
  console.log("Mis Pagos — lógica");

  await prueba("mensual: día 31 en febrero cae el 28", () => {
    const oc = L.ocurrencias(pago({ dia: 31 }), "2026-02-01", "2026-02-28");
    assert.deepStrictEqual(oc.map((o) => o.venc), ["2026-02-28"]);
    assert.strictEqual(oc[0].periodo, "2026-02");
  });
  await prueba("semanal viernes (Irma)", () => {
    const oc = L.ocurrencias(pago({ frecuencia: "semanal", diaSemana: 5 }), "2026-10-01", "2026-10-31");
    assert.deepStrictEqual(oc.map((o) => o.venc), ["2026-10-02", "2026-10-09", "2026-10-16", "2026-10-23", "2026-10-30"]);
  });
  await prueba("quincenal 15 y fin de mes", () => {
    const oc = L.ocurrencias(pago({ frecuencia: "quincenal", dias: [15, 31] }), "2026-11-01", "2026-11-30");
    assert.deepStrictEqual(oc.map((o) => [o.periodo, o.venc]), [["2026-11-q1", "2026-11-15"], ["2026-11-q2", "2026-11-30"]]);
  });
  await prueba("anual con dos fechas (patente comercial)", () => {
    const oc = L.ocurrencias(pago({ frecuencia: "anual", fechas: ["01-31", "07-31"] }), "2026-01-01", "2026-12-31");
    assert.deepStrictEqual(oc.map((o) => o.venc), ["2026-01-31", "2026-07-31"]);
  });
  await prueba("no genera vencimientos antes de 'desde'", () => {
    assert.strictEqual(L.ocurrencias(pago({ desde: "2026-10-15" }), "2026-09-01", "2026-10-31").length, 0);
  });
  await prueba("colores: vencido, pronto (≤2 días), pendiente, pagado", () => {
    const e = { pagos: [pago({ dia: 10 }), pago({ id: "q", dia: 17 }), pago({ id: "r", dia: 20 }), pago({ id: "s", dia: 5 })],
      registros: [{ id: "x", pagoId: "s", periodo: "2026-10", fechaPago: "2026-10-05", monto: 1 }] };
    const est = Object.fromEntries(L.listaActual(e, "2026-10-15").map((x) => [x.pago.id, x.estado]));
    assert.deepStrictEqual(est, { p: "vencido", q: "pronto", r: "pendiente", s: "pagado" });
  });
  await prueba("crédito sin cuotas restantes deja de aparecer", () => {
    const e = { pagos: [pago({ cuotasRestantes: 0 })], registros: [] };
    assert.strictEqual(L.listaActual(e, "2026-10-05").length, 0);
  });
  await prueba("avisos: hoy y en 2 días, no mañana ni pagados", () => {
    const e = { pagos: [pago({ id: "a", nombre: "Agua", dia: 15 }), pago({ id: "b", nombre: "Alarma", dia: 16 }),
      pago({ id: "c", nombre: "Seguros", dia: 17 }), pago({ id: "d", nombre: "Gas", dia: 17 })],
      registros: [{ id: "x", pagoId: "d", periodo: "2026-10", fechaPago: "2026-10-14", monto: 1 }] };
    const av = L.avisosDelDia(e, "2026-10-15");
    assert.deepStrictEqual(av.hoy.map((p) => p.nombre), ["Agua"]);
    assert.deepStrictEqual(av.en2.map((p) => p.nombre), ["Seguros"]);
    assert.ok(L.textoAviso(av).cuerpo.includes("Vence HOY: Agua (Casa)"));
  });
  await prueba("mismo pago tildado en dos celulares cuenta una sola vez", () => {
    const regs = [{ id: "1", pagoId: "p", periodo: "2026-10", fechaPago: "2026-10-10", monto: 100, grupo: "casa", nombre: "Luz", updatedAt: 1 },
      { id: "2", pagoId: "p", periodo: "2026-10", fechaPago: "2026-10-10", monto: 120, grupo: "casa", nombre: "Luz", updatedAt: 2 }];
    assert.strictEqual(L.totalesDelMes({ registros: regs }, "2026-10").total, 120);
  });
  await prueba("costo del personal: semanal × 52 ÷ 12 + IPS + aguinaldo + extras", () => {
    const k = L.costoColaborador({ sueldoSemanal: 600000, ips: true, aguinaldo: true, extras: 50000 }, { ipsPatronal: 16.5 });
    assert.strictEqual(k.mensual, 2600000);
    assert.strictEqual(k.ips, 429000);
    assert.strictEqual(k.aguinaldo, 216667);
    assert.strictEqual(k.total, 2600000 + 429000 + 216667 + 50000);
  });
  await prueba("montos dichos en voz", () => {
    assert.strictEqual(L.extraerMonto("pagué la luz 350 mil"), 350000);
    assert.strictEqual(L.extraerMonto("1 millón 200 mil"), 1200000);
    assert.strictEqual(L.extraerMonto("un millón"), 1000000);
    assert.strictEqual(L.extraerMonto("Gs. 1.250.000"), 1250000);
    assert.strictEqual(L.extraerMonto("$350,000"), 350000);
    assert.strictEqual(L.extraerMonto("pagué la cuota del auto 0 km"), null);
  });

  const sem = L.semilla("2026-10-15");
  const vivos = sem.pagos;
  const voz = (t) => L.interpretarVoz(t, vivos);
  const nombres = (r) => r.candidatos.map((p) => `${p.nombre}/${p.grupo}`).sort();
  await prueba("voz: 'pagué la luz del local'", () => assert.deepStrictEqual(nombres(voz("pagué la luz del local")), ["Luz/local"]));
  await prueba("voz: 'pagué la luz' pregunta casa o local", () => assert.deepStrictEqual(nombres(voz("pagué la luz")), ["Luz/casa", "Luz/local"]));
  await prueba("voz: 'pagué la luz del departamento de Facundo'", () =>
    assert.deepStrictEqual(nombres(voz("pagué la luz del departamento de Facundo")), ["Luz del departamento de Facundo/casa"]));
  await prueba("voz: 'pagué la ANDE de casa'", () => assert.deepStrictEqual(nombres(voz("pagué la ANDE de casa")), ["Luz/casa"]));
  await prueba("voz: 'pagué la cuota del auto'", () => assert.deepStrictEqual(nombres(voz("pagué la cuota del auto")), ["Cuota del auto 0 km/casa"]));
  await prueba("voz: 'pagué la Bancop 2 millones'", () => {
    const r = voz("pagué la Bancop 2 millones");
    assert.deepStrictEqual(nombres(r), ["Tarjeta Bancop/casa"]);
    assert.strictEqual(r.monto, 2000000);
  });
  await prueba("voz: 'pagué el crédito de San Florián'", () =>
    assert.deepStrictEqual(nombres(voz("pagué el crédito de San Florián")), ["Crédito Cooperativa San Florián/casa"]));
  await prueba("voz: 'pagué el gas'", () => assert.deepStrictEqual(nombres(voz("pagué el gas")), ["Gas/local"]));
  await prueba("voz: 'pagué a Irma'", () => assert.deepStrictEqual(nombres(voz("pagué a Irma")), ["Irma/casa"]));

  await prueba("semilla: 30 pagos (22 casa, 8 local) y 9 colaboradores", () => {
    assert.strictEqual(sem.pagos.filter((p) => p.grupo === "casa").length, 22);
    assert.strictEqual(sem.pagos.filter((p) => p.grupo === "local").length, 8);
    assert.strictEqual(sem.personal.length, 9);
  });
  await prueba("fusionar: gana el cambio más nuevo y no se pierde nada", () => {
    const a = { pagos: [{ id: "1", nombre: "A", updatedAt: 5 }], registros: [{ id: "r1", updatedAt: 1 }], personal: [], config: { updatedAt: 1 } };
    const b = { pagos: [{ id: "1", nombre: "B", updatedAt: 9 }, { id: "2", nombre: "C", updatedAt: 1 }], registros: [], personal: [], config: { updatedAt: 0 } };
    const f = L.fusionarEstado(a, b);
    assert.deepStrictEqual(f.pagos.map((p) => p.nombre), ["B", "C"]);
    assert.strictEqual(f.registros.length, 1);
  });

  console.log("Mis Pagos — servidor");
  const express = require("express");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mispagos-"));
  const app = express();
  app.use("/pagos", require("../mis-pagos/router")({ dataDir: dir, revisarCadaMs: 0 }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/pagos`;
  const pedir = async (ruta, body, token) => {
    const r = await fetch(base + ruta, { method: body ? "POST" : "GET", headers: Object.assign({ "Content-Type": "application/json" }, token ? { "X-Token": token } : {}), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, j: await r.json().catch(() => null) };
  };
  try {
    let token;
    await prueba("sin PIN todavía; los datos piden sesión", async () => {
      assert.deepStrictEqual((await pedir("/api/acceso")).j, { tienePin: false });
      assert.strictEqual((await pedir("/api/estado")).status, 401);
    });
    await prueba("crear PIN y entrar", async () => {
      assert.strictEqual((await pedir("/api/crear-pin", { pin: "12" })).status, 400);
      token = (await pedir("/api/crear-pin", { pin: "4321" })).j.token;
      assert.ok(token);
      assert.strictEqual((await pedir("/api/crear-pin", { pin: "1111" })).status, 409);
      assert.strictEqual((await pedir("/api/entrar", { pin: "0000" })).status, 401);
      assert.ok((await pedir("/api/entrar", { pin: "4321" })).j.token);
    });
    await prueba("estado inicial con los pagos cargados", async () => {
      const { j } = await pedir("/api/estado", null, token);
      assert.strictEqual(j.estado.pagos.length, 30);
    });
    await prueba("guardar un pago lo persiste en disco y hace respaldo del día", async () => {
      const { j } = await pedir("/api/estado", null, token);
      const e = j.estado;
      const luz = e.pagos.find((p) => p.nombre === "Luz" && p.grupo === "local");
      e.registros.push({ id: "r1", pagoId: luz.id, periodo: "2026-10", fechaPago: "2026-10-15", monto: 350000, grupo: "local", nombre: "Luz", tipo: "servicio", updatedAt: Date.now() });
      const r = await pedir("/api/estado", { estado: { pagos: [], registros: e.registros, personal: [], config: {} } }, token);
      assert.strictEqual(r.j.estado.pagos.length, 30, "un celular vacío no borra los pagos");
      assert.strictEqual(r.j.estado.registros.length, 1);
      const disco = JSON.parse(fs.readFileSync(path.join(dir, "mis-pagos-datos", "estado.json"), "utf8"));
      assert.strictEqual(disco.registros[0].monto, 350000);
      assert.strictEqual(fs.readdirSync(path.join(dir, "mis-pagos-datos", "respaldos")).length, 1);
    });
    await prueba("rechaza datos inválidos", async () => {
      assert.strictEqual((await pedir("/api/estado", { estado: { hola: 1 } }, token)).status, 400);
    });
    await prueba("cambiar PIN cierra las otras sesiones", async () => {
      const otro = (await pedir("/api/entrar", { pin: "4321" })).j.token;
      assert.strictEqual((await pedir("/api/cambiar-pin", { actual: "4321", nuevo: "9876" }, token)).status, 200);
      assert.strictEqual((await pedir("/api/estado", null, otro)).status, 401);
      assert.strictEqual((await pedir("/api/estado", null, token)).status, 200);
    });
    await prueba("'/pagos' redirige a '/pagos/' y sirve la app", async () => {
      const r = await fetch(base, { redirect: "manual" });
      assert.strictEqual(r.status, 301);
      const html = await (await fetch(base + "/")).text();
      assert.ok(html.includes("<title>Mis Pagos</title>"));
    });
    await prueba("archivo dañado: se recupera del respaldo, no empieza de cero", async () => {
      fs.writeFileSync(path.join(dir, "mis-pagos-datos", "estado.json"), "{roto");
      const r2 = require("../mis-pagos/router")({ dataDir: dir, revisarCadaMs: 0 });
      assert.strictEqual(r2._interno.estado.registros.length, 1);
    });
  } finally { srv.close(); }

  console.log(`\n${ok} pruebas OK${process.exitCode ? " — HAY FALLAS" : ""}`);
})();
