// ToolBox KZ — SPA front-end (vanilla JS, hash router)
const $ = s => document.querySelector(s);
const app = $("#app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => Number(n || 0).toLocaleString("ru-RU") + " ₸";
const fmtDT = s => s ? new Date(s).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

let state = { user: null, token: localStorage.getItem("tb_token") };

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers.Authorization = "Bearer " + state.token;
  const res = await fetch("/api" + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.token) { logout(false); }
    throw new Error(data.error || "Ошибка запроса");
  }
  return data;
}

function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (bad ? " bad" : "");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 3500);
}
function openModal(html) { $("#modal-body").innerHTML = html; $("#modal").classList.remove("hidden"); }
function closeModal() { $("#modal").classList.add("hidden"); }
$("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });

async function loadUser() {
  if (!state.token) return;
  try { state.user = (await api("/auth/me")).user; } catch { state.user = null; state.token = null; localStorage.removeItem("tb_token"); }
}
function setSession(r) { state.token = r.token; state.user = r.user; localStorage.setItem("tb_token", r.token); renderMenu(); }
function logout(go = true) {
  state.token = null; state.user = null; localStorage.removeItem("tb_token"); renderMenu();
  if (go) location.hash = "#/";
}

function renderMenu() {
  const u = state.user;
  const cur = location.hash || "#/";
  const a = (h, t) => `<a href="${h}" class="${cur === h ? "on" : ""}">${t}</a>`;
  $("#menu").innerHTML = a("#/catalog", "Каталог") + a("#/lockers", "Постоматы") + a("#/terminal", "Эмулятор постомата") +
    (u ? a("#/account", "Мои аренды") + (u.role === "admin" ? a("#/admin", "Админ") : "") + `<button onclick="logout()">Выйти (${esc(u.name.split(" ")[0])})</button>`
       : a("#/login", "Вход") + `<a href="#/register" class="btn sm" style="background:var(--accent);color:var(--dark)">Регистрация</a>`);
}

// ---------- router ----------
const routes = [
  [/^#\/?$/, home], [/^#\/catalog$/, catalog], [/^#\/item\/(\d+)$/, itemPage],
  [/^#\/lockers$/, lockers], [/^#\/locker\/(\d+)$/, lockerPage],
  [/^#\/login$/, loginPage], [/^#\/register$/, registerPage],
  [/^#\/account$/, account], [/^#\/terminal$/, terminal], [/^#\/admin$/, admin],
];
async function route() {
  const h = location.hash || "#/";
  renderMenu();
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) {
      app.innerHTML = `<p class="muted">Загрузка…</p>`;
      try { await fn(...m.slice(1)); } catch (e) { app.innerHTML = `<div class="card"><h3>Ошибка</h3><p>${esc(e.message)}</p></div>`; }
      window.scrollTo(0, 0);
      return;
    }
  }
  app.innerHTML = `<h1>Страница не найдена</h1><a href="#/">На главную</a>`;
}
window.addEventListener("hashchange", route);

// ---------- pages ----------
async function home() {
  const items = (await api("/items")).slice(0, 4);
  app.innerHTML = `
  <section class="hero">
    <h1>Инструмент, когда он нужен — в постомате рядом с домом</h1>
    <p>Арендуйте перфоратор, PS5 или палатку за пару минут: выберите в приложении, оплатите, отсканируйте QR и заберите. 24/7, без очередей и без паспорта.</p>
    <div class="btns"><a class="btn light" href="#/catalog">Смотреть каталог</a><a class="btn" style="background:var(--accent);color:var(--dark)" href="#/lockers">Найти постомат</a></div>
  </section>
  <h2>Как это работает</h2>
  <div class="steps">
    <div class="step"><div class="n">1</div><b>Выберите предмет</b><p class="muted small">Каталог и карта постоматов с наличием в реальном времени.</p></div>
    <div class="step"><div class="n">2</div><b>Оплатите онлайн</b><p class="muted small">Почасовой или посуточный тариф, залог холдируется и возвращается.</p></div>
    <div class="step"><div class="n">3</div><b>Откройте ячейку</b><p class="muted small">Покажите QR-код или введите 6-значный код на экране постомата.</p></div>
    <div class="step"><div class="n">4</div><b>Верните в любое время</b><p class="muted small">Вернули — залог освобождён. Просрочка тарифицируется по ×1.5.</p></div>
  </div>
  <h2>Популярное</h2>
  <div class="grid">${items.map(itemCard).join("")}</div>`;
}

function itemCard(i) {
  const avail = i.available_count;
  return `<div class="card click" onclick="location.hash='#/item/${i.id}'">
    <div class="emoji">${esc(i.emoji)}</div>
    <h3>${esc(i.name)}</h3>
    <span class="tag">${esc(i.category)}</span>
    <div class="muted small">${esc(i.description)}</div>
    <div class="price">от ${money(i.price_hour)}/час · ${money(i.price_day)}/сутки</div>
    <div class="small">${avail > 0 ? `<span class="tag">В наличии: ${avail}</span>` : `<span class="tag red">Все арендованы</span>`} <span class="muted">залог ${money(i.deposit)}</span></div>
  </div>`;
}

async function catalog() {
  const cats = await api("/categories");
  app.innerHTML = `<h1>Каталог</h1>
  <div class="bar"><input id="q" placeholder="Поиск: перфоратор, палатка…">
    <select id="cat"><option value="">Все категории</option>${cats.map(c => `<option>${esc(c)}</option>`).join("")}</select></div>
  <div id="list" class="grid"></div>`;
  const load = async () => {
    const q = $("#q").value.trim(), c = $("#cat").value;
    const items = await api(`/items?q=${encodeURIComponent(q)}&category=${encodeURIComponent(c)}`);
    $("#list").innerHTML = items.length ? items.map(itemCard).join("") : `<p class="muted">Ничего не найдено</p>`;
  };
  let t; $("#q").oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
  $("#cat").onchange = load;
  load();
}

async function itemPage(id) {
  const it = await api("/items/" + id);
  app.innerHTML = `<a href="#/catalog">← Каталог</a>
  <div class="card" style="margin-top:12px;flex-direction:row;gap:22px;flex-wrap:wrap">
    <div class="emoji" style="font-size:90px">${esc(it.emoji)}</div>
    <div style="flex:1;min-width:260px"><span class="tag">${esc(it.category)}</span>
      <h1>${esc(it.name)}</h1><p class="muted">${esc(it.description)}</p>
      <p class="price">${money(it.price_hour)}/час · ${money(it.price_day)}/сутки</p>
      <p class="small muted">Залог ${money(it.deposit)} — холдируется на карте и возвращается после возврата предмета. Просрочка: ×1.5 от часового тарифа за каждый час.</p></div>
  </div>
  <h2>Где забрать</h2>
  ${it.locations.length ? `<div class="tbl"><table><tr><th>Постомат</th><th>Адрес</th><th>Ячейка</th><th></th></tr>
  ${it.locations.map(l => `<tr><td><b>${esc(l.locker_name)}</b><br><span class="muted small">${esc(l.city)}</span></td><td>${esc(l.address)}</td>
    <td>№${l.number}</td><td>${l.status === "available" ? `<button class="btn sm" onclick='startRent(${JSON.stringify({ cellId: l.cell_id, itemId: it.id })})'>Арендовать</button>` : `<span class="tag gray">${l.status === "rented" ? "Арендован" : "Недоступен"}</span>`}</td></tr>`).join("")}
  </table></div>` : `<p class="muted">Сейчас нигде не размещён.</p>`}`;
}

async function startRent({ cellId, itemId }) {
  if (!state.user) { toast("Сначала войдите в аккаунт", true); location.hash = "#/login"; return; }
  const it = await api("/items/" + itemId);
  const loc = it.locations.find(l => l.cell_id === cellId);
  openModal(`<h2 style="margin-top:0">${esc(it.emoji)} ${esc(it.name)}</h2>
    <p class="muted small">${esc(loc.locker_name)} · ${esc(loc.address)} · ячейка №${loc.number}</p>
    <label>Тариф</label><select id="unit"><option value="hour">Почасовой — ${money(it.price_hour)}/час</option><option value="day">Посуточный — ${money(it.price_day)}/сутки</option></select>
    <label id="qlabel">Количество часов</label><input id="qty" type="number" min="1" value="2">
    <div class="sum" id="sum"></div>
    <div class="err" id="rerr"></div>
    <div class="row" style="margin-top:8px"><button class="btn" id="pay">Оплатить (демо)</button><button class="btn ghost" onclick="closeModal()">Отмена</button></div>`);
  const upd = () => {
    const unit = $("#unit").value, q = Math.max(1, Number($("#qty").value) || 1);
    $("#qlabel").textContent = unit === "hour" ? "Количество часов (1–24)" : "Количество суток (1–14)";
    const base = q * (unit === "hour" ? it.price_hour : it.price_day);
    $("#sum").innerHTML = `<div><span>Аренда</span><b>${money(base)}</b></div><div><span>Залог (холд)</span><b>${money(it.deposit)}</b></div><div><span>К оплате сейчас</span><b>${money(base + it.deposit)}</b></div>`;
  };
  $("#unit").onchange = upd; $("#qty").oninput = upd; upd();
  $("#pay").onclick = async () => {
    $("#pay").disabled = true; $("#rerr").textContent = "";
    try {
      const r = await api("/rentals", { method: "POST", body: { cellId, unit: $("#unit").value, quantity: Number($("#qty").value) } });
      await showQR(r.id, true);
    } catch (e) { $("#rerr").textContent = e.message; $("#pay").disabled = false; }
  };
}

async function showQR(id, fresh = false) {
  const q = await api(`/rentals/${id}/qr`);
  openModal(`<div class="qr"><h2 style="margin-top:0">${fresh ? "Оплачено ✅" : "Код выдачи"}</h2>
    <p class="muted small">Покажите QR на постомате или введите код вручную</p>
    <img src="${q.dataUrl}" alt="QR"><div class="code">${esc(q.code)}</div>
    <button class="btn" onclick="closeModal();location.hash='#/account';route()">Мои аренды</button></div>`);
}

async function lockers() {
  const ls = await api("/lockers");
  const cities = [...new Set(ls.map(l => l.city))];
  app.innerHTML = `<h1>Постоматы</h1>` + cities.map(c => `<h2>${esc(c)}</h2><div class="grid">${ls.filter(l => l.city === c).map(l => `
    <div class="card click" onclick="location.hash='#/locker/${l.id}'"><h3>📍 ${esc(l.name)}</h3><div class="muted small">${esc(l.address)}</div>
    <div><span class="tag">Доступно предметов: ${l.available_items}</span> <span class="tag gray">ячеек ${l.total_cells}</span></div>
    ${l.lat ? `<a class="small" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lng}#map=17/${l.lat}/${l.lng}" onclick="event.stopPropagation()">Показать на карте</a>` : ""}</div>`).join("")}</div>`).join("");
}

async function lockerPage(id) {
  const l = await api("/lockers/" + id);
  app.innerHTML = `<a href="#/lockers">← Постоматы</a><h1 style="margin-top:10px">📍 ${esc(l.name)}</h1><p class="muted">${esc(l.city)}, ${esc(l.address)}</p>
  <div class="cells">${l.cells.map(c => {
    if (!c.item_id) return `<div class="cell"><span class="num">#${c.number}</span><div class="muted small" style="padding-top:18px">Пусто</div></div>`;
    const cls = c.status === "available" ? "av" : c.status === "rented" ? "rt" : "mt";
    const click = c.status === "available" ? `onclick='startRent(${JSON.stringify({ cellId: c.id, itemId: c.item_id })})'` : "";
    return `<div class="cell ${cls}" ${click}><span class="num">#${c.number}</span><div class="emoji">${esc(c.emoji)}</div><b class="small">${esc(c.item_name)}</b>
      <div class="small price">${money(c.price_hour)}/ч</div>${c.status === "available" ? `<span class="tag">Свободно</span>` : `<span class="tag gray">${c.status === "rented" ? "В аренде" : "Обслуживание"}</span>`}</div>`;
  }).join("")}</div><p class="muted small" style="margin-top:14px">Нажмите на свободную ячейку, чтобы арендовать предмет.</p>`;
}

function authForm(kind) {
  const reg = kind === "register";
  app.innerHTML = `<form class="form" id="f"><h2 style="margin-top:0">${reg ? "Регистрация" : "Вход"}</h2>
    ${reg ? `<label>Имя</label><input name="name" required><label>Телефон</label><input name="phone" placeholder="+7 700 000 00 00">` : ""}
    <label>Email</label><input name="email" type="email" required value="${reg ? "" : "demo@toolbox.kz"}">
    <label>Пароль</label><input name="password" type="password" required minlength="6" value="${reg ? "" : "demo123"}">
    <div class="err" id="err"></div><button class="btn" style="width:100%;margin-top:6px">${reg ? "Создать аккаунт" : "Войти"}</button>
    <p class="muted small" style="text-align:center">${reg ? `Уже есть аккаунт? <a href="#/login">Войти</a>` : `Демо: demo@toolbox.kz / demo123 · админ: admin@toolbox.kz / admin123<br>Нет аккаунта? <a href="#/register">Регистрация</a>`}</p></form>`;
  $("#f").onsubmit = async e => {
    e.preventDefault();
    try {
      const body = Object.fromEntries(new FormData(e.target));
      setSession(await api(`/auth/${kind}`, { method: "POST", body }));
      location.hash = "#/account";
    } catch (er) { $("#err").textContent = er.message; }
  };
}
async function loginPage() { authForm("login"); }
async function registerPage() { authForm("register"); }

const needLogin = () => { if (!state.user) { location.hash = "#/login"; return true; } };

async function account() {
  if (needLogin()) return;
  const rs = await api("/rentals/mine");
  const act = rs.filter(r => r.status === "active"), done = rs.filter(r => r.status !== "active");
  app.innerHTML = `<h1>Мои аренды</h1><p class="muted">${esc(state.user.name)} · ${esc(state.user.email)}</p>
  <h2>Активные (${act.length})</h2>
  <div class="grid">${act.map(r => `<div class="card"><div class="emoji">${esc(r.emoji)}</div><h3>${esc(r.item_name)}</h3>
    <div class="small muted">${esc(r.locker_name)} · ячейка №${r.cell_number}</div>
    <div class="small">Вернуть до: <b>${fmtDT(r.due_at)}</b> ${r.is_overdue ? `<span class="tag red">просрочка ${r.overdue_hours} ч · +${money(r.overdue_fee)}</span>` : ""}</div>
    <div class="small">Оплачено: ${money(r.base_price)} · залог ${money(r.deposit)}</div>
    <div class="row" style="margin-top:6px"><button class="btn sm" onclick="showQR(${r.id})">QR / код</button>
    <button class="btn sm ghost" onclick="extendRental(${r.id})" ${r.is_overdue ? "disabled" : ""}>Продлить</button>
    <button class="btn sm danger" onclick="returnRental(${r.id})">Вернуть</button></div></div>`).join("") || `<p class="muted">Нет активных аренд. <a href="#/catalog">Выбрать предмет</a></p>`}</div>
  <h2>История</h2>
  ${done.length ? `<div class="tbl"><table><tr><th>Предмет</th><th>Постомат</th><th>Период</th><th>Списано</th></tr>${done.map(r => `<tr>
    <td>${esc(r.emoji)} ${esc(r.item_name)}</td><td>${esc(r.locker_name)}</td><td>${fmtDT(r.start_at)} → ${fmtDT(r.returned_at)}</td>
    <td>${money(r.total_charged)}${r.extra_fee ? ` <span class="tag red">штраф ${money(r.extra_fee)}</span>` : ""}</td></tr>`).join("")}</table></div>` : `<p class="muted">Пока пусто</p>`}`;
}

async function extendRental(id) {
  openModal(`<h2 style="margin-top:0">Продлить аренду</h2><label>На сколько часов (1–72)</label><input id="eh" type="number" min="1" max="72" value="2">
    <div class="err" id="eerr"></div><div class="row"><button class="btn" id="eok">Продлить</button><button class="btn ghost" onclick="closeModal()">Отмена</button></div>`);
  $("#eok").onclick = async () => {
    try { await api(`/rentals/${id}/extend`, { method: "POST", body: { hours: Number($("#eh").value) } }); closeModal(); toast("Аренда продлена"); route(); }
    catch (e) { $("#eerr").textContent = e.message; }
  };
}
async function returnRental(id) {
  if (!confirm("Вернуть предмет? Убедитесь, что вы положили его в ячейку и закрыли дверцу.")) return;
  try {
    const r = await api(`/rentals/${id}/return`, { method: "POST" });
    toast(r.extra_fee ? `Возврат принят. Штраф за просрочку ${money(r.extra_fee)}, залог возвращён: ${money(r.deposit_released)}` : `Возврат принят. Залог ${money(r.deposit_released)} освобождён`);
    route();
  } catch (e) { toast(e.message, true); }
}

async function terminal() {
  const ls = await api("/lockers");
  app.innerHTML = `<h1 style="text-align:center">Эмулятор экрана постомата</h1>
  <p class="muted" style="text-align:center">Так выглядит терминал на месте: введите код из приложения или QR-пейлоад.</p>
  <div class="terminal"><div>&gt; ToolBox KZ · терминал</div>
    <label style="color:#7fd6c6">Постомат</label><select id="tl">${ls.map(l => `<option value="${l.id}">${esc(l.name)} — ${esc(l.city)}</option>`).join("")}</select>
    <label style="color:#7fd6c6">Код выдачи (6 цифр)</label><input id="tc" maxlength="40" placeholder="123456" inputmode="numeric">
    <button class="btn" style="margin-top:14px;width:100%;background:var(--accent);color:var(--dark)" id="tg">Открыть ячейку</button>
    <div class="out" id="tout">&gt; ожидание кода…</div></div>`;
  $("#tg").onclick = async () => {
    try {
      const r = await api("/locker/unlock", { method: "POST", body: { lockerId: Number($("#tl").value), code: $("#tc").value.trim() } });
      $("#tout").textContent = "> ✅ " + r.message;
    } catch (e) { $("#tout").textContent = "> ❌ " + e.message; }
  };
}

// ---------- admin ----------
let adminTab = "stats";
async function admin() {
  if (needLogin()) return;
  if (state.user.role !== "admin") { app.innerHTML = `<h1>Доступ запрещён</h1>`; return; }
  const tabs = [["stats", "Обзор"], ["rentals", "Аренды"], ["items", "Предметы"], ["lockers", "Постоматы"], ["users", "Пользователи"]];
  app.innerHTML = `<h1>Админ-панель</h1><div class="tabs">${tabs.map(([k, t]) => `<button class="${adminTab === k ? "on" : ""}" onclick="adminTab='${k}';admin()">${t}</button>`).join("")}</div><div id="ab"></div>`;
  const ab = $("#ab");
  if (adminTab === "stats") {
    const s = await api("/admin/stats");
    ab.innerHTML = `<div class="stats"><div class="stat">Выручка<b>${money(s.revenue)}</b></div><div class="stat">Активные аренды<b>${s.active}</b></div>
      <div class="stat">Всего аренд<b>${s.total}</b></div><div class="stat">Пользователи<b>${s.users}</b></div><div class="stat">Загрузка ячеек<b>${s.utilization}%</b></div></div>
      <h3>Топ предметов</h3><div class="tbl"><table><tr><th>Предмет</th><th>Аренд</th><th>Выручка</th></tr>${s.byItem.map(i => `<tr><td>${esc(i.name)}</td><td>${i.rentals}</td><td>${money(i.revenue)}</td></tr>`).join("")}</table></div>
      <h3 style="margin-top:18px">По постоматам</h3><div class="tbl"><table><tr><th>Постомат</th><th>Аренд</th><th>Выручка</th></tr>${s.byLocker.map(i => `<tr><td>${esc(i.name)}</td><td>${i.rentals}</td><td>${money(i.revenue)}</td></tr>`).join("")}</table></div>`;
  } else if (adminTab === "rentals") {
    const rs = await api("/admin/rentals");
    ab.innerHTML = `<div class="tbl"><table><tr><th>#</th><th>Клиент</th><th>Предмет</th><th>Постомат</th><th>Срок</th><th>Статус</th><th>Сумма</th></tr>${rs.map(r => `<tr><td>${r.id}</td><td>${esc(r.user_name)}<br><span class="muted small">${esc(r.user_email)}</span></td>
      <td>${esc(r.item_name)}</td><td>${esc(r.locker_name)} №${r.cell_number}</td><td>${fmtDT(r.start_at)} → ${fmtDT(r.returned_at || r.due_at)}</td>
      <td>${r.status === "active" ? (r.is_overdue ? `<span class="tag red">просрочена</span>` : `<span class="tag">активна</span>`) : `<span class="tag gray">возвращена</span>`}</td><td>${money(r.total_charged ?? r.base_price)}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">Аренд пока нет</td></tr>`}</table></div>`;
  } else if (adminTab === "items") {
    const its = await api("/items");
    ab.innerHTML = `<button class="btn sm" onclick="itemForm()">+ Добавить предмет</button><div class="tbl" style="margin-top:12px"><table><tr><th></th><th>Название</th><th>Категория</th><th>₸/час</th><th>₸/сутки</th><th>Залог</th><th></th></tr>
      ${its.map(i => `<tr><td>${esc(i.emoji)}</td><td>${esc(i.name)}</td><td>${esc(i.category)}</td><td>${i.price_hour}</td><td>${i.price_day}</td><td>${i.deposit}</td>
      <td class="row"><button class="btn sm ghost" onclick='itemForm(${JSON.stringify(i).replace(/'/g, "&#39;")})'>Изменить</button><button class="btn sm danger" onclick="delItem(${i.id})">Удалить</button></td></tr>`).join("")}</table></div>`;
  } else if (adminTab === "lockers") {
    const ls = await api("/lockers");
    const its = await api("/items");
    window._adminItems = its;
    let html = `<button class="btn sm" onclick="lockerForm()">+ Добавить постомат</button>`;
    for (const l of ls) {
      const d = await api("/lockers/" + l.id);
      html += `<h3 style="margin-top:20px">${esc(l.name)} <span class="muted small">${esc(l.city)}</span></h3><div class="tbl"><table><tr><th>Ячейка</th><th>Предмет</th><th>Статус</th></tr>
      ${d.cells.map(c => `<tr><td>№${c.number}</td><td>${c.status === "rented" ? esc(c.item_name || "—") : `<select onchange="setCell(${c.id},{item_id:this.value||null})"><option value="">— пусто —</option>${its.map(i => `<option value="${i.id}" ${i.id === c.item_id ? "selected" : ""}>${esc(i.name)}</option>`).join("")}</select>`}</td>
      <td>${c.status === "rented" ? `<span class="tag gray">в аренде</span>` : `<select onchange="setCell(${c.id},{status:this.value})"><option value="available" ${c.status === "available" ? "selected" : ""}>доступна</option><option value="maintenance" ${c.status === "maintenance" ? "selected" : ""}>обслуживание</option></select>`}</td></tr>`).join("")}</table></div>`;
    }
    ab.innerHTML = html;
  } else {
    const us = await api("/admin/users");
    ab.innerHTML = `<div class="tbl"><table><tr><th>#</th><th>Имя</th><th>Email</th><th>Телефон</th><th>Роль</th><th>Аренд</th><th>Регистрация</th></tr>${us.map(u => `<tr><td>${u.id}</td><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.phone || "—")}</td><td>${u.role}</td><td>${u.rentals}</td><td>${fmtDT(u.created_at.replace(" ", "T") + "Z")}</td></tr>`).join("")}</table></div>`;
  }
}
function itemForm(i = {}) {
  openModal(`<h2 style="margin-top:0">${i.id ? "Изменить" : "Новый"} предмет</h2>
  <label>Название</label><input id="f_name" value="${esc(i.name || "")}"><label>Категория</label><input id="f_cat" value="${esc(i.category || "")}">
  <label>Эмодзи</label><input id="f_em" value="${esc(i.emoji || "🧰")}"><label>Описание</label><textarea id="f_desc" rows="2">${esc(i.description || "")}</textarea>
  <div class="row"><div style="flex:1"><label>₸/час</label><input id="f_ph" type="number" value="${i.price_hour ?? ""}"></div><div style="flex:1"><label>₸/сутки</label><input id="f_pd" type="number" value="${i.price_day ?? ""}"></div><div style="flex:1"><label>Залог</label><input id="f_dep" type="number" value="${i.deposit ?? ""}"></div></div>
  <div class="err" id="ferr"></div><div class="row"><button class="btn" id="fok">Сохранить</button><button class="btn ghost" onclick="closeModal()">Отмена</button></div>`);
  $("#fok").onclick = async () => {
    const body = { name: $("#f_name").value, category: $("#f_cat").value, emoji: $("#f_em").value, description: $("#f_desc").value, price_hour: $("#f_ph").value, price_day: $("#f_pd").value, deposit: $("#f_dep").value };
    try { await api(i.id ? `/admin/items/${i.id}` : "/admin/items", { method: i.id ? "PUT" : "POST", body }); closeModal(); toast("Сохранено"); admin(); }
    catch (e) { $("#ferr").textContent = e.message; }
  };
}
async function delItem(id) {
  if (!confirm("Удалить предмет?")) return;
  try { await api("/admin/items/" + id, { method: "DELETE" }); toast("Удалено"); admin(); } catch (e) { toast(e.message, true); }
}
function lockerForm() {
  openModal(`<h2 style="margin-top:0">Новый постомат</h2><label>Название</label><input id="l_name"><label>Город</label><input id="l_city"><label>Адрес</label><input id="l_addr">
  <div class="row"><div style="flex:1"><label>Широта</label><input id="l_lat"></div><div style="flex:1"><label>Долгота</label><input id="l_lng"></div><div style="flex:1"><label>Ячеек</label><input id="l_cells" type="number" value="8"></div></div>
  <div class="err" id="lerr"></div><div class="row"><button class="btn" id="lok">Создать</button><button class="btn ghost" onclick="closeModal()">Отмена</button></div>`);
  $("#lok").onclick = async () => {
    try { await api("/admin/lockers", { method: "POST", body: { name: $("#l_name").value, city: $("#l_city").value, address: $("#l_addr").value, lat: $("#l_lat").value, lng: $("#l_lng").value, cells: $("#l_cells").value } }); closeModal(); toast("Постомат создан"); admin(); }
    catch (e) { $("#lerr").textContent = e.message; }
  };
}
async function setCell(id, body) {
  try { await api("/admin/cells/" + id, { method: "PUT", body }); toast("Обновлено"); } catch (e) { toast(e.message, true); admin(); }
}

Object.assign(window, { startRent, showQR, extendRental, returnRental, closeModal, logout, itemForm, delItem, lockerForm, setCell, route, admin });

(async () => { await loadUser(); route(); })();
