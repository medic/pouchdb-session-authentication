const util = require('util');
const { URL } = require('url');
const { Headers } = require('pouchdb-fetch');

const sessionCookieName = 'AuthSession';
const cookieRegex = new RegExp(`${sessionCookieName}=(.*)`);
const sessions = {};

const parseCookie = (response) => {
  const cookie = response && response.headers && response.headers.get('set-cookie');
  if (!cookie) {
    return;
  }

  // Unfortunately, node-fetch doesn't handle multiple cookies
  // https://github.com/node-fetch/node-fetch/issues/251
  // AuthSession=YWRtaW46NjU5RDRFMzI6Qi5U7t5gHQMn4MgOYkEAX2qH5HZUpn6nKdX8Ik7gDpY; Version=1; Expires=Wed,
  // 08-Jan-2025 13:46:26 GMT; Max-Age=31536000; Path=/; HttpOnly

  const matches = cookie.match(cookieRegex);
  if (!matches) {
    return;
  }

  const parts = matches[1].split(';').map(item => item.trim().split('='));
  const token = parts[0][0];
  if (!token) {
    return;
  }

  return {
    token: parts[0][0],
    expires: new Date(parts.find(part => part[0] === 'Expires')[1]).valueOf(),
  };
};

const getSessionKey = (db) => {
  const sessionUrl = getSessionUrl(db);
  const username = db.credentials && db.credentials.username;
  const password = db.credentials && db.credentials.password;
  return `${username}:${password}:${db.session}:${sessionUrl}`;
};

const getSessionUrl = (db) => {
  const url = new URL(db.name);
  url.pathname = '/_session';
  return url.toString();
};

const authenticate = async (db) => {
  if (!db || !db.credentials || !db.credentials.username) {
    return;
  }

  const url = getSessionUrl(db);

  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json');

  const body = JSON.stringify({ name: db.credentials.username, password: db.credentials.password});
  const response = await db.originalFetch(url.toString(), { method: 'POST', headers, body });
  return updateSession(db, response);
};

const setSession = (db, session) => {
  if (session) {
    const sessionKey = getSessionKey(db);
    sessions[sessionKey] = session;
    return session;
  }
};

const updateSession = (db, response) => {
  const session = parseCookie(response);
  return setSession(db, session);
};

const invalidateSession = db => {
  const sessionKey = getSessionKey(db);
  delete sessions[sessionKey];
};

const extractAuth = (opts) => {
  if (opts.auth) {
    opts.credentials = opts.auth;
    delete opts.auth;
  }

  const url = new URL(opts.name);
  if (url.username) {
    opts.credentials = {
      username: url.username,
      password: url.password
    };
    url.username = '';
    url.password = '';
    opts.name = url.toString();
  }

  if (opts.session) {
    setSession(opts, { token: opts.session, expires: Number.MAX_SAFE_INTEGER });
  }
};

const isValid = (session) => {
  if (!session || !session.expires) {
    return false;
  }
  const isExpired =  Date.now() > session.expires;
  return !isExpired;
};

const getValidSession = async (db) => {
  const sessionKey = getSessionKey(db);

  if (sessions[sessionKey]) {
    const session = await sessions[sessionKey];
    if (isValid(session)) {
      return session;
    }
  }

  sessions[sessionKey] = authenticate(db);
  return sessions[sessionKey];
};

// eslint-disable-next-line func-style
function wrapAdapter (PouchDB, HttpPouch) {
  // eslint-disable-next-line func-style
  function HttpSessionPouch(db, callback) {
    extractAuth(db);
    if (!db.credentials && !db.session) {
      HttpPouch.call(this, db, callback);
      return;
    }

    db.originalFetch = db.fetch || PouchDB.fetch;
    db.fetch = async (url, opts = {}) => {
      const session = await getValidSession(db);

      if (session) {
        opts.headers = opts.headers || new Headers();
        opts.headers.set('Cookie', `${sessionCookieName}=${session.token}`);
      }

      const response = await db.originalFetch(url, opts);
      if (response.status === 401 && session) {
        invalidateSession(db);
        return db.fetch(url, opts);
      }

      updateSession(db, response);
      return response;
    };

    HttpPouch.call(this, db, callback);
  }
  HttpSessionPouch.valid = () => true;

  util.inherits(HttpSessionPouch, HttpPouch);
  return HttpSessionPouch;
}

module.exports = function (PouchDB) {
  if (!PouchDB.adapters.http) {
    return;
  }

  PouchDB.adapters.http = wrapAdapter(PouchDB, PouchDB.adapters.http);
  PouchDB.adapters.https = wrapAdapter(PouchDB, PouchDB.adapters.https);
};
