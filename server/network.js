'use strict';
const {isIP}=require('net');

/**
 * Resolve client IP for abuse controls.
 * Cloudflare Tunnel connects to the origin over loopback, so the socket address is
 * not the visitor. Trust CF-Connecting-IP only for loopback-origin requests; never
 * trust generic X-Forwarded-For because visitors can supply it themselves.
 */
function isLoopback(address) {
  const ip = String(address || '').toLowerCase();
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function clientIp(req) {
  const remote = String(req.socket && req.socket.remoteAddress || 'unknown');
  if (process.env.LOAM_TRUST_CF_TUNNEL === 'true' && isLoopback(remote)) {
    const cf = req.headers && req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && isIP(cf.trim())) return cf.trim();
  }
  return remote;
}

module.exports = { isLoopback, clientIp };
