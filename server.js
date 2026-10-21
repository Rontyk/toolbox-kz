const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const QRCode = require("qrcode");
const crypto = require("crypto");
const path = require("path");
const db = require("./db");

const app = express();
const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const PORT = process.env.PORT || 3000;
const OVERDUE_MULTIPLIER = 1.5;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------
const HOUR = 3600 * 1000;
const iso = d => d.toISOString();
const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { console.error(e); if (!res.headersSent) res.status(500).json({ error: "Внутренняя ошибка сервера" }); }
};
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

function auth(required = true) {
  return (req, res, next) => {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) return required ? bad(res, "Требуется вход", 401) : next();
    try {
      const p = jwt.verify(token, SECRET);
      const u = db.prepare("SELECT id,name,email,phone,role FROM users WHERE id=?").get(p.id);
      if (!u) return bad(res, "Пользователь не найден", 401);
      req.user = u;
      next();
    } catch { bad(res, "Сессия истекла, войдите снова", 401); }
  };
}
const adminOnly = (req, res, next) => (req.user && req.user.role === "admin") ? next() : bad(res, "Только для администратора", 403);

const signToken = u => jwt.sign({ id: u.id }, SECRET, { expiresIn: "7d" });

function calcOverdue(rental, now = new Date()) {
  const item = db.prepare("SELECT price_hour FROM items WHERE id=?").get(rental.item_id);
  const overMs = now - new Date(rental.due_at);
  if (overMs <= 0) return { hours: 0, fee: 0 };
  const hours = Math.ceil(overMs / HOUR);
  return { hours, fee: Math.round(hours * item.price_hour * OVERDUE_MULTIPLIER) };
}

function rentalView(r) {
  const o = r.status === "active" ? calcOverdue(r) : { hours: 0, fee: r.extra_fee };
  return {
    ...r,
    overdue_hours: o.hours,
    overdue_fee: o.fee,
    is_overdue: r.status === "active" && o.hours > 0,
  };
}

const RENTAL_SELECT = `
  SELECT r.*, i.name AS item_name, i.emoji, i.price_hour, i.price_day,
         l.name AS locker_name, l.address AS locker_address, l.city, c.number AS cell_number
  FROM rentals r
  JOIN items i ON i.id = r.item_id
  JOIN lockers l ON l.id = r.locker_id
  JOIN cells c ON c.id = r.cell_id`;

// ---------- auth ----------
app.post("/api/auth/register", wrap((req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || name.trim().length < 2) return bad(res, "Укажите имя");
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return bad(res, "Некорректный email");
  if (!password || password.length < 6) return bad(res, "Пароль минимум 6 символов");
  if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email.toLowerCase())) return bad(res, "Этот email уже зарегистрирован", 409);
  const r = db.prepare("INSERT INTO users(name,email,phone,password_hash) VALUES (?,?,?,?)")
    .run(name.trim(), email.toLowerCase(), phone || null, bcrypt.hashSync(password, 10));
  const user = db.prepare("SELECT id,name,email,phone,role FROM users WHERE id=?").get(Number(r.lastInsertRowid));
  res.status(201).json({ token: signToken(user), user });
}));

app.post("/api/auth/login", wrap((req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE email=?").get((email || "").toLowerCase());
  if (!u || !bcrypt.compareSync(password || "", u.password_hash)) return bad(res, "Неверный email или пароль", 401);
  const user = { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role };
  res.json({ token: signToken(user), user });
}));

app.get("/api/auth/me", auth(), (req, res) => res.json({ user: req.user }));

// ---------- public catalogue ----------
app.get("/api/lockers", wrap((req, res) => {
  const rows = db.prepare(`
    SELECT l.*,
      (SELECT COUNT(*) FROM cells c WHERE c.locker_id=l.id AND c.item_id IS NOT NULL AND c.status='available') AS available_items,
      (SELECT COUNT(*) FROM cells c WHERE c.locker_id=l.id) AS total_cells
    FROM lockers l WHERE l.active=1 ORDER BY l.city, l.name`).all();
  res.json(rows);
}));

app.get("/api/lockers/:id", wrap((req, res) => {
  const l = db.prepare("SELECT * FROM lockers WHERE id=?").get(Number(req.params.id));
  if (!l) return bad(res, "Постомат не найден", 404);
  const cells = db.prepare(`
    SELECT c.id, c.number, c.status, c.item_id, i.name AS item_name, i.emoji, i.category,
           i.price_hour, i.price_day, i.deposit, i.description
    FROM cells c LEFT JOIN items i ON i.id=c.item_id
    WHERE c.locker_id=? ORDER BY c.number`).all(l.id);
  res.json({ ...l, cells });
}));

app.get("/api/items", wrap((req, res) => {
  const { q, category } = req.query;
  let sql = `
    SELECT i.*,
      (SELECT COUNT(*) FROM cells c WHERE c.item_id=i.id AND c.status='available') AS available_count
    FROM items i WHERE 1=1`;
  const args = [];
  if (category) { sql += " AND i.category=?"; args.push(category); }
  if (q) { sql += " AND (i.name LIKE ? OR i.description LIKE ?)"; args.push(`%${q}%`, `%${q}%`); }
  sql += " ORDER BY i.category, i.name";
  res.json(db.prepare(sql).all(...args));
}));

app.get("/api/items/:id", wrap((req, res) => {
  const it = db.prepare("SELECT * FROM items WHERE id=?").get(Number(req.params.id));
  if (!it) return bad(res, "Товар не найден", 404);
  const locations = db.prepare(`
    SELECT c.id AS cell_id, c.number, c.status, l.id AS locker_id, l.name AS locker_name, l.city, l.address
    FROM cells c JOIN lockers l ON l.id=c.locker_id
    WHERE c.item_id=? AND l.active=1 ORDER BY l.city, l.name`).all(it.id);
  res.json({ ...it, locations });
}));

app.get("/api/categories", wrap((req, res) => {
  res.json(db.prepare("SELECT DISTINCT category FROM items ORDER BY category").all().map(r => r.category));
}));

// ---------- rentals ----------
app.post("/api/rentals", auth(), wrap((req, res) => {
  const { cellId, unit, quantity } = req.body || {};
  const qty = Number(quantity);
  if (!["hour", "day"].includes(unit)) return bad(res, "Укажите тариф: час или сутки");
  if (!Number.isInteger(qty) || qty < 1 || qty > (unit === "hour" ? 24 : 14)) return bad(res, unit === "hour" ? "От 1 до 24 часов" : "От 1 до 14 суток");

  const active = db.prepare("SELECT COUNT(*) c FROM rentals WHERE user_id=? AND status='active'").get(req.user.id).c;
  if (active >= 3) return bad(res, "Нельзя держать более 3 активных аренд одновременно");

  const result = tx(() => {
    const cell = db.prepare("SELECT * FROM cells WHERE id=?").get(Number(cellId));
    if (!cell || !cell.item_id) return { error: "Ячейка не найдена" };
    if (cell.status !== "available") return { error: "Этот предмет уже арендован или недоступен", code: 409 };
    const item = db.prepare("SELECT * FROM items WHERE id=?").get(cell.item_id);
    const start = new Date();
    const due = new Date(start.getTime() + qty * (unit === "hour" ? HOUR : 24 * HOUR));
    const base = qty * (unit === "hour" ? item.price_hour : item.price_day);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const r = db.prepare(`INSERT INTO rentals(user_id,cell_id,item_id,locker_id,unit,quantity,start_at,due_at,pickup_code,base_price,deposit)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(req.user.id, cell.id, item.id, cell.locker_id, unit, qty, iso(start), iso(due), code, base, item.deposit);
    db.prepare("UPDATE cells SET status='rented' WHERE id=?").run(cell.id);
    return { id: Number(r.lastInsertRowid) };
  });
  if (result.error) return bad(res, result.error, result.code || 404);
  const full = db.prepare(RENTAL_SELECT + " WHERE r.id=?").get(result.id);
  res.status(201).json(rentalView(full));
}));

app.get("/api/rentals/mine", auth(), wrap((req, res) => {
  const rows = db.prepare(RENTAL_SELECT + " WHERE r.user_id=? ORDER BY r.id DESC").all(req.user.id);
  res.json(rows.map(rentalView));
}));

function ownRental(req, res) {
  const r = db.prepare(RENTAL_SELECT + " WHERE r.id=?").get(Number(req.params.id));
  if (!r) { bad(res, "Аренда не найдена", 404); return null; }
  if (r.user_id !== req.user.id && req.user.role !== "admin") { bad(res, "Нет доступа", 403); return null; }
  return r;
}

app.get("/api/rentals/:id/qr", auth(), wrap(async (req, res) => {
  const r = ownRental(req, res); if (!r) return;
  if (r.status !== "active") return bad(res, "Аренда уже завершена");
  const payload = `TOOLBOX:${r.id}:${r.pickup_code}`;
  const dataUrl = await QRCode.toDataURL(payload, { margin: 1, width: 320, color: { dark: "#023E44", light: "#FFFFFF" } });
  res.json({ payload, code: r.pickup_code, dataUrl });
}));

app.post("/api/rentals/:id/extend", auth(), wrap((req, res) => {
  const r = ownRental(req, res); if (!r) return;
  if (r.status !== "active") return bad(res, "Аренда завершена");
  const hours = Number(req.body && req.body.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 72) return bad(res, "От 1 до 72 часов");
  if (calcOverdue(r).hours > 0) return bad(res, "Аренда просрочена — сначала верните предмет");
  const add = hours * r.price_hour;
  const due = new Date(new Date(r.due_at).getTime() + hours * HOUR);
  db.prepare("UPDATE rentals SET due_at=?, base_price=base_price+? WHERE id=?").run(iso(due), add, r.id);
  res.json(rentalView(db.prepare(RENTAL_SELECT + " WHERE r.id=?").get(r.id)));
}));

app.post("/api/rentals/:id/return", auth(), wrap((req, res) => {
  const r = ownRental(req, res); if (!r) return;
  if (r.status !== "active") return bad(res, "Аренда уже завершена");
  const now = new Date();
  const over = calcOverdue(r, now);
  const extra = Math.min(over.fee, r.deposit); // overdue fee is withheld from the deposit
  tx(() => {
    db.prepare("UPDATE rentals SET status='returned', returned_at=?, extra_fee=?, total_charged=? WHERE id=?")
      .run(iso(now), extra, r.base_price + extra, r.id);
    db.prepare("UPDATE cells SET status='available' WHERE id=?").run(r.cell_id);
  });
  const full = db.prepare(RENTAL_SELECT + " WHERE r.id=?").get(r.id);
  res.json({ ...rentalView(full), deposit_released: r.deposit - extra });
}));

// Locker terminal emulator: enter code (or scanned QR) at a locker -> cell opens
app.post("/api/locker/unlock", wrap((req, res) => {
  let { lockerId, code } = req.body || {};
  if (typeof code === "string" && code.startsWith("TOOLBOX:")) code = code.split(":")[2];
  if (!lockerId || !code) return bad(res, "Укажите постомат и код");
  const r = db.prepare(RENTAL_SELECT + " WHERE r.locker_id=? AND r.pickup_code=? AND r.status='active'").get(Number(lockerId), String(code));
  if (!r) return bad(res, "Неверный код или аренда не относится к этому постомату", 404);
  res.json({ ok: true, cell_number: r.cell_number, item_name: r.item_name, message: `Ячейка №${r.cell_number} открыта. Заберите «${r.item_name}».` });
}));

// ---------- admin ----------
app.get("/api/admin/stats", auth(), adminOnly, wrap((req, res) => {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const revenue = one("SELECT COALESCE(SUM(total_charged),0) v FROM rentals WHERE status='returned'").v;
  const active = one("SELECT COUNT(*) c FROM rentals WHERE status='active'").c;
  const total = one("SELECT COUNT(*) c FROM rentals").c;
  const users = one("SELECT COUNT(*) c FROM users WHERE role='user'").c;
  const cellsWithItems = one("SELECT COUNT(*) c FROM cells WHERE item_id IS NOT NULL").c;
  const rented = one("SELECT COUNT(*) c FROM cells WHERE status='rented'").c;
  const byItem = db.prepare(`
    SELECT i.name, COUNT(r.id) rentals, COALESCE(SUM(r.total_charged),0) revenue
    FROM items i LEFT JOIN rentals r ON r.item_id=i.id GROUP BY i.id ORDER BY rentals DESC, i.name LIMIT 10`).all();
  const byLocker = db.prepare(`
    SELECT l.name, COUNT(r.id) rentals, COALESCE(SUM(r.total_charged),0) revenue
    FROM lockers l LEFT JOIN rentals r ON r.locker_id=l.id GROUP BY l.id ORDER BY rentals DESC`).all();
  res.json({
    revenue, active, total, users,
    utilization: cellsWithItems ? Math.round(rented / cellsWithItems * 100) : 0,
    byItem, byLocker,
  });
}));

app.get("/api/admin/rentals", auth(), adminOnly, wrap((req, res) => {
  const rows = db.prepare(RENTAL_SELECT.replace("SELECT r.*,", "SELECT r.*, u.name AS user_name, u.email AS user_email,")
    .replace("FROM rentals r", "FROM rentals r JOIN users u ON u.id=r.user_id") + " ORDER BY r.id DESC LIMIT 200").all();
  res.json(rows.map(rentalView));
}));

app.get("/api/admin/users", auth(), adminOnly, wrap((req, res) => {
  res.json(db.prepare(`SELECT u.id,u.name,u.email,u.phone,u.role,u.created_at,
    (SELECT COUNT(*) FROM rentals r WHERE r.user_id=u.id) AS rentals FROM users u ORDER BY u.id DESC`).all());
}));

function itemFields(b) {
  const f = { name: (b.name || "").trim(), category: (b.category || "").trim(), description: b.description || "",
    emoji: b.emoji || "🧰", price_hour: Number(b.price_hour), price_day: Number(b.price_day), deposit: Number(b.deposit || 0) };
  if (!f.name || !f.category) return { error: "Название и категория обязательны" };
  if (![f.price_hour, f.price_day, f.deposit].every(n => Number.isInteger(n) && n >= 0)) return { error: "Цены должны быть целыми числами ≥ 0" };
  return { f };
}

app.post("/api/admin/items", auth(), adminOnly, wrap((req, res) => {
  const { f, error } = itemFields(req.body || {}); if (error) return bad(res, error);
  const r = db.prepare("INSERT INTO items(name,category,description,emoji,price_hour,price_day,deposit) VALUES (?,?,?,?,?,?,?)")
    .run(f.name, f.category, f.description, f.emoji, f.price_hour, f.price_day, f.deposit);
  res.status(201).json(db.prepare("SELECT * FROM items WHERE id=?").get(Number(r.lastInsertRowid)));
}));

app.put("/api/admin/items/:id", auth(), adminOnly, wrap((req, res) => {
  const { f, error } = itemFields(req.body || {}); if (error) return bad(res, error);
  const r = db.prepare("UPDATE items SET name=?,category=?,description=?,emoji=?,price_hour=?,price_day=?,deposit=? WHERE id=?")
    .run(f.name, f.category, f.description, f.emoji, f.price_hour, f.price_day, f.deposit, Number(req.params.id));
  if (!r.changes) return bad(res, "Товар не найден", 404);
  res.json(db.prepare("SELECT * FROM items WHERE id=?").get(Number(req.params.id)));
}));

app.delete("/api/admin/items/:id", auth(), adminOnly, wrap((req, res) => {
  const id = Number(req.params.id);
  if (db.prepare("SELECT 1 FROM rentals WHERE item_id=?").get(id)) return bad(res, "Нельзя удалить: по предмету есть история аренд", 409);
  db.prepare("DELETE FROM items WHERE id=?").run(id);
  res.json({ ok: true });
}));

app.post("/api/admin/lockers", auth(), adminOnly, wrap((req, res) => {
  const { name, city, address, lat, lng, cells } = req.body || {};
  if (!name || !city || !address) return bad(res, "Название, город и адрес обязательны");
  const n = Math.min(Math.max(Number(cells) || 8, 1), 24);
  const id = tx(() => {
    const r = db.prepare("INSERT INTO lockers(name,city,address,lat,lng) VALUES (?,?,?,?,?)")
      .run(name, city, address, lat != null && lat !== "" ? Number(lat) : null, lng != null && lng !== "" ? Number(lng) : null);
    const lid = Number(r.lastInsertRowid);
    for (let i = 1; i <= n; i++) db.prepare("INSERT INTO cells(locker_id,number) VALUES (?,?)").run(lid, i);
    return lid;
  });
  res.status(201).json(db.prepare("SELECT * FROM lockers WHERE id=?").get(id));
}));

app.put("/api/admin/cells/:id", auth(), adminOnly, wrap((req, res) => {
  const id = Number(req.params.id);
  const cell = db.prepare("SELECT * FROM cells WHERE id=?").get(id);
  if (!cell) return bad(res, "Ячейка не найдена", 404);
  if (cell.status === "rented") return bad(res, "Ячейка сейчас в аренде", 409);
  const { item_id, status } = req.body || {};
  const newItem = item_id === undefined ? cell.item_id : (item_id === null || item_id === "" ? null : Number(item_id));
  if (newItem !== null && !db.prepare("SELECT 1 FROM items WHERE id=?").get(newItem)) return bad(res, "Предмет не найден", 404);
  const newStatus = status === undefined ? cell.status : status;
  if (!["available", "maintenance"].includes(newStatus)) return bad(res, "Некорректный статус");
  db.prepare("UPDATE cells SET item_id=?, status=? WHERE id=?").run(newItem, newStatus, id);
  res.json(db.prepare("SELECT * FROM cells WHERE id=?").get(id));
}));

// SPA fallback
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use("/api", (req, res) => bad(res, "Не найдено", 404));

if (require.main === module) {
  db.ready.then(() => app.listen(PORT, () => console.log(`ToolBox KZ running on http://localhost:${PORT}`)))
    .catch(e => { console.error("DB init failed:", e); process.exit(1); });
}
module.exports = app;
