const PouchDb = require('pouchdb-core');
const utils = require('./utils');
PouchDb.plugin(require('pouchdb-adapter-http'));
PouchDb.plugin(require('../../src/index'));

const dbName = 'testdb';

(async () => {
  await utils.setupCouch(dbName);
  const db = new PouchDb(`${utils.baseUrl}/${dbName}`, { skip_setup: true, auth: utils.dbAuth });

  const docs = [{ _id: '1', e: 1 }, { _id: '2', e: 2 }];
  await db.bulkDocs(docs);
  const allDocs = await db.allDocs();
  if (allDocs.rows.length !== docs.length) {
    throw new Error('Invalid number of docs');
  }
})();

