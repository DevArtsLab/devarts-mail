// DevArts Mail — UI logic

const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) {
    showLogin();
    throw new Error("unauthorized");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
};

const esc = (s) =>
  (s || "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
/** Compact list timestamp: time today, "Yesterday", short date otherwise. */
const fmtDate = (ms) => {
  const d = new Date(ms),
    now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString([], opts);
};
/** Full timestamp for detail views. */
const fmtFull = (ms) =>
  new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** Stable hue from an address -> consistent avatar color per sender. */
const hueFor = (s) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};
const avatar = (addr) => {
  const ch = (addr || "?").trim().charAt(0).toUpperCase();
  return `<span class="avatar" style="background:hsl(${hueFor(addr)},32%,38%)">${esc(ch)}</span>`;
};

function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

let state = {
  cfg: null,
  identity: "all", // "all" or one of cfg.identities[].address
  emails: { in: [], out: [] },
  events: [],
  calCursor: new Date(),
  editingUid: null,
  selectedId: null,
};

// ------------------------------------------------------------------ auth
function showLogin() {
  $("#login-view").classList.remove("hidden");
  $("#app").classList.add("hidden");
}
function showApp() {
  $("#login-view").classList.add("hidden");
  $("#app").classList.remove("hidden");
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  try {
    await api("/api/login", {
      method: "POST",
      body: { password: $("#login-password").value },
    });
    await boot();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});
$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  showLogin();
});

// ------------------------------------------------------------------ nav
document
  .querySelectorAll(".nav-item")
  .forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

function switchTab(name) {
  document
    .querySelectorAll(".nav-item")
    .forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".split.open").forEach((s) => s.classList.remove("open"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
  $(`#tab-${name}`).classList.remove("hidden");
  if (name === "calendar") {
    refreshEvents().then(renderCalendar);
  }
  if (name === "sent") loadBox("out");
  if (name === "inbox") loadBox("in");
}

// ------------------------------------------------------------------ mail list
const parseAddrs = (j) => {
  try {
    return JSON.parse(j);
  } catch {
    return [];
  }
};

// Which of our identities an inbound email was addressed to (to/cc).
const ourRecipientOf = (m) => {
  const ids = state.cfg?.identities || [];
  const rcpts = [...parseAddrs(m.to_addresses), ...parseAddrs(m.cc_addresses)];
  for (const r of rcpts) {
    const hit = ids.find((i) => i.address === String(r).toLowerCase());
    if (hit) return hit.address;
  }
  return "";
};

async function loadBox(box) {
  const addr =
    state.identity === "all" ? "" : `&address=${encodeURIComponent(state.identity)}`;
  const { emails } = await api(`/api/emails?box=${box}${addr}`);
  state.emails[box] = emails;
  if (box === "in") {
    const unread = emails.filter((m) => !m.read).length;
    $("#inbox-count").textContent = unread || "";
  }
  const list = $(box === "in" ? "#inbox-list" : "#sent-list");
  list.innerHTML = emails.length ? "" : `<div class="item sub">No messages yet</div>`;
  const multi = (state.cfg?.identities?.length || 0) > 1;
  for (const m of emails) {
    const div = document.createElement("div");
    div.className =
      "item" +
      (m.read ? "" : " unread") +
      (m.id === state.selectedId ? " selected" : "");
    const badge = m.has_calendar
      ? `<span class="badge ${m.calendar_method === "CANCEL" ? "cancel" : m.calendar_method === "REPLY" ? "reply" : ""}">${esc(m.calendar_method || "invite")}</span>`
      : "";
    // In the combined view, tag which address received/sent each message.
    const whoBadge =
      multi && state.identity === "all"
        ? `<span class="badge to">${esc(
            box === "in" ? ourRecipientOf(m) : m.from_address,
          )}</span>`
        : "";
    const addrLabel = box === "in" ? m.from_address : joinAddrs(m.to_addresses);
    div.innerHTML = `
      ${avatar(addrLabel)}
      <div class="item-body">
        <div class="from"><span class="addr">${esc(addrLabel)}</span> ${badge} ${whoBadge}</div>
        <div class="subj">${esc(m.subject) || "(no subject)"}</div>
        ${m.snippet ? `<div class="prev">${esc(m.snippet)}</div>` : ""}
        <div class="meta"><span>${fmtDate(m.received_at)}</span></div>
      </div>`;
    div.onclick = () => openEmail(m.id, box);
    list.appendChild(div);
  }
}
// Turn URLs in plain-text bodies into links that open in a new tab.
const linkify = (s) =>
  s.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>',
  );

const joinAddrs = (j) => {
  try {
    return JSON.parse(j).join(", ");
  } catch {
    return j;
  }
};

// ------------------------------------------------------------------ detail
async function openEmail(id, box) {
  state.selectedId = id;
  const { email } = await api(`/api/emails/${id}`);
  const detail = $(box === "in" ? "#inbox-detail" : "#sent-detail");
  const isInvite = email.has_calendar && email.calendar_method === "REQUEST";
  const ev =
    isInvite && email.event_uid
      ? state.events.find((e) => e.uid === email.event_uid)
      : null;
  const myStat = ev?.myPartstat;

  detail.classList.remove("empty");
  detail.innerHTML = `
    <div class="head">
      <div class="head-top">
        <button class="btn ghost icon back" id="btn-back">&#8249;</button>
        <h2>${esc(email.subject) || "(no subject)"}</h2>
      </div>
      <div class="sub from-line">${avatar(email.from_address)} From <b>${esc(email.from_address)}</b> &rarr; ${esc(joinAddrs(email.to_addresses))}
        &middot; ${fmtFull(email.received_at)}</div>
      ${
        isInvite
          ? `
        <div class="rsvp-bar">
          <span class="badge">Calendar invite</span>
          <button class="btn small accept" data-rsvp="ACCEPTED">Yes</button>
          <button class="btn small maybe" data-rsvp="TENTATIVE">Maybe</button>
          <button class="btn small danger" data-rsvp="DECLINED">No</button>
          <span class="state">${myStat ? "You replied: " + myStat.toLowerCase() : ""}</span>
        </div>`
          : ""
      }
      <div class="actions">
        <button class="btn ghost small" id="btn-reply">Reply</button>
        <button class="btn ghost small" id="btn-del">Delete</button>
      </div>
    </div>
    ${
      email.body_html
        ? `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="<base target='_blank'>${esc(email.body_html)}"></iframe>`
        : `<pre>${linkify(esc(email.body_text || "(empty)"))}</pre>`
    }
  `;
  // On narrow screens the detail pane swaps in over the list.
  detail.closest(".split").classList.add("open");
  detail.querySelector("#btn-back").onclick = () =>
    detail.closest(".split").classList.remove("open");
  detail.querySelectorAll("[data-rsvp]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const r = await api(`/api/emails/${id}/rsvp`, {
          method: "POST",
          body: { status: b.dataset.rsvp },
        });
        detail.querySelector(".rsvp-bar .state").textContent =
          "You replied: " +
          b.dataset.rsvp.toLowerCase() +
          (r.sent
            ? " — reply emailed to organizer"
            : " — send failed: " + (r.sendError || "?"));
        toast(
          `RSVP ${b.dataset.rsvp.toLowerCase()}${r.sent ? " sent" : " recorded (send failed)"}`,
          r.sent ? "ok" : "err",
        );
        await refreshEvents();
        loadBox(box);
      } catch (e) {
        toast(e.message, "err");
        b.disabled = false;
      }
    }),
  );
  detail.querySelector("#btn-reply").onclick = () => {
    // Reply as the identity that was addressed (inbox) or that sent (sent box).
    const from =
      box === "in"
        ? ourRecipientOf(email)
        : (state.cfg?.identities || []).find(
            (i) => i.address === email.from_address.toLowerCase(),
          )?.address || "";
    openCompose(
      box === "in" ? email.from_address : joinAddrs(email.to_addresses),
      "Re: " + (email.subject || ""),
      "",
      email.message_id,
      from,
    );
  };
  detail.querySelector("#btn-del").onclick = async () => {
    await api(`/api/emails/${id}`, { method: "DELETE" });
    detail.innerHTML = "Select a message";
    detail.classList.add("empty");
    detail.closest(".split").classList.remove("open");
    toast("Deleted");
    loadBox(box);
  };
}

// ------------------------------------------------------------------ compose
const composeDlg = $("#compose-modal");
function openCompose(to = "", subject = "", body = "", inReplyTo = "", from = "") {
  const sel = $("#compose-from");
  sel.value =
    from ||
    (state.identity !== "all" ? state.identity : state.cfg?.primaryAddress) ||
    sel.value;
  $("#compose-to").value = to;
  $("#compose-subject").value = subject;
  $("#compose-body").value = body;
  $("#compose-body").dataset.inreplyto = inReplyTo || "";
  $("#compose-status").textContent = "";
  composeDlg.showModal();
}
$("#compose-open").onclick = () => openCompose();
document
  .querySelectorAll("[data-close]")
  .forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

$("#compose-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const st = $("#compose-status");
  st.textContent = "Sending…";
  try {
    await api("/api/send", {
      method: "POST",
      body: {
        from: $("#compose-from").value,
        to: $("#compose-to").value,
        subject: $("#compose-subject").value,
        text: $("#compose-body").value,
        inReplyTo: $("#compose-body").dataset.inreplyto || undefined,
      },
    });
    composeDlg.close();
    toast("Sent");
    loadBox("out");
  } catch (err) {
    st.textContent = "Error: " + err.message;
  }
});

// ------------------------------------------------------------------ calendar
async function refreshEvents() {
  const { events } = await api("/api/events");
  state.events = events;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function renderCalendar() {
  const cur = state.calCursor;
  const year = cur.getFullYear(),
    month = cur.getMonth();
  $("#cal-title").textContent = cur.toLocaleDateString([], {
    month: "long",
    year: "numeric",
  });
  const startDay = new Date(year, month, 1).getDay();
  const grid = $("#cal-grid");
  grid.innerHTML = DOW.map((d) => `<div class="dow">${d}</div>`).join("");

  for (let i = 0; i < 42; i++) {
    const date = new Date(year, month, i - startDay + 1);
    const dayStart = new Date(date).setHours(0, 0, 0, 0);
    const dayEnd = dayStart + 86400000;
    const evts = state.events.filter((e) => e.dtstart < dayEnd && e.dtend > dayStart);
    const div = document.createElement("div");
    div.className =
      "day" +
      (date.getMonth() !== month ? " other" : "") +
      (dayStart === new Date().setHours(0, 0, 0, 0) ? " today" : "");
    div.innerHTML =
      `<div class="num">${date.getDate()}</div>` +
      evts
        .map((e) => {
          const cls =
            e.status === "CANCELLED"
              ? "cancelled"
              : e.myPartstat === "ACCEPTED" || e.isOwn
                ? "accepted own"
                : e.myPartstat === "DECLINED"
                  ? "declined"
                  : e.myPartstat === "TENTATIVE"
                    ? "tentative"
                    : "invite";
          return `<div class="evt ${cls}" data-uid="${esc(e.uid)}"
        title="${esc(e.summary)}${e.myPartstat ? " — " + e.myPartstat : ""}">
        ${e.allDay ? "" : new Date(e.dtstart).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + " "}${esc(e.summary)}
      </div>`;
        })
        .join("");
    div.onclick = (ev) => {
      // Narrow screens: tap a day -> bottom sheet listing its events.
      if (window.matchMedia("(max-width: 860px)").matches) {
        openDaySheet(date, evts);
        return;
      }
      const uid = ev.target.closest(".evt")?.dataset.uid;
      if (uid) openEventModal(state.events.find((x) => x.uid === uid));
      else openEventModal(null, date);
    };
    grid.appendChild(div);
  }
}
$("#cal-prev").onclick = () => {
  state.calCursor.setMonth(state.calCursor.getMonth() - 1);
  renderCalendar();
};
$("#cal-next").onclick = () => {
  state.calCursor.setMonth(state.calCursor.getMonth() + 1);
  renderCalendar();
};
$("#cal-today").onclick = () => {
  state.calCursor = new Date();
  renderCalendar();
};
$("#cal-new").onclick = () => openEventModal(null, new Date());

// ---- day sheet (mobile): readable list of a day's events ----
const sheetEl = $("#day-sheet"),
  sheetBg = $("#day-backdrop");
const closeDaySheet = () => {
  sheetEl.classList.add("hidden");
  sheetBg.classList.add("hidden");
};
sheetBg.onclick = closeDaySheet;
$("#ds-close").onclick = closeDaySheet;

function openDaySheet(date, evts) {
  $("#ds-title").textContent = date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const wrap = $("#ds-events");
  wrap.innerHTML = evts.length
    ? ""
    : `<div class="sub" style="padding:8px 0">No events</div>`;
  for (const e of evts) {
    const cls =
      e.status === "CANCELLED"
        ? "cancelled"
        : e.myPartstat === "ACCEPTED" || e.isOwn
          ? "accepted"
          : e.myPartstat === "DECLINED"
            ? "declined"
            : e.myPartstat === "TENTATIVE"
              ? "tentative"
              : "invite";
    const time = e.allDay
      ? "All day"
      : `${new Date(e.dtstart).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – ${new Date(e.dtend).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    const item = document.createElement("div");
    item.className = `ds-evt ${cls}`;
    item.innerHTML = `<span class="dot"></span>
      <div class="ds-evt-body">
        <div class="t">${esc(e.summary) || "(no title)"}</div>
        <div class="m">${time}${e.location ? " · " + esc(e.location) : ""}${e.myPartstat ? " · " + e.myPartstat.toLowerCase() : ""}</div>
      </div>`;
    item.onclick = () => {
      closeDaySheet();
      openEventModal(e);
    };
    wrap.appendChild(item);
  }
  $("#ds-add").onclick = () => {
    closeDaySheet();
    openEventModal(null, date);
  };
  sheetEl.classList.remove("hidden");
  sheetBg.classList.remove("hidden");
}

const toLocalInput = (ms) => {
  const d = new Date(ms),
    p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

const evDlg = $("#event-modal");
function openEventModal(ev, date) {
  state.editingUid = ev?.uid || null;
  $("#event-modal-title").textContent = ev ? "Edit event" : "New event";
  $("#ev-summary").value = ev?.summary || "";
  $("#ev-location").value = ev?.location || "";
  $("#ev-description").value = ev?.description || "";
  const start = ev
    ? ev.dtstart
    : date
      ? new Date(date).setHours(10, 0, 0, 0)
      : Date.now();
  const end = ev ? ev.dtend : start + 3600000;
  $("#ev-start").value = toLocalInput(start);
  $("#ev-end").value = toLocalInput(end);
  $("#ev-attendees").value = (ev?.attendees || []).map((a) => a.email).join(", ");
  // Organizer is fixed once the event exists.
  const orgSel = $("#ev-organizer");
  orgSel.disabled = !!ev;
  if (!ev)
    orgSel.value =
      state.identity !== "all" ? state.identity : state.cfg?.primaryAddress;
  else if ((state.cfg?.identities || []).some((i) => i.address === ev.organizerEmail))
    orgSel.value = ev.organizerEmail;
  $("#ev-delete").classList.toggle("hidden", !ev);
  $("#ev-ics").classList.toggle("hidden", !ev);
  $("#ev-ics").onclick = () => {
    if (ev) location.href = `/api/events/${encodeURIComponent(ev.uid)}/ics`;
  };
  $("#ev-delete").onclick = async () => {
    const notify =
      ev?.isOwn &&
      (ev.attendees || []).length &&
      confirm("Email cancellation to attendees?");
    await api(`/api/events/${encodeURIComponent(ev.uid)}?notify=${notify ? 1 : 0}`, {
      method: "DELETE",
    });
    evDlg.close();
    toast("Event deleted");
    await refreshEvents();
    renderCalendar();
  };
  const existing = $("#ev-rsvp-row");
  if (existing) existing.remove();
  if (ev && !ev.isOwn && ev.organizerEmail) {
    const row = document.createElement("div");
    row.id = "ev-rsvp-row";
    row.className = "rsvp-bar";
    row.innerHTML = `<span class="state">Your status: ${ev.myPartstat || "pending"}</span>
      <button type="button" class="btn small accept" data-s="ACCEPTED">Yes</button>
      <button type="button" class="btn small maybe" data-s="TENTATIVE">Maybe</button>
      <button type="button" class="btn small danger" data-s="DECLINED">No</button>`;
    row.querySelectorAll("[data-s]").forEach((b) =>
      b.addEventListener("click", async () => {
        const r = await api(`/api/events/${encodeURIComponent(ev.uid)}/rsvp`, {
          method: "POST",
          body: { status: b.dataset.s },
        });
        toast(
          `RSVP ${b.dataset.s.toLowerCase()}${r.sent ? " sent" : " recorded (send failed)"}`,
          r.sent ? "ok" : "err",
        );
        evDlg.close();
        await refreshEvents();
        renderCalendar();
      }),
    );
    $("#event-form").insertBefore(row, evDlg.querySelector(".modal-foot"));
  }
  evDlg.showModal();
}

$("#event-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    summary: $("#ev-summary").value,
    location: $("#ev-location").value,
    description: $("#ev-description").value,
    dtstart: new Date($("#ev-start").value).getTime(),
    dtend: new Date($("#ev-end").value).getTime(),
    attendees: $("#ev-attendees")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((email) => ({ email })),
  };
  const notify = $("#ev-notify").checked;
  try {
    if (state.editingUid) {
      await api(`/api/events/${encodeURIComponent(state.editingUid)}`, {
        method: "PUT",
        body: { ...body, sendUpdates: notify },
      });
      toast("Event updated");
    } else {
      await api("/api/events", {
        method: "POST",
        body: { ...body, organizer: $("#ev-organizer").value, sendInvites: notify },
      });
      toast("Event created");
    }
    evDlg.close();
    await refreshEvents();
    renderCalendar();
  } catch (err) {
    toast(err.message, "err");
  }
});

// ------------------------------------------------------------------ boot
async function boot() {
  state.cfg = await api("/api/config");
  const ids = state.cfg.identities?.length
    ? state.cfg.identities
    : [{ address: state.cfg.primaryAddress, name: state.cfg.displayName }];

  const idSel = $("#identity-picker");
  idSel.innerHTML =
    (ids.length > 1 ? `<option value="all">All addresses</option>` : "") +
    ids
      .map((i) => `<option value="${esc(i.address)}">${esc(i.address)}</option>`)
      .join("");
  state.identity = ids.length > 1 ? "all" : ids[0].address;
  idSel.value = state.identity;

  const fromOpts = ids
    .map(
      (i) =>
        `<option value="${esc(i.address)}">${esc(
          i.name && i.name !== i.address ? `${i.name} <${i.address}>` : i.address,
        )}</option>`,
    )
    .join("");
  $("#compose-from").innerHTML = fromOpts;
  $("#ev-organizer").innerHTML = fromOpts;

  const showMe = () => {
    $("#me-address").textContent =
      state.identity === "all" ? `${ids.length} addresses` : state.identity;
  };
  showMe();
  idSel.onchange = () => {
    state.identity = idSel.value;
    state.selectedId = null;
    showMe();
    document.querySelectorAll(".split.open").forEach((s) => s.classList.remove("open"));
    loadBox("in");
    loadBox("out");
  };

  await Promise.all([loadBox("in"), refreshEvents()]);
  showApp();
}

(async () => {
  const { authed } = await api("/api/session").catch(() => ({ authed: false }));
  if (authed) await boot();
  else showLogin();
})();
