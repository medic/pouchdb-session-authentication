# PouchDb Session Authentication plugin

Enables session cookie authentication for `pouchdb-adapter-http`.

### Installation
```bash
npm install pouchdb-session-authentication
```

### Usage
```javascript
const PouchDb = require('pouchdb-core');
PouchDb.plugin(require('pouchdb-adapter-http'));
PouchDb.plugin(require('pouchdb-session-authentication'));

const myDb = new PouchDB('http://admin:pass@mysite:5984/mydb');
const myOtherDb = new PouchDB(
  'http://mysite:5984/mydb', 
  { auth: { username: 'admin', password: 'pass' } 
});
const sessionDb = new PouchDB('http://mysite:5984/mydb', { session: 'existent session cookie' });

await myDb.allDocs();
await myOtherDb.allDocs();
await sessionDb.allDocs();
```

## Overview

By default, `pouchdb-adapter-http` uses basic authentication for every outgoing request to CouchDb. 
CouchDb security configuration allows for setting the number of password hashing iterations, with the default number being 10000. The disclaimer for using a high number of iterations is:

> When using hundreds of thousands of iterations, use session cookies, or the performance hit will be huge. (The internal hashing algorithm is SHA1, which affects the recommended number of iterations.)
 
[Source](https://docs.couchdb.org/en/stable/config/auth.html#chttpd_auth/iterations)

This plugin generates and stores a session cookie for pairs of user + CouchDb server instance and appends a Cookie header to all outgoing requests. 

Integration should be seamless, the only requirement is adding the plugin _after_ the `pouchdb-adapter-http`, with no additional necessary on the developer's part.

It supports authentication embedded in the CouchDb URL or as an additional option field when declaring the database. 

It regenerates the session cookie on expiry and retries the last request, the client should not expect a failed request for an expired cookie.

When given a `session` parameter, a new session will not be requested, instead the passed session cookie will be used as session authentication. If both `session` and `auth` are provided then the `auth` will only be used if the session token has expired.

### Testing

Testing requires `docker` and `docker-compose` to launch a CouchDb 3.3.3 container.

```bash
npm ci
npm run test
npm run integration
```
