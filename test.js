// End-to-end API test: node test.js  (spins up its own server on a temp DB)
process.env.DB_PATH = require("path").join(require("os").tmpdir(), `tb_test_${Date.now()}.db`);
process.env.PORT = 0;
const assert = require("assert");
const app = require("./server");
const db = require("./db");

db.ready.then(() => { const server = app.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/api`;
  let token = null;
  const call = async (method, p, body, tk = token) => {
    const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...(tk ? { Authorization: "Bearer " + tk } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  let n = 0; const ok = (name) => console.log(`  ✓ ${++n}. ${name}`);
  try {
    // public
    let r = await call("GET", "/lockers"); assert.equal(r.status, 200); assert(r.data.length >= 4); ok("список постоматов");
    r = await call("GET", "/items?q=перфоратор"); assert(r.data.length === 1); ok("поиск в каталоге");

    // auth
    r = await call("POST", "/auth/register", { name: "Тест", email: "t@t.kz", password: "123456" }); assert.equal(r.status, 201); token = r.data.token; ok("регистрация");
    r = await call("POST", "/auth/register", { name: "Тест", email: "t@t.kz", password: "123456" }); assert.equal(r.status, 409); ok("дубликат email отклонён");
    r = await call("POST", "/auth/login", { email: "t@t.kz", password: "wrong" }); assert.equal(r.status, 401); ok("неверный пароль отклонён");
    r = await call("POST", "/rentals", { cellId: 1, unit: "hour", quantity: 2 }, null); assert.equal(r.status, 401); ok("аренда без входа запрещена");

    // rent
    const lk = (await call("GET", "/lockers/1")).data;
    const cell = lk.cells.find(c => c.item_id && c.status === "available");
    r = await call("POST", "/rentals", { cellId: cell.id, unit: "hour", quantity: 2 }); assert.equal(r.status, 201);
    assert.equal(r.data.base_price, cell.price_hour * 2); const rid = r.data.id; const code = r.data.pickup_code; ok("аренда создана, цена верна");
    r = await call("POST", "/rentals", { cellId: cell.id, unit: "hour", quantity: 1 }); assert.equal(r.status, 409); ok("повторная аренда занятой ячейки отклонена");
    r = await call("POST", "/rentals", { cellId: lk.cells[0].id, unit: "week", quantity: 1 }); assert.equal(r.status, 400); ok("валидация тарифа");

    // qr + terminal
    r = await call("GET", `/rentals/${rid}/qr`); assert(r.data.dataUrl.startsWith("data:image/png")); ok("QR сгенерирован");
    r = await call("POST", "/locker/unlock", { lockerId: 1, code }); assert(r.data.ok && r.data.cell_number === cell.number); ok("терминал открывает ячейку по коду");
    r = await call("POST", "/locker/unlock", { lockerId: 1, code: "TOOLBOX:" + rid + ":" + code }); assert(r.data.ok); ok("терминал принимает QR-пейлоад");
    r = await call("POST", "/locker/unlock", { lockerId: 2, code }); assert.equal(r.status, 404); ok("код не работает в чужом постомате");

    // extend
    r = await call("POST", `/rentals/${rid}/extend`, { hours: 3 }); assert.equal(r.data.base_price, cell.price_hour * 5); ok("продление пересчитало цену");

    // overdue return
    db.prepare("UPDATE rentals SET due_at=? WHERE id=?").run(new Date(Date.now() - 2.5 * 3600e3).toISOString(), rid);
    r = await call("GET", "/rentals/mine"); assert(r.data[0].is_overdue && r.data[0].overdue_hours === 3); ok("просрочка определяется (3 ч)");
    r = await call("POST", `/rentals/${rid}/extend`, { hours: 1 }); assert.equal(r.status, 400); ok("просроченную нельзя продлить");
    r = await call("POST", `/rentals/${rid}/return`);
    const expected = Math.min(Math.round(3 * cell.price_hour * 1.5), cell.deposit);
    assert.equal(r.data.extra_fee, expected); assert.equal(r.data.deposit_released, cell.deposit - expected); ok(`штраф ×1.5 удержан из залога (${expected} ₸)`);
    r = await call("POST", `/rentals/${rid}/return`); assert.equal(r.status, 400); ok("повторный возврат отклонён");
    r = await call("GET", "/lockers/1"); assert.equal(r.data.cells.find(c => c.id === cell.id).status, "available"); ok("ячейка снова свободна");

    // limit 3 active
    const free = (await call("GET", "/lockers/3")).data.cells.filter(c => c.item_id && c.status === "available");
    for (let i = 0; i < 3; i++) assert.equal((await call("POST", "/rentals", { cellId: free[i].id, unit: "day", quantity: 1 })).status, 201);
    r = await call("POST", "/rentals", { cellId: free[3].id, unit: "day", quantity: 1 }); assert.equal(r.status, 400); ok("лимит 3 активных аренд");

    // permissions
    r = await call("GET", "/admin/stats"); assert.equal(r.status, 403); ok("админка закрыта для обычного пользователя");
    const adm = (await call("POST", "/auth/login", { email: "admin@toolbox.kz", password: "admin123" }, null)).data.token;
    r = await call("GET", "/admin/stats", null, adm); assert.equal(r.status, 200); assert(r.data.revenue > 0); ok(`статистика админа (выручка ${r.data.revenue} ₸)`);
    r = await call("POST", "/admin/items", { name: "Тест-дрель", category: "Инструмент", price_hour: 500, price_day: 2000, deposit: 5000 }, adm); assert.equal(r.status, 201); ok("админ добавил предмет");
    const newItem = r.data.id;
    r = await call("DELETE", `/admin/items/${newItem}`, null, adm); assert.equal(r.status, 200); ok("админ удалил предмет");
    r = await call("POST", "/admin/lockers", { name: "Тест", city: "Алматы", address: "ул. Тест 1", cells: 4 }, adm); assert.equal(r.status, 201); ok("админ создал постомат");

    console.log(`\nВсе ${n} проверок пройдены ✅`);
    process.exitCode = 0;
  } catch (e) {
    console.error("\n❌ FAIL:", e.message); process.exitCode = 1;
  } finally { server.close(); setTimeout(() => process.exit(process.exitCode), 100); }
}); });
