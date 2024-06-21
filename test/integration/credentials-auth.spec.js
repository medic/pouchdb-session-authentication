require('chai').use(require('chai-as-promised'));
const { URL } = require('url');
const PouchDb = require('pouchdb-core');
PouchDb.plugin(require('pouchdb-adapter-http'));
PouchDb.plugin(require('../../src/index'));

const { expect } = require('chai');
const uuid = require('uuid').v4;

const utils = require('./utils');
const authType = process.env.AUTH_TYPE || 'auth';

const getDb = (dbName, auth, authType, skip_setup = true) => {
  if (authType === 'url') {
    const url = new URL(`${utils.baseUrl}/${dbName}`);
    url.username = auth.username;
    url.password = auth.password;
    return new PouchDb(url.toString(), { skip_setup });
  }

  return new PouchDb(`${utils.baseUrl}/${dbName}`, { skip_setup, auth });
};

describe(`integration with ${authType}`, async function () {
  const dbName = 'testdb';
  let db;

  let tempDbName;
  let tempAdminName;
  let tempDb;

  const wrongAuthError = 'Authentication required.';

  this.timeout(12000);
  before(async () => {
    await utils.setupCouch(dbName);
    db = getDb(dbName, utils.dbAuth, authType);
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


  it('should setup session on first request and reuse session on subsequent request', async () => {
    const collectLogs = await utils.getDockerContainerLogs();
    await db.allDocs();
    await db.allDocs();
    await db.allDocs();
    const logs = await collectLogs();

    expect(utils.getSessionRequests(logs).length).to.equal(1);
    expect(utils.getCookieAuthRequests(utils.dbAuth.username, logs).length).to.equal(3);
  });

  it('should reuse the same session for new databases', async () => {
    const collectLogs = await utils.getDockerContainerLogs();
    await db.allDocs();

    tempDb = getDb(tempDbName, utils.dbAuth, authType);
    await utils.createDb(tempDbName);

    await tempDb.allDocs();

    const logs = await collectLogs();
    expect(utils.getSessionRequests(logs).length).to.equal(0);
    expect(utils.getCookieAuthRequests(utils.dbAuth.username, logs).length).to.be.least(2);
  });

  it('should create a new session for new users', async () => {
    const auth = { username: tempAdminName, password: 'spacesareaproblem' };
    await utils.createAdmin(auth.username, auth.password);
    await utils.createDb(tempDbName);

    tempDb = getDb(tempDbName, auth, authType);

    const collectLogs = await utils.getDockerContainerLogs();
    await db.allDocs();
    await tempDb.allDocs();

    const logs = await collectLogs(100);

    console.log(logs);

    expect(utils.getDbRequest(auth.username, logs, tempDbName, '/_all_docs').length).to.equal(1);
    expect(utils.getSessionRequests(logs).length).to.equal(1);
    expect(utils.getCookieAuthRequests(auth.username, logs).length).to.equal(1);
  });

  it('should throw errors on password changes', async () => {
    const auth = { username: tempAdminName, password: 'new_password' };
    await utils.createAdmin(auth.username, auth.password);
    await utils.createDb(tempDbName);

    tempDb = getDb(tempDbName, auth, authType);

    const collectLogs = await utils.getDockerContainerLogs();
    await tempDb.allDocs();
    await utils.createAdmin(auth.username, 'password change');
    await expect(tempDb.allDocs()).to.eventually.be.rejectedWith(wrongAuthError);
    const logs = await collectLogs();

    console.log(logs);

    expect(utils.getSessionRequests(logs, false).length).to.equal(1);
    expect(utils.getDbRequest('undefined', logs, tempDbName, '/_all_docs', false).length).to.equal(2);
  });

  it('should throw errors on invalid credentials', async () => {
    const newDb = getDb(dbName, { username: utils.dbAuth.username, password: 'wrong password' }, authType);

    const collectLogs = await utils.getDockerContainerLogs();
    await expect(newDb.allDocs()).to.eventually.be.rejectedWith(wrongAuthError);
    const logs = await collectLogs();
    expect(utils.getSessionRequests(logs, false).length).to.equal(1);
  });

  it('should automatically refresh the cookie when closing to expiry', async () => {
    await utils.asyncTimeout(3000);
    await db.allDocs();
    await utils.asyncTimeout(3000);
    await db.allDocs();
  });

  it('should automatically refresh the cookie when expired', async () => {
    const collectLogs = await utils.getDockerContainerLogs();
    await utils.asyncTimeout(6000);
    await db.allDocs();
    const logs = await collectLogs(1000);
    expect(utils.getSessionRequests(logs).length).to.equal(1);
  });

  it('should support initial setup', async () => {
    const auth = { username: tempAdminName, password: 'new_password' };
    await utils.createAdmin(auth.username, auth.password);

    const collectLogs = await utils.getDockerContainerLogs();
    tempDb = getDb(tempDbName, auth, authType, false);
    await tempDb.allDocs();
    const logs = await collectLogs(1000);
    expect(utils.getSessionRequests(logs).length).to.equal(1);
  });

  it('should only request session once for concurrent requests', async () => {
    const auth = { username: tempAdminName, password: 'new_password' };
    await utils.createAdmin(auth.username, auth.password);
    await utils.createDb(tempDbName);

    tempDb = getDb(tempDbName, auth, authType);
    const collectLogs = await utils.getDockerContainerLogs();
    await Promise.all([
      tempDb.allDocs(),
      tempDb.allDocs(),
      tempDb.allDocs(),
      tempDb.allDocs(),
      tempDb.allDocs(),
    ]);

    const logs = await collectLogs();
    expect(utils.getSessionRequests(logs).length).to.equal(1);
  });
});

