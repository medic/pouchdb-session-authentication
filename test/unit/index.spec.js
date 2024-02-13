const rewire = require('rewire');
const sinon = require('sinon');
const { expect } = require('chai');
const chai = require('chai');
const { Headers } = require('pouchdb-fetch');
chai.config.truncateThreshold = 0; // disable truncating

let plugin;
let PoudhDb;
let httpAdapter;
let httpsAdapter;
let fetch;
let db;
let clock;

const getSession = (string, date) => {
  date = date || new Date(Date.now() + 1000).toString();
  return `AuthSession=${string}; Version=1; Expires=${date}; Max-Age=31536000; Path=/; HttpOnly`;
};

describe('Pouchdb Session authentication plugin', () => {
  beforeEach(() => {
    plugin = rewire('../../src/index');

    httpsAdapter = sinon.stub();
    httpAdapter = sinon.stub();
    fetch = sinon.stub();
    fetch.Headers = Headers;
    PoudhDb = {
      fetch,
      adapters: {
        http: httpAdapter,
        https: httpsAdapter,
      }
    };

  });
  afterEach(() => {
    sinon.restore();
    clock?.restore();
  });

  describe('setup', () => {
    it('should do nothing if applied over PouchDb without http adapter', () => {
      plugin({ adapters: {} });
    });

    it('should wrap existent http adapters', () => {
      plugin(PoudhDb);
      expect(httpAdapter.callCount).to.equal(0);
      expect(httpsAdapter.callCount).to.equal(0);
      expect(httpsAdapter).to.not.equal(PoudhDb.adapters.https);
      expect(httpAdapter).to.not.equal(PoudhDb.adapters.http);
    });    
  });

  describe('extracting authentication', () => {
    it('should do nothing when there is no authentication', () => {
      db = { name: 'http://localhost:5984/dbname', fetch };
      plugin(PoudhDb);
      PoudhDb.adapters.http(db);

      expect(db.fetch).to.equal(fetch);
      expect(db.name).to.equal('http://localhost:5984/dbname');
      expect(db.credentials).to.equal(undefined);
      expect(db.auth).to.equal(undefined);
    });

    it('should extract basic auth', () => {
      db = { name: 'http://admin:pass@localhost:5984/dbname', fetch };
      plugin(PoudhDb);
      PoudhDb.adapters.http(db);

      expect(db.fetch).to.not.equal(fetch);
      expect(db.name).to.equal('http://admin:pass@localhost:5984/dbname');
      expect(db.credentials).to.deep.equal({ username: 'admin', password: 'pass' });
      expect(db.auth).to.equal(undefined);
    });

    it('should extract explicit auth', () => {
      db = { name: 'http://localhost:5984/name', fetch, auth: { username: 'admin', password: 'pass' }};
      plugin(PoudhDb);
      PoudhDb.adapters.http(db);

      expect(db.fetch).to.not.equal(fetch);
      expect(db.name).to.equal('http://localhost:5984/name');
      expect(db.credentials).to.deep.equal({ username: 'admin', password: 'pass' });
      expect(db.auth).to.deep.equal({ username: 'admin', password: 'pass' });
    });
  });

  describe('wrapping fetch', () => {
    it('should handle the case where the db a custom fetch function', () => {
      const dbFetch = sinon.stub();
      db = { name: 'http://localhost:5984/db', fetch: dbFetch, auth: { username: 'admin', password: 'pass' }};
      plugin(PoudhDb);
      PoudhDb.adapters.http(db);

      expect(db.originalFetch).to.equal(dbFetch);
      expect(db.fetch).to.not.equal(dbFetch);
    });

    it('should handle the case where the db does not have a custom fetch function', () => {
      db = { name: 'http://localhost:5984/db', auth: { username: 'admin', password: 'pass' }};
      plugin(PoudhDb);
      PoudhDb.adapters.http(db);

      expect(db.originalFetch).to.equal(fetch);
      expect(db.fetch).to.not.equal(fetch);
    });
  });
  
  describe('fetching', () => {
    it('should get a new session for a new user-domain pair', async () => {
      db = { name: 'http://localhost:5984/db_name', auth: { username: 'admin', password: 'pass' }};
      plugin(PoudhDb);
      PoudhDb.adapters.http(db);

      fetch.resolves({ ok: true, status: 200 });
      fetch.withArgs('http://localhost:5984/_session').resolves({
        ok: true,
        status: 200,
        headers: new Headers({ 'set-cookie': getSession('sess') }),
      });
      const response = await db.fetch('randomUrl');

      expect(response).to.deep.equal({ ok: true, status: 200 });
      expect(fetch.callCount).to.equal(2);
      expect(fetch.args[0]).to.deep.equal([
        'http://localhost:5984/_session',
        {
          method: 'POST',
          headers: new Headers({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          }),
          body: JSON.stringify({ name: 'admin', password: 'pass' }),
        }
      ]);
      expect(fetch.args[1]).to.deep.equal([
        'randomUrl',
        { headers: new Headers({ 'Cookie': 'AuthSession=sess' }) }
      ]);
    });

    it('should use existing session for an existent db for an existent domain', async () => {
      db = { name: 'http://localhost:5984', auth: { username: 'admin', password: 'pass' }};
      plugin(PoudhDb);
      PoudhDb.adapters.http(db);

      fetch.resolves({ ok: true, status: 200 });
      fetch.withArgs('http://localhost:5984/_session').resolves({
        ok: true,
        status: 200,
        headers: new Headers({ 'set-cookie': getSession('session1') })
      });
      await db.fetch('randomUrl1');
      await db.fetch('randomUrl2');

      expect(fetch.callCount).to.equal(3);
      expect(fetch.args[0]).to.deep.equal([
        'http://localhost:5984/_session',
        {
          method: 'POST',
          headers: new Headers({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          }),
          body: JSON.stringify({ name: 'admin', password: 'pass' }),
        }
      ]);
      expect(fetch.args[1]).to.deep.equal([
        'randomUrl1',
        { headers: new Headers({ 'Cookie': 'AuthSession=session1' }) }
      ]);
      expect(fetch.args[2]).to.deep.equal([
        'randomUrl2',
        { headers: new Headers({ 'Cookie': 'AuthSession=session1' }) }
      ]);
    });

    it('should use existing session for new db and same user for an existent domain', async () => {
      const db1 = { name: 'http://localhost:5984/db1', auth: { username: 'admin', password: 'pass' }};
      const db2 = { name: 'http://localhost:5984/db2', auth: { username: 'admin', password: 'pass' }};
      plugin(PoudhDb);
      PoudhDb.adapters.http(db1);
      PoudhDb.adapters.http(db2);

      fetch.resolves({ ok: true, status: 200 });
      fetch.withArgs('http://localhost:5984/_session').resolves({
        ok: true,
        status: 200,
        headers: new Headers({ 'set-cookie': getSession('session1') })
      });
      await db1.fetch('http://localhost:5984/db1');
      await db2.fetch('http://localhost:5984/db2');

      expect(fetch.callCount).to.equal(3);
      expect(fetch.args[0]).to.deep.equal([
        'http://localhost:5984/_session',
        {
          method: 'POST',
          headers: new Headers({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          }),
          body: JSON.stringify({ name: 'admin', password: 'pass' }),
        }
      ]);
      expect(fetch.args[1]).to.deep.equal([
        'http://localhost:5984/db1',
        { headers: new Headers({ 'Cookie': 'AuthSession=session1' }) }
      ]);
      expect(fetch.args[2]).to.deep.equal([
        'http://localhost:5984/db2',
        { headers: new Headers({ 'Cookie': 'AuthSession=session1' }) }
      ]);
    });
    
    it('should get a new session for a new user for an existent domain', async () => {
      const db1 = { name: 'http://localhost:5984/db1', auth: { username: 'usr1', password: 'pass' }};
      const db2 = { name: 'http://localhost:5984/db2', auth: { username: 'usr2', password: 'pass' }};
      plugin(PoudhDb);
      PoudhDb.adapters.http(db1);
      PoudhDb.adapters.http(db2);

      fetch.resolves({ ok: true, status: 200 });
      fetch
        .withArgs('http://localhost:5984/_session', sinon.match({ body: JSON.stringify({ name: 'usr1', password: 'pass' } ) }))
        .resolves({
          ok: true,
          status: 200,
          headers: new Headers({ 'set-cookie': getSession('user1session') })
        });
      fetch
        .withArgs('http://localhost:5984/_session', sinon.match({ body: JSON.stringify({ name: 'usr2', password: 'pass' } ) }))
        .resolves({
          ok: true,
          status: 200,
          headers: new Headers({ 'set-cookie': getSession('user2session') })
        });

      await db1.fetch('http://localhost:5984/db1');
      await db2.fetch('http://localhost:5984/db2');

      expect(fetch.callCount).to.equal(4);
      expect(fetch.args[0]).to.deep.equal([
        'http://localhost:5984/_session',
        {
          method: 'POST',
          headers: new Headers({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          }),
          body: JSON.stringify({ name: 'usr1', password: 'pass' }),
        }
      ]);
      expect(fetch.args[1]).to.deep.equal([
        'http://localhost:5984/db1',
        { headers: new Headers({ 'Cookie': 'AuthSession=user1session' }) }
      ]);
      expect(fetch.args[2]).to.deep.equal([
        'http://localhost:5984/_session',
        {
          method: 'POST',
          headers: new Headers({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          }),
          body: JSON.stringify({ name: 'usr2', password: 'pass' }),
        }
      ]);
      expect(fetch.args[3]).to.deep.equal([
        'http://localhost:5984/db2',
        { headers: new Headers({ 'Cookie': 'AuthSession=user2session' }) }
      ]);

      await db1.fetch('http://localhost:5984/db1/_all_docs');
      await db2.fetch('http://localhost:5984/db2/_all_docs');

      expect(fetch.callCount).to.equal(6);

      expect(fetch.args[4]).to.deep.equal([
        'http://localhost:5984/db1/_all_docs',
        { headers: new Headers({ 'Cookie': 'AuthSession=user1session' }) }
      ]);
      expect(fetch.args[5]).to.deep.equal([
        'http://localhost:5984/db2/_all_docs',
        { headers: new Headers({ 'Cookie': 'AuthSession=user2session' }) }
      ]);
    });

    it('should only request session once for concurrent requests', async () => {
      db = { name: 'http://admin:pass@localhost:5984/mydb' };
      plugin(PoudhDb);
      PoudhDb.adapters.http(db);

      fetch.resolves({ ok: true, status: 200 });
      fetch.withArgs('http://admin:pass@localhost:5984/_session').resolves({
        ok: true,
        status: 200,
        headers: new Headers({ 'set-cookie': getSession('theonetruesession') })
      });

      await Promise.all([
        db.fetch('randomUrl1'),
        db.fetch('randomUrl1'),
        db.fetch('randomUrl1'),
        db.fetch('randomUrl1'),
      ]);

      expect(fetch.callCount).to.equal(5);
      expect(fetch.args[0]).to.deep.equal([
        'http://admin:pass@localhost:5984/_session',
        {
          method: 'POST',
          headers: new Headers({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          }),
          body: JSON.stringify({ name: 'admin', password: 'pass' }),
        }
      ]);
      expect(fetch.args[1]).to.deep.equal([
        'randomUrl1',
        { headers: new Headers({ 'Cookie': 'AuthSession=theonetruesession' }) }
      ]);
      expect(fetch.args[2]).to.deep.equal([
        'randomUrl1',
        { headers: new Headers({ 'Cookie': 'AuthSession=theonetruesession' }) }
      ]);
      expect(fetch.args[3]).to.deep.equal([
        'randomUrl1',
        { headers: new Headers({ 'Cookie': 'AuthSession=theonetruesession' }) }
      ]);
      expect(fetch.args[4]).to.deep.equal([
        'randomUrl1',
        { headers: new Headers({ 'Cookie': 'AuthSession=theonetruesession' }) }
      ]);
    });
    
    it('should update the session if server responds with new cookie', async () => {
      db = { name: 'http://admin:pass@localhost:5984/mydb' };
      plugin(PoudhDb);
      PoudhDb.adapters.http(db);

      fetch.resolves({ ok: true, status: 200 });
      fetch.withArgs('http://admin:pass@localhost:5984/_session').resolves({
        ok: true,
        status: 200,
        headers: new Headers({ 'set-cookie': getSession('session1') })
      });
      await db.fetch('randomUrl1');

      expect(fetch.callCount).to.equal(2);
      expect(fetch.args[0]).to.deep.equal([
        'http://admin:pass@localhost:5984/_session',
        {
          method: 'POST',
          headers: new Headers({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          }),
          body: JSON.stringify({ name: 'admin', password: 'pass' }),
        }
      ]);
      expect(fetch.args[1]).to.deep.equal([
        'randomUrl1',
        { headers: new Headers({ 'Cookie': 'AuthSession=session1' }) }
      ]);

      fetch.resolves({
        ok: true,
        status: 200,
        headers: new Headers({ 'set-cookie': getSession('session2') })
      });
      await db.fetch('randomUrl2');
      expect(fetch.args[2]).to.deep.equal([
        'randomUrl2',
        { headers: new Headers({ 'Cookie': 'AuthSession=session1' }) }
      ]);

      await db.fetch('randomUrl3');
      expect(fetch.args[3]).to.deep.equal([
        'randomUrl3',
        { headers: new Headers({ 'Cookie': 'AuthSession=session2' }) }
      ]);
    }); 
    
    it('should delete session if response is 401 and try again', async () => {
      db = { name: 'http://usr:pass@localhost:5984/mydb' };
      plugin(PoudhDb);
      PoudhDb.adapters.http(db);

      fetch.resolves({ ok: true, status: 200 });
      fetch.withArgs('http://usr:pass@localhost:5984/_session').onCall(0).resolves({
        ok: true,
        status: 200,
        headers: new Headers({ 'set-cookie': getSession('session1') })
      });
      fetch.withArgs('http://usr:pass@localhost:5984/_session').onCall(1).resolves({
        ok: true,
        status: 200,
        headers: new Headers({ 'set-cookie': getSession('session2') })
      });
      await db.fetch('randomUrl1');

      expect(fetch.callCount).to.equal(2);
      expect(fetch.args[0]).to.deep.equal([
        'http://usr:pass@localhost:5984/_session',
        {
          method: 'POST',
          headers: new Headers({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          }),
          body: JSON.stringify({ name: 'usr', password: 'pass' }),
        }
      ]);
      expect(fetch.args[1]).to.deep.equal([
        'randomUrl1',
        { headers: new Headers({ 'Cookie': 'AuthSession=session1' }) }
      ]);

      fetch.onCall(2).resolves({
        ok: false,
        status: 401,
      });

      await db.fetch('randomUrl2');

      expect(fetch.args[3]).to.deep.equal([
        'http://usr:pass@localhost:5984/_session',
        {
          method: 'POST',
          headers: new Headers({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          }),
          body: JSON.stringify({ name: 'usr', password: 'pass' }),
        }
      ]);
      expect(fetch.args[4]).to.deep.equal([
        'randomUrl2',
        { headers: new Headers({ 'Cookie': 'AuthSession=session2' }) }
      ]);
    }); 

    it('should update session when expired', async () => {
      clock = sinon.useFakeTimers();
      clock.setSystemTime(new Date('Wed,07-Jan-2024 13:46:26 GMT').valueOf());

      plugin = rewire('../../src/index');
      db = { name: 'http://usr:pass@localhost:5984/mydb' };
      plugin(PoudhDb);
      PoudhDb.adapters.http(db);

      fetch.resolves({ ok: true, status: 200 });
      fetch.withArgs('http://usr:pass@localhost:5984/_session').onCall(0).resolves({
        ok: true,
        status: 200,
        headers: new Headers({ 'set-cookie': getSession('session1') })
      });
      await db.fetch('randomUrl1');
      clock.setSystemTime(new Date('Wed,09-Jan-2024 13:46:26 GMT').valueOf());
      fetch.withArgs('http://usr:pass@localhost:5984/_session').onCall(1).resolves({
        ok: true,
        status: 200,
        headers: new Headers({ 'set-cookie': getSession('session2') })
      });
      await db.fetch('randomUrl2');

      expect(fetch.args[0]).to.deep.equal([
        'http://usr:pass@localhost:5984/_session',
        {
          method: 'POST',
          headers: new Headers({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          }),
          body: JSON.stringify({ name: 'usr', password: 'pass' }),
        }
      ]);
      expect(fetch.args[1]).to.deep.equal([
        'randomUrl1',
        { headers: new Headers({ 'Cookie': 'AuthSession=session1' }) }
      ]);

      expect(fetch.args[2]).to.deep.equal([
        'http://usr:pass@localhost:5984/_session',
        {
          method: 'POST',
          headers: new Headers({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          }),
          body: JSON.stringify({ name: 'usr', password: 'pass' }),
        }
      ]);
      expect(fetch.args[3]).to.deep.equal([
        'randomUrl2',
        { headers: new Headers({ 'Cookie': 'AuthSession=session2' }) }
      ]);
    });

    it('should continue if getting session fails', async () => {
      db = { name: 'http://localhost:5984/db_name', auth: { username: 'admin', password: 'pass' }};
      plugin(PoudhDb);
      PoudhDb.adapters.http(db);

      fetch.resolves({ ok: false, status: 401, body: 'omg' });
      fetch.withArgs('http://localhost:5984/_session').resolves({ ok: false, status: 401 });
      const response = await db.fetch('randomUrl');

      expect(response).to.deep.equal({ ok: false, status: 401, body: 'omg' });
      expect(fetch.callCount).to.equal(2);
      expect(fetch.args[0]).to.deep.equal([
        'http://localhost:5984/_session',
        {
          method: 'POST',
          headers: new Headers({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          }),
          body: JSON.stringify({ name: 'admin', password: 'pass' }),
        }
      ]);
      expect(fetch.args[1]).to.deep.equal([ 'randomUrl', {} ]);

      const response2 = await db.fetch('randomUrl');

      expect(response2).to.deep.equal({ ok: false, status: 401, body: 'omg' });
      expect(fetch.callCount).to.equal(4);
      expect(fetch.args[2]).to.deep.equal([
        'http://localhost:5984/_session',
        {
          method: 'POST',
          headers: new Headers({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          }),
          body: JSON.stringify({ name: 'admin', password: 'pass' }),
        }
      ]);
      expect(fetch.args[3]).to.deep.equal([ 'randomUrl', {} ]);
    });

    it('should continue when session cookie is not returned', async () => {
      db = { name: 'http://localhost:5984/db_name', auth: { username: 'admin', password: 'pass' }};
      plugin(PoudhDb);
      PoudhDb.adapters.http(db);

      fetch.resolves({ ok: false, status: 401, body: 'omg' });
      fetch.withArgs('http://localhost:5984/_session').resolves({ ok: false, status: 401, headers: new Headers({
        'set-cookie': 'othercookie=whatever',
        'Content-Type': 'application/json',
      }) });
      const response = await db.fetch('randomUrl');

      expect(response).to.deep.equal({ ok: false, status: 401, body: 'omg' });
      expect(fetch.callCount).to.equal(2);
      expect(fetch.args[0]).to.deep.equal([
        'http://localhost:5984/_session',
        {
          method: 'POST',
          headers: new Headers({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          }),
          body: JSON.stringify({ name: 'admin', password: 'pass' }),
        }
      ]);
      expect(fetch.args[1]).to.deep.equal([ 'randomUrl', {} ]);
    });

    it('should continue when session cookie is empty', async () => {
      db = { name: 'http://localhost:5984/db_name', auth: { username: 'admin', password: 'pass' }};
      plugin(PoudhDb);
      PoudhDb.adapters.http(db);

      fetch.resolves({ ok: false, status: 401, body: 'omg' });
      fetch.withArgs('http://localhost:5984/_session').resolves({ ok: false, status: 401, headers: new Headers({
        'set-cookie': getSession(''),
        'Content-Type': 'application/json',
      }) });
      const response = await db.fetch('randomUrl');

      expect(response).to.deep.equal({ ok: false, status: 401, body: 'omg' });
      expect(fetch.callCount).to.equal(2);
      expect(fetch.args[0]).to.deep.equal([
        'http://localhost:5984/_session',
        {
          method: 'POST',
          headers: new Headers({
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          }),
          body: JSON.stringify({ name: 'admin', password: 'pass' }),
        }
      ]);
      expect(fetch.args[1]).to.deep.equal([ 'randomUrl', {} ]);
    });
  });
});
