require('chai').use(require('chai-as-promised'));
const { URL } = require('url');
const PouchDb = require('pouchdb-core');
PouchDb.plugin(require('pouchdb-adapter-http'));
PouchDb.plugin(require('../../src/index'));

const { expect } = require('chai');
const uuid = require('uuid').v4;

const utils = require('./utils');
const { Headers } = require('pouchdb-fetch');

const getSession = async (auth) => {
  const url = new URL(`${utils.baseUrl}/_session`);
  url.username = auth.username;
  url.password = auth.password;

  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json');

  const body = JSON.stringify({ name: auth.username, password: auth.password});
  const response = await PouchDb.fetch(url.toString(), { method: 'POST', headers, body });

  const cookie = response?.headers?.get('set-cookie');
  const sessionCookieName = 'AuthSession';
  const matches = cookie.match( new RegExp(`${sessionCookieName}=(.*)`));
  if (!matches) {
    return;
  }

  const parts = matches[1].split(';').map(item => item.trim().split('='));
  return parts[0][0];
};

const getDb = async (dbName, auth, session = null, includeAuth = false) => {
  const url = new URL(`${utils.baseUrl}/${dbName}`);
  session = session || await getSession(auth);
  const params = { skip_setup: true, session };
  if (includeAuth) {
    params.auth = auth;
  }
  const db = new PouchDb(url.toString(), params);
  await PouchDb.fetch(url.toString()); // overwrite last docker log entry
  return db;
};

describe('session auth type', function () {
  const dbName = 'testdb';
  let db;

  let tempDbName;
  let tempAdminName;
  let tempDb;

  this.timeout(12000);
  before(async () => {
    await utils.setupCouch(dbName);
    db = await getDb(dbName, utils.dbAuth);
  });

  beforeEach(() => {
    tempDbName = `temp${uuid()}`;
    tempAdminName = `temp${uuid()}`;
  });

  afterEach(async () => {
    try {
      await tempDb?.destroy();
    } catch (err) {
      // will throw if db doesn't exist
    }

    await utils.deleteDb(tempDbName);
    await utils.deleteAdmin(tempAdminName);
  });

  it('should use existent session when connecting to any DB', async () => {
    await utils.createDb(tempDbName);
    tempDb = await getDb(tempDbName, utils.dbAuth);

    const collectLogs = await utils.getDockerContainerLogs();
    await db.allDocs();
    await db.allDocs();
    await db.allDocs();
    await tempDb.allDocs();
    const logs = await collectLogs();

    expect(utils.getSessionRequests(logs).length).to.equal(0);
    expect(utils.getCookieAuthRequests(utils.dbAuth.username, logs).length).to.equal(4);
  });

  it('should fail if session is not valid', async () => {
    await utils.createDb(tempDbName);

    tempDb = await getDb(tempDbName, utils.dbAuth, 'invalid');

    const collectLogs = await utils.getDockerContainerLogs();
    await expect(tempDb.allDocs()).to.eventually.be.rejectedWith(
      'Malformed AuthSession cookie. Please clear your cookies.'
    );
    const logs = await collectLogs();

    expect(utils.getSessionRequests(logs).length).to.equal(0);
    expect(utils.getCookieAuthRequests(utils.dbAuth.username, logs).length).to.equal(0);
  });

  it('should fail if session is invalid due to password change', async () => {
    const auth = { username: tempAdminName, password: 'new_password' };
    await utils.createAdmin(auth.username, auth.password);
    await utils.createDb(tempDbName);

    tempDb = await getDb(tempDbName, auth, null, true);

    const collectLogs = await utils.getDockerContainerLogs();
    await tempDb.allDocs();
    await utils.createAdmin(auth.username, 'password change');
    await expect(tempDb.allDocs()).to.eventually.be.rejectedWith('Authentication required.');
    const logs = await collectLogs(1000);

    expect(utils.getSessionRequests(logs, false).length).to.equal(1);
    expect(utils.getDbRequest('undefined', logs, tempDbName, '/_all_docs', false).length).to.equal(2);
  });

  it('should try to get session again if credentials are provided but session is expired', async () => {
    await utils.createDb(tempDbName);
    tempDb = await getDb(tempDbName, utils.dbAuth, null, true);

    const collectLogs = await utils.getDockerContainerLogs();
    await utils.asyncTimeout(6000);
    await tempDb.allDocs();
    const logs = await collectLogs(1000);

    expect(utils.getSessionRequests(logs, true).length).to.equal(1);
    expect(utils.getDbRequest(utils.dbAuth.username, logs, tempDbName, '/_all_docs', true).length).to.equal(1);
  });

  it('should fail if neither session or auth works', async () => {
    const auth = { username: tempAdminName, password: 'new_password' };
    await utils.createAdmin(auth.username, auth.password);
    await utils.createDb(tempDbName);

    const session = await getSession(auth);
    const url = new URL(`${utils.baseUrl}/${tempDbName}`);
    tempDb = new PouchDb(url.toString(), { skip_setup: true, session, auth});
    await utils.createAdmin(auth.username, 'password update');

    const collectLogs = await utils.getDockerContainerLogs();
    await expect(tempDb.allDocs()).to.eventually.be.rejectedWith('Authentication required.');
    const logs = await collectLogs();

    expect(utils.getSessionRequests(logs, false).length).to.equal(1);
  });
});
