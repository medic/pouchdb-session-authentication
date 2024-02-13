const util = require('node:util');
const { Headers } = require('pouchdb-fetch');

const sessionCookieName = 'AuthSession';
const cookieRegex = new RegExp(`${sessionCookieName}=(.*)`);
const sessions = {};

const parseCookie = (response) => {
  const cookie = response?.headers?.get('set-cookie');
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
  return `${db.credentials.username}:${db.credentials.password}:${sessionUrl}`;
};

const getSessionUrl = (db) => {
  const url = new URL(db.name);
  url.pathname = '/_session';
  return url.toString();
};

const authenticate = async (db) => {
  const url = getSessionUrl(db);

  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json');

  const body = JSON.stringify({ name: db.credentials.username, password: db.credentials.password});
  const response = await db.originalFetch(url.toString(), { method: 'POST', headers, body });
  return updateSession(db, response);
};

const updateSession = (db, response) => {
  const session = parseCookie(response);
  if (session) {
    const sessionKey = getSessionKey(db);
    sessions[sessionKey] = session;
    return session;
  }
};

const invalidateSession = db => {
  const sessionKey = getSessionKey(db);
  delete sessions[sessionKey];
};

const getSession = async (db) => {
  const sessionKey = getSessionKey(db);
  const session = sessions[sessionKey];

  if (session) {
    return session;
  }

  sessions[sessionKey] = authenticate(db);
  return sessions[sessionKey];
};

const extractAuth = (opts) => {
  if (opts.auth) {
    opts.credentials = opts.auth;
  }

  const url = new URL(opts.name);
  if (!url.username) {
    return;
  }

  opts.credentials = {
    username: url.username,
    password: url.password
  };
};

const validateSession = (db, session) => {
  if (!session || !session.expires) {
    return;
  }

  const isExpired =  Date.now() > session.expires;
  if (isExpired) {
    invalidateSession(db);
    return getSession(db);
  }

  return session;
};

// eslint-disable-next-line func-style
function wrapAdapter (PouchDB, HttpPouch) {
  // eslint-disable-next-line func-style
  function HttpSessionPouch(db, callback) {
    extractAuth(db);
    if (!db.credentials) {
      HttpPouch.call(this, db, callback);
      return;
    }

    db.originalFetch = db.fetch || PouchDB.fetch;
    db.fetch = async (url, opts = {}) => {
      const session = await validateSession(db, await getSession(db));

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
