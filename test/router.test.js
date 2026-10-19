'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Router, authorizeRoute } = require('../src/router');

test('router matches methods and route parameters in registration order', () => {
  const router = new Router();
  const first = () => {};
  const second = () => {};
  router.add('GET', '/api/items/:id', first, 'open');
  router.add('GET', '/api/items/recent', second, 'user');

  const parameterMatch = router.match('GET', '/api/items/recent');
  assert.equal(parameterMatch.route.handler, first);
  assert.deepEqual(parameterMatch.route.keys, ['id']);
  assert.equal(parameterMatch.match[1], 'recent');

  const methodMatch = router.match('POST', '/api/items/recent');
  assert.equal(methodMatch, null);
  assert.equal(router.match('GET', '/api/items/recent/extra'), null);
});

test('router returns encoded parameter captures for authorization-first decoding', () => {
  const router = new Router();
  router.add('GET', '/api/albums/:name/items/:id', () => {});

  const found = router.match('GET', '/api/albums/summer%20trip/items/photo%2F1');
  assert.deepEqual(found.route.keys, ['name', 'id']);
  assert.deepEqual(found.match.slice(1), ['summer%20trip', 'photo%2F1']);
});

test('route access policy checks origin and access before assigning a user', () => {
  const route = { access: 'user' };
  const dependencies = {
    auth: { session: () => null },
    adminAuth: { isSet: false, valid: () => false },
    isLocalRequest: () => true,
  };
  const request = { method: 'POST', headers: { host: 'photos.local', origin: 'https://attacker.local' } };

  assert.throws(() => authorizeRoute(request, 'POST', route, dependencies), (error) => error.status === 403);
  request.headers.origin = 'http://photos.local';
  assert.throws(() => authorizeRoute(request, 'POST', route, dependencies), (error) => error.status === 401);
  dependencies.auth.session = () => ({ user: 'alice' });
  authorizeRoute(request, 'POST', route, dependencies);
  assert.equal(request.user, 'alice');
});

test('local and admin routes preserve same-origin checks and HEAD access', () => {
  const dependencies = {
    auth: { session: () => null },
    adminAuth: { isSet: false, valid: () => false },
    isLocalRequest: () => true,
  };
  const request = { method: 'HEAD', headers: { host: 'localhost' } };

  assert.throws(() => authorizeRoute(request, 'POST', { access: 'admin' }, dependencies), (error) => error.status === 403);
  authorizeRoute(request, 'GET', { access: 'local' }, dependencies);
  assert.throws(() => authorizeRoute(request, 'GET', { access: 'admin' }, dependencies), /Set an admin password first/);
});
