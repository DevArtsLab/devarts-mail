// Inbound MIME parsing (postal-mime) and outbound sending
// (mimetext + the `send_email` binding / cloudflare:email).

import PostalMime from "postal-mime";
import { createMimeMessage } from "mimetext";
import { EmailMessage } from "cloudflare:email";
import type { Env } from "./types";

export interface ParsedInbound {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  html: string;
  messageId: string | null;
  inReplyTo: string | null;
  calendar: { method?: string; ics: string } | null;
  raw: string;
}

export async function parseInbound(rawStream: ReadableStream): Promise<ParsedInbound> {
  const raw = await new Response(rawStream).text();
  const parsed = await new PostalMime().parse(raw);

  const addr = (a: any): string => (a?.address || "").toLowerCase();
  const to = (parsed.to || []).map(addr).filter(Boolean);
  const cc = (parsed.cc || []).map(addr).filter(Boolean);

  // Calendar content arrives as an attachment or alternative part with
  // content-type text/calendar.
  let calendar: ParsedInbound["calendar"] = null;
  for (const att of parsed.attachments || []) {
    if (
      (att.mimeType || "").includes("text/calendar") ||
      att.filename?.endsWith(".ics")
    ) {
      const ics =
        typeof att.content === "string"
          ? att.content
          : new TextDecoder().decode(att.content as ArrayBuffer);
      const methodMatch = (att.mimeType || "").match(/method=([A-Za-z]+)/i);
      calendar = { ics, method: methodMatch?.[1]?.toUpperCase() };
      break;
    }
  }
  if (!calendar && raw.includes("BEGIN:VCALENDAR")) {
    // Some senders embed iCal inline without an attachment part.
    const m = raw.match(/BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/);
    if (m) calendar = { ics: m[0] };
  }

  return {
    from: addr(parsed.from),
    to,
    cc,
    subject: parsed.subject || "",
    text: parsed.text || "",
    html: parsed.html || "",
    messageId: parsed.messageId || null,
    inReplyTo: parsed.inReplyTo || null,
    calendar,
    raw,
  };
}

export interface Outbound {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  /** Attach an iCal body (invite / reply / cancel). */
  ics?: {
    data: string;
    method: "REQUEST" | "REPLY" | "CANCEL" | "PUBLISH";
    filename?: string;
  };
  inReplyTo?: string;
  references?: string;
}

/** Send an email through the Email Sending binding. Returns message id. */
export async function sendMail(env: Env, msg: Outbound): Promise<string> {
  const msg_id = `<${crypto.randomUUID()}@${env.MAIL_DOMAIN}>`;

  const mime = createMimeMessage();
  mime.setSender({ name: env.DISPLAY_NAME, addr: env.PRIMARY_ADDRESS });
  const toList = Array.isArray(msg.to) ? msg.to : [msg.to];
  mime.setRecipients(toList.map((addr) => ({ addr })));
  mime.setSubject(msg.subject);
  mime.setHeader("Message-ID", msg_id);
  if (msg.inReplyTo) mime.setHeader("In-Reply-To", msg.inReplyTo);
  if (msg.references) mime.setHeader("References", msg.references);
  if (msg.ics) mime.setHeader("Content-class", "urn:content-classes:calendarmessage");

  if (msg.html) {
    mime.addMessage({ contentType: "text/html", data: msg.html });
  } else {
    mime.addMessage({ contentType: "text/plain", data: msg.text || "" });
  }

  if (msg.ics) {
    // mimetext expects attachment data already base64-encoded; an
    // unencoded body under a base64 header is malformed and Google
    // silently drops the RSVP.
    mime.addAttachment({
      filename: msg.ics.filename || "invite.ics",
      contentType: `text/calendar; method=${msg.ics.method}; charset="UTF-8"; name="invite.ics"`,
      data: btoa(msg.ics.data),
    });
  }

  const email = new EmailMessage(env.PRIMARY_ADDRESS, toList.join(","), mime.asRaw());
  await env.EMAIL.send(email);
  return msg_id;
}
