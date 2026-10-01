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
const fmtDate = (ms) =>
  new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

let state = {
  cfg: null,
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
  document.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
  $(`#tab-${name}`).classList.remove("hidden");
  if (name === "calendar") {
    refreshEvents().then(renderCalendar);
  }
  if (name === "sent") loadBox("out");
  if (name === "inbox") loadBox("in");
}

// ------------------------------------------------------------------ mail list
async function loadBox(box) {
  const { emails } = await api(`/api/emails?box=${box}`);
  state.emails[box] = emails;
  if (box === "in") {
    const unread = emails.filter((m) => !m.read).length;
    $("#inbox-count").textContent = unread || "";
  }
  const list = $(box === "in" ? "#inbox-list" : "#sent-list");
  list.innerHTML = emails.length ? "" : `<div class="item sub">No messages yet</div>`;
  for (const m of emails) {
    const div = document.createElement("div");
    div.className =
      "item" +
      (m.read ? "" : " unread") +
      (m.id === state.selectedId ? " selected" : "");
    const badge = m.has_calendar
      ? `<span class="badge ${m.calendar_method === "CANCEL" ? "cancel" : m.calendar_method === "REPLY" ? "reply" : ""}">${esc(m.calendar_method || "invite")}</span>`
      : "";
    div.innerHTML = `
      <div class="from">${esc(box === "in" ? m.from_address : joinAddrs(m.to_addresses))} ${badge}</div>
      <div class="subj">${esc(m.subject) || "(no subject)"}</div>
      <div class="meta"><span>${fmtDate(m.received_at)}</span></div>`;
    div.onclick = () => openEmail(m.id, box);
    list.appendChild(div);
  }
}
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
      <h2>${esc(email.subject) || "(no subject)"}</h2>
      <div class="sub">From <b>${esc(email.from_address)}</b> &rarr; ${esc(joinAddrs(email.to_addresses))}
        &middot; ${fmtDate(email.received_at)}</div>
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
        ? `<iframe sandbox="" srcdoc="${esc(email.body_html)}"></iframe>`
        : `<pre>${esc(email.body_text || "(empty)")}</pre>`
    }
  `;
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
    openCompose(
      email.from_address,
      "Re: " + (email.subject || ""),
      "",
      email.message_id,
    );
  };
  detail.querySelector("#btn-del").onclick = async () => {
    await api(`/api/emails/${id}`, { method: "DELETE" });
    detail.innerHTML = "Select a message";
    detail.classList.add("empty");
    toast("Deleted");
    loadBox(box);
  };
}

// ------------------------------------------------------------------ compose
const composeDlg = $("#compose-modal");
function openCompose(to = "", subject = "", body = "", inReplyTo = "") {
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
    $("#event-form").insertBefore(row, $(".modal-foot", evDlg));
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
        body: { ...body, sendInvites: notify },
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
  $("#me-address").textContent = state.cfg.primaryAddress;
  await Promise.all([loadBox("in"), refreshEvents()]);
  showApp();
}

(async () => {
  const { authed } = await api("/api/session").catch(() => ({ authed: false }));
  if (authed) await boot();
  else showLogin();
})();
