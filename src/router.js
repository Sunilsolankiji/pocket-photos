'use strict';

const { HttpError } = require('./library');

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, access = 'user') {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, key) => (keys.push(key), '([^/]+)')) + '$');
    const route = { method, re, keys, handler, access };
    this.routes.push(route);
    return route;
  }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.re.exec(pathname);
      if (match) return { route, match };
    }
    return null;
  }
}

function authorizeRoute(req, method, route, { auth, adminAuth, isLocalRequest }) {
  if (method !== 'GET') {
    const origin = req.headers.origin;
    if (origin) {
      let host = null;
      try {
        host = new URL(origin).host;
      } catch {
        /* invalid origin */
      }
      if (host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked');
    } else if (route.access === 'admin' || route.access === 'local') {
      throw new HttpError(403, 'Admin changes must come from the admin page');
    }
  }
  if ((route.access === 'admin' || route.access === 'local') && !isLocalRequest(req)) {
    throw new HttpError(403, 'Admin is only available on the phone itself (http://localhost)');
  }
  if (route.access === 'admin' && !adminAuth.valid(req)) {
    throw new HttpError(401, adminAuth.isSet ? 'Admin sign-in required' : 'Set an admin password first');
  }
  if (route.access === 'user') {
    const session = auth.session(req);
    if (!session) throw new HttpError(401, 'Login required');
    req.user = session.user;
  }
}

module.exports = { Router, authorizeRoute };
