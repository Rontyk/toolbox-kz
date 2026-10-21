const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");
const initSqlJs = require("sql.js");

// Pure JS/WASM SQLite (sql.js): identical on every OS and Node >= 18, no native build, no flags.
// The database lives in memory and is persisted to a file after writes.
const file = process.env.DB_PATH || path.join(__dirname, "toolbox.db");
let raw = null, SQL = null, timer = null;

function saveNow() {
  if (!raw) return;
  clearTimeout(timer); timer = null;
  const data = Buffer.from(raw.export());      // export() resets PRAGMAs
  raw.exec("PRAGMA foreign_keys = ON;");
  fs.writeFileSync(file + ".tmp", data);
  fs.renameSync(file + ".tmp", file);
}
function scheduleSave() { if (!timer) timer = setTimeout(saveNow, 150); }

const db = {
  exec(sql) { raw.exec(sql); scheduleSave(); },
  prepare(sql) {
    return {
      get(...a) { const st = raw.prepare(sql); try { st.bind(a); return st.step() ? st.getAsObject() : undefined; } finally { st.free(); } },
      all(...a) { const st = raw.prepare(sql); try { st.bind(a); const out = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); } },
      run(...a) {
        const st = raw.prepare(sql);
        try { st.run(a); } finally { st.free(); }
        const changes = raw.getRowsModified();
        const lastInsertRowid = raw.exec("SELECT last_insert_rowid()")[0].values[0][0];
        scheduleSave();
        return { changes, lastInsertRowid };
      },
    };
  },
  close: saveNow,
};

function createSchema() {
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS lockers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  address TEXT NOT NULL,
  lat REAL, lng REAL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  emoji TEXT DEFAULT '🧰',
  price_hour INTEGER NOT NULL,
  price_day INTEGER NOT NULL,
  deposit INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cells (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  locker_id INTEGER NOT NULL REFERENCES lockers(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'available', -- available | rented | maintenance
  UNIQUE(locker_id, number)
);
CREATE TABLE IF NOT EXISTS rentals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  cell_id INTEGER NOT NULL REFERENCES cells(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  locker_id INTEGER NOT NULL REFERENCES lockers(id),
  unit TEXT NOT NULL,            -- hour | day
  quantity INTEGER NOT NULL,
  start_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  returned_at TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | returned
  pickup_code TEXT NOT NULL,
  base_price INTEGER NOT NULL,
  deposit INTEGER NOT NULL,
  extra_fee INTEGER NOT NULL DEFAULT 0,
  total_charged INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rentals_user ON rentals(user_id);
CREATE INDEX IF NOT EXISTS idx_rentals_status ON rentals(status);
`);
}

function seed() {
  const n = db.prepare("SELECT COUNT(*) c FROM lockers").get().c;
  if (n > 0) return;

  const ins = (sql, ...a) => db.prepare(sql).run(...a);

  ins("INSERT INTO users(name,email,phone,password_hash,role) VALUES (?,?,?,?,?)",
    "Админ", "admin@toolbox.kz", "+77000000000", bcrypt.hashSync("admin123", 10), "admin");
  ins("INSERT INTO users(name,email,phone,password_hash,role) VALUES (?,?,?,?,?)",
    "Демо Пользователь", "demo@toolbox.kz", "+77011111111", bcrypt.hashSync("demo123", 10), "user");

  const lockers = [
    ["ToolBox Алатау", "Алматы", "мкр. Самал-2, д. 58 (ТРЦ Mega, вход 3)", 43.2389, 76.9575],
    ["ToolBox Достык", "Алматы", "пр. Достык, 180 (ЖК Нурлы Тау)", 43.2275, 76.9570],
    ["ToolBox Есиль", "Астана", "пр. Туран, 37 (ЖК Хайвилл)", 51.1280, 71.4300],
    ["ToolBox Нура", "Астана", "ул. Кунаева, 12 (ТРЦ Хан Шатыр, паркинг)", 51.1325, 71.4045],
  ];
  const lockerIds = lockers.map(l =>
    Number(ins("INSERT INTO lockers(name,city,address,lat,lng) VALUES (?,?,?,?,?)", ...l).lastInsertRowid));

  const items = [
    ["Перфоратор Bosch GBH 2-26", "Инструмент", "Мощный перфоратор 800 Вт, 3 режима, кейс и набор буров.", "🔨", 1500, 6000, 25000],
    ["Шуруповёрт Makita 18V", "Инструмент", "Аккумуляторный, 2 батареи, зарядка, набор бит.", "🪛", 800, 3500, 15000],
    ["Болгарка DeWalt 125 мм", "Инструмент", "Угловая шлифмашина 900 Вт, 2 диска в комплекте.", "⚙️", 1000, 4000, 20000],
    ["Виброплита", "Инструмент", "Для трамбовки плитки и щебня. Вес 60 кг, выдача в нижней ячейке.", "🏗️", 3000, 12000, 60000],
    ["PlayStation 5 + 2 геймпада", "Развлечения", "PS5 Disc, 2 геймпада, HDMI-кабель. Игры по запросу в приложении.", "🎮", 2500, 9000, 80000],
    ["Проектор Xiaomi 1080p", "Электроника", "Для кино и презентаций, штатив и пульт в комплекте.", "📽️", 1800, 7000, 50000],
    ["Палатка 4-местная", "Туризм", "Двухслойная, влагозащита 3000 мм, собирается за 10 минут.", "⛺", 1200, 5000, 30000],
    ["Экшн-камера GoPro Hero 11", "Электроника", "Карта памяти 128 ГБ, 2 аккумулятора, крепления.", "📷", 2000, 8000, 60000],
    ["Пылесос моющий Karcher", "Бытовое", "Для мягкой мебели и ковров. Шампунь в комплекте.", "🧹", 1300, 5000, 30000],
    ["Паровая швабра / отпариватель", "Бытовое", "Для уборки и разглаживания тканей.", "♨️", 700, 2500, 10000],
  ];
  const itemIds = items.map(i =>
    Number(ins("INSERT INTO items(name,category,description,emoji,price_hour,price_day,deposit) VALUES (?,?,?,?,?,?,?)", ...i).lastInsertRowid));

  // 8 cells per locker, fill with different items
  lockerIds.forEach((lid, li) => {
    for (let n = 1; n <= 8; n++) {
      const itemId = n <= 6 ? itemIds[(li * 3 + n - 1) % itemIds.length] : null;
      ins("INSERT INTO cells(locker_id,number,item_id,status) VALUES (?,?,?,'available')", lid, n, itemId);
    }
  });
}
db.ready = (async () => {
  SQL = await initSqlJs();
  raw = fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database();
  raw.exec("PRAGMA foreign_keys = ON;");
  createSchema();
  seed();
  saveNow();
})();

process.on("exit", () => { try { saveNow(); } catch {} });
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

module.exports = db;
