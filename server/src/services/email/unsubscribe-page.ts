/**
 * The small pages behind the unsubscribe link in every email. They are served by the API itself (no sign-in, no
 * app needed), and the link only shows a confirmation button: mail scanners that open links must not unsubscribe
 * anyone. Mail apps' own "Unsubscribe" button POSTs to the same address (RFC 8058) and unsubscribes at once.
 */
import { emailConfig } from './config.js';
import { escapeHtml } from './format.js';

/** "a***@gmail.com": enough for the owner to recognise the address, not enough to learn it from the link. */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${address[0]}***${address.slice(at)}`;
}

function page(title: string, body: string): string {
  const brand = escapeHtml(emailConfig().fromName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · ${brand}</title>
</head>
<body style="margin:0;padding:24px 12px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2933;">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e4e7eb;border-radius:8px;padding:22px;">
<p style="margin:0 0 12px;font-size:14px;font-weight:bold;color:#1e7145;">${brand}</p>
<h1 style="margin:0 0 12px;font-size:21px;">${escapeHtml(title)}</h1>
${body}
</div>
</body>
</html>
`;
}

const paragraph = (text: string) => `<p style="margin:0 0 12px;line-height:1.5;">${text}</p>`;

export function confirmPage(address: string): string {
  const brand = escapeHtml(emailConfig().fromName);
  return page(
    'Stop these emails?',
    paragraph(`${brand} will stop emailing <strong>${escapeHtml(maskAddress(address))}</strong>.`) +
      `<form method="post"><button type="submit" style="background:#1e7145;color:#fff;border:0;border-radius:6px;` +
      `padding:11px 20px;font-size:16px;font-weight:bold;cursor:pointer;">Unsubscribe</button></form>`,
  );
}

export function donePage(address: string): string {
  const brand = escapeHtml(emailConfig().fromName);
  return page(
    "You're unsubscribed",
    paragraph(`${brand} won't send more emails to <strong>${escapeHtml(maskAddress(address))}</strong>.`) +
      paragraph('Changed your mind? Sign in and turn emails back on on your Account page.'),
  );
}

export function invalidPage(): string {
  return page(
    'This link is not valid',
    paragraph('The unsubscribe link may have been copied incompletely. Try the link in the email again.'),
  );
}
