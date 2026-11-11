/**
 * Who an address really is, and whether it wants email. The app can't verify addresses (anyone can sign up, and
 * teachers invite students by email), so every queued email carries an unsubscribe link that works without signing
 * in, and the daily limits count an address's variants (Ana+1@gmail.com, a.na@gmail.com) as one mailbox.
 */
import crypto from 'node:crypto';
import { all, get, run, transaction, type UserRow } from '../../db.js';
import { link } from './config.js';
import { parseJsonObject } from './settings.js';

/** Gmail ignores dots in the local part; googlemail.com is the same mailbox as gmail.com. */
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * One key per mailbox: lower-cased, without a "+tag" (most providers deliver ana+anything@ to ana@), and for Gmail
 * without dots. Used for the per-address limits and the unsubscribe list.
 */
export function recipientKey(address: string): string {
  const clean = address.trim().toLowerCase();
  const at = clean.lastIndexOf('@');
  if (at <= 0) return clean;
  let local = clean.slice(0, at);
  let domain = clean.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '') || local;
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

interface RecipientRow {
  address: string;
  token: string;
  unsubscribed_at: string | null;
}

const recipientRow = (key: string) => get<RecipientRow>('SELECT * FROM email_recipients WHERE address = ?', key);

/** The address's unsubscribe token (made on first use and kept, so links in older emails keep working). */
function unsubscribeToken(address: string): string {
  const key = recipientKey(address);
  const existing = recipientRow(key);
  if (existing) return existing.token;
  const token = crypto.randomBytes(18).toString('base64url');
  run(
    'INSERT OR IGNORE INTO email_recipients (address, token, created_at) VALUES (?, ?, ?)',
    key,
    token,
    new Date().toISOString(),
  );
  return recipientRow(key)!.token;
}

/** Link for the email footer and the List-Unsubscribe header. */
export function unsubscribeUrl(address: string): string {
  return link(`/api/email/unsubscribe/${unsubscribeToken(address)}`);
}

/** True when someone used an unsubscribe link for this address (or a variant of it). */
export function isUnsubscribed(address: string): boolean {
  return !!recipientRow(recipientKey(address))?.unsubscribed_at;
}

/** The address an unsubscribe token belongs to, or null for an unknown token. */
export function addressForToken(token: string): { address: string; unsubscribed: boolean } | null {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) return null;
  const row = get<RecipientRow>('SELECT * FROM email_recipients WHERE token = ?', token);
  return row ? { address: row.address, unsubscribed: !!row.unsubscribed_at } : null;
}

/** Accounts whose email is this mailbox (variants included). */
function usersWithKey(key: string): Pick<UserRow, 'id' | 'email' | 'role' | 'notification_settings'>[] {
  const domain = key.slice(key.lastIndexOf('@') + 1);
  const domains = domain === 'gmail.com' ? ['gmail.com', 'googlemail.com'] : [domain];
  return all<Pick<UserRow, 'id' | 'email' | 'role' | 'notification_settings'>>(
    `SELECT id, email, role, notification_settings FROM users
     WHERE ${domains.map(() => 'email LIKE ?').join(' OR ')}`,
    ...domains.map((d) => `%@${d}`),
  ).filter((u) => recipientKey(u.email) === key);
}

/**
 * Stops every email the app queues for the token's address: students are opted out, teachers' daily reports turned
 * off, and the address stays on the list even without an account (an invited student who never signs up).
 */
export function unsubscribe(token: string, now = new Date()): boolean {
  const found = addressForToken(token);
  if (!found) return false;
  transaction(() => {
    run(
      'UPDATE email_recipients SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE token = ?',
      now.toISOString(),
      token,
    );
    for (const user of usersWithKey(found.address)) {
      if (user.role === 'student') {
        run('UPDATE users SET email_opt_out = 1 WHERE id = ?', user.id);
      } else {
        const settings = { ...parseJsonObject(user.notification_settings), dailyReport: false };
        run('UPDATE users SET notification_settings = ? WHERE id = ?', JSON.stringify(settings), user.id);
      }
    }
  });
  return true;
}

/** The account turned its emails back on (Account page): its address comes off the unsubscribe list. */
export function resubscribe(address: string): void {
  run('UPDATE email_recipients SET unsubscribed_at = NULL WHERE address = ?', recipientKey(address));
}
