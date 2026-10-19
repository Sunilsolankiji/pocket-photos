'use strict';

/** Normalizes IPv4-mapped IPv6 addresses ("::ffff:1.2.3.4" -> "1.2.3.4"). */
function normIp(addr) {
  const a = String(addr || '').toLowerCase();
  return a.startsWith('::ffff:') && a.includes('.') ? a.slice(7) : a;
}

function v4(a) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  return m ? m.slice(1).map(Number) : null;
}

function isLoopback(addr) {
  const a = normIp(addr);
  const p = v4(a);
  return p ? p[0] === 127 : a === '::1';
}

/** True for loopback, LAN (RFC1918), link-local, CGNAT/Tailscale and IPv6 ULA/link-local addresses. */
function isPrivate(addr) {
  const a = normIp(addr);
  const p = v4(a);
  if (p) {
    return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)
      || (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
  }
  return a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
}

/** Hostname part of a Host header ("[::1]:8080" -> "::1", "localhost:8080" -> "localhost"). */
function hostName(host) {
  const h = String(host || '').toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}

/**
 * A request counts as "on the phone itself" only if it arrives from a loopback address AND
 * was addressed to a loopback name. The Host check defeats DNS-rebinding attacks from web pages.
 */
function isLocalRequest(req) {
  return isLoopback(req.socket.remoteAddress) && ['localhost', '127.0.0.1', '::1'].includes(hostName(req.headers.host));
}

module.exports = { normIp, isLoopback, isPrivate, hostName, isLocalRequest };
