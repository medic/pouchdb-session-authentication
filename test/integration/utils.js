const { fetch, Headers } = require('pouchdb-fetch');
const { spawn } = require('child_process');
const path = require('path');

const baseUrl = 'http://localhost:15984';
const auth = {
  username: 'admin',
  password: 'pass'
};

const dbAuth = {
  username: 'dbadmin',
  password: 'dbadminpassword',
};

const killSpawnedProcess = (proc) => {
  proc.stdout.destroy();
  proc.stderr.destroy();
  proc.kill('SIGINT');
};

const waitForDockerContainerLogs = (...regex) => {
  const params = 'logs --follow --tail=1 couchdb';
  const proc = spawn(
    'docker-compose',
    params.split(' '),
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.join(process.cwd(), 'test', 'integration'),
    }
  );
  let timeout;
  let logs = '';

  const promise = new Promise((resolve) => {
    timeout = setTimeout(() => {
      console.log('Found logs', logs, 'did not match expected regex:', ...regex);
      resolve();
      killSpawnedProcess(proc);
    }, 3000);

    const checkOutput = (data) => {
      data = data.toString();
      logs += data;
      const lines = data.split('\n').filter(line => line);
      if (lines.find(line => regex.find(r => r.test(line)))) {
        resolve();
        clearTimeout(timeout);
        killSpawnedProcess(proc);
      }
    };

    proc.stdout.on('data', checkOutput);
    proc.stderr.on('data', checkOutput);
  });

  return {
    promise,
    cancel: () => {
      clearTimeout(timeout);
      killSpawnedProcess(proc);
    }
  };
};

const getDockerContainerLogs = (...regex) => {
  const params = 'logs --follow --tail=1 couchdb';
  const proc = spawn(
    'docker-compose',
    params.split(' '),
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: __dirname
    }
  );
  let logs = '';
  const matches = [];
  const errors = [];

  // It takes a while until the process actually starts tailing logs, and initiating next test steps immediately
  // after watching results in a race condition, where the log is created before watching started.
  // As a fix, watch the logs with tail=1, so we always receive one log line immediately, then proceed with next
  // steps of testing afterward.
  let receivedFirstLine;
  const firstLineReceivedPromise = new Promise(resolve => receivedFirstLine = resolve);

  proc.stdout.on('data', (data) => {
    receivedFirstLine();
    data = data.toString();
    logs += data;
    const lines = data.split('\n').filter(line => line);
    if (regex.length) {
      lines.forEach(line => regex.forEach(r => r.test(line) && matches.push(line)));
    } else {
      matches.push(...lines);
    }
  });

  proc.stderr.on('err', err => {
    receivedFirstLine();
    errors.push(err.toString());
  });

  const collect = async (timeout = 100) => {
    // sometimes there's a small lag in stdio
    await asyncTimeout(timeout);
    killSpawnedProcess(proc);

    if (errors.length) {
      const error = new Error('CollectLogs errored');
      error.errors = errors;
      error.logs = logs;
      return Promise.reject(error);
    }

    return Promise.resolve(matches);
  };

  return firstLineReceivedPromise.then(() => collect);
};

const asyncTimeout = (duration) => new Promise(r => setTimeout(r, duration));

const getSessionRequests = (logs, success = true) => {
  const re = new RegExp(`POST /_session ${success ? '200' : '401'}`);
  return logs.filter(line => re.test(line));
};

const getCookieAuthRequests = (username, logs) => {
  const re = new RegExp(`Successful cookie auth as: "${username}"`);
  return logs.filter(line => re.test(line));
};

const getDbRequest = (username, logs, dbName, path, success = true, method = 'GET') => {
  const re = new RegExp(`${username} ${method} /${dbName}${path}.*${success ? '200' : '401'}`);
  return logs.filter(line => re.test(line));
};

const request = async (opts) => {
  const authString = `${auth.username}:${auth.password}`;
  const token = Buffer.from(decodeURIComponent(encodeURIComponent(authString))).toString('base64');

  const headers = new Headers({ 'Authorization': 'Basic ' + token });
  if (opts.json) {
    headers.set('Content-Type', 'application/json');
    headers.set('Accept', 'application/json');
    opts.body = JSON.stringify(opts.body);
  }

  const response = await fetch(opts.url, { headers, ...opts });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(`Error with request: ${JSON.stringify(body)}`);
    error.response = response;
    error.body = body;
    throw error;
  }
  return body;
};

const setConfig = async (section, config, value, remove = false) => {
  const url = `${baseUrl}/_node/_local/_config/${section}/${config}`;
  return await request({
    url,
    method: remove ? 'DELETE' : 'PUT',
    json: true,
    body: value
  });
};

const setIterations = (iterations) => setConfig('chttpd_auth', 'iterations', iterations);
const setAuthTimeout = (timeout) => setConfig('chttpd_auth', 'timeout', timeout);

const waitForCouchdb = async () => {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      console.log('waiting for CouchDb');
      return await request({ url: baseUrl });
    } catch (err) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
};

const createDb = (dbname) => request({ url: `${baseUrl}/${dbname}`, method: 'PUT' });
const deleteDb = async (dbname) => {
  try {
    await request({ url: `${baseUrl}/${dbname}`, method: 'DELETE' });
  } catch (err) {
    if (err.response.status === 404) {
      return;
    }
    throw err;
  }
};

const createDoc = (dbName, docId) => {
  return request({
    url: `${baseUrl}/${dbName}/${docId}`,
    body: { _id: docId },
    json: true,
    method: 'PUT',
  });
};
const getDoc = async (dbName, docId) => request({ url: `${baseUrl}/${dbName}/${docId}`, json: true });

const createAdmin = async (name, password) => {
  await setConfig('admins', name, password);
  await waitForDockerContainerLogs(new RegExp(`config: \\[admins\\] ${name}`)).promise;
};

const deleteAdmin = async (name) => {
  try {
    await setConfig('admins', name, '', true);
  } catch (err) {
    if (err.response.status === 404) {
      return;
    }
    throw err;
  }
};

const setupCouch = async (dbName) => {
  await waitForCouchdb();
  await createDb('_users');
  await createAdmin(dbAuth.username, dbAuth.password);

  await setIterations('50000');
  await setAuthTimeout('4');
  await setConfig('log', 'level', 'debug');
  await setConfig('chttpd', 'require_valid_user', 'true');
  await createDb(dbName);
};

module.exports = {
  dbAuth,
  baseUrl,
  setupCouch,
  setIterations,
  setAuthTimeout,
  createDb,
  deleteDb,
  createAdmin,
  deleteAdmin,
  getDockerContainerLogs,
  getSessionRequests,
  getCookieAuthRequests,
  getDbRequest,
  asyncTimeout,
  createDoc,
  getDoc,
};
