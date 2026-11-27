import { randomBytes } from 'node:crypto';
import { access, appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { availablePort, execute } from './index.mjs';

const stateVersion = 1;

export function databaseTool(resourcesPath, name) {
  return join(
    resolve(resourcesPath),
    'postgres',
    'bin',
    process.platform === 'win32' ? `${name}.exe` : name,
  );
}

function toolEnvironment() {
  if (process.platform !== 'win32') return { PATH: '/usr/bin:/bin', HOME: homedir() };
  const environment = Object.fromEntries(
    ['SYSTEMROOT', 'USERPROFILE', 'LOCALAPPDATA', 'TEMP', 'TMP'].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
  environment.PATH = join(environment.SYSTEMROOT || 'C:\\Windows', 'System32');
  return environment;
}

async function exists(path) {
  return access(path).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
}

async function writeState(path, state) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx', flush: true });
  await rename(temporary, path);
}

async function readState(path) {
  let state;
  try {
    state = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw Object.assign(new Error('Nod could not read its database settings.', { cause: error }), {
      code: 'NOD_DATABASE_STATE_INVALID',
    });
  }
  if (
    state?.version !== stateVersion ||
    !/^[a-f0-9]{64}$/.test(state.password) ||
    typeof state.ready !== 'boolean'
  )
    throw Object.assign(new Error('Nod’s database settings are invalid.'), {
      code: 'NOD_DATABASE_STATE_INVALID',
    });
  return state;
}

async function computerDatabaseExists(dataRoot) {
  try {
    const saved = JSON.parse(
      await readFile(join(dataRoot, 'desktop-runtime', 'state.json'), 'utf8'),
    );
    return saved?.initializing !== true;
  } catch (error) {
    return error.code !== 'ENOENT';
  }
}

async function logTail(path) {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.slice(-4000);
}

export async function openDatabase({ dataRoot, resourcesPath, signal }) {
  const root = join(resolve(dataRoot), 'database');
  const data = join(root, 'data');
  const log = join(root, 'postgres.log');
  const statePath = join(root, 'state.json');
  const env = toolEnvironment();
  const pgCtl = databaseTool(resourcesPath, 'pg_ctl');
  await mkdir(root, { recursive: true, mode: 0o700 });
  let state = await readState(statePath);
  if (!state) {
    state = {
      version: stateVersion,
      password: randomBytes(32).toString('hex'),
      ready: !(await computerDatabaseExists(dataRoot)),
    };
    await writeState(statePath, state);
  }
  if (!(await exists(join(data, 'PG_VERSION')))) {
    const temporary = `${data}.${randomBytes(6).toString('hex')}.tmp`;
    const passwordFile = `${statePath}.${randomBytes(6).toString('hex')}.password`;
    await writeFile(passwordFile, `${state.password}\n`, { mode: 0o600, flag: 'wx' });
    try {
      await execute(
        databaseTool(resourcesPath, 'initdb'),
        [
          '--pgdata',
          temporary,
          '--username',
          'nod',
          '--auth',
          'scram-sha-256',
          '--pwfile',
          passwordFile,
          '--encoding',
          'UTF8',
          '--no-locale',
          '--locale-provider',
          'builtin',
          '--builtin-locale',
          'C.UTF-8',
          '--no-instructions',
        ],
        { env, signal, timeout: 300_000 },
      );
      await appendFile(
        join(temporary, 'postgresql.conf'),
        "\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = ''\ntimezone = 'UTC'\nlog_timezone = 'UTC'\n",
      );
      await rm(data, { recursive: true, force: true });
      await rename(temporary, data);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      signal?.throwIfAborted();
      throw Object.assign(new Error('Nod could not create its database.', { cause }), {
        code: 'NOD_DATABASE_SETUP_FAILED',
        details: cause.details,
      });
    } finally {
      await rm(passwordFile, { force: true });
    }
  }
  if (await exists(join(data, 'postmaster.pid')))
    await execute(
      pgCtl,
      ['stop', '--pgdata', data, '--mode', 'fast', '--wait', '--timeout', '60'],
      {
        env,
        signal,
        timeout: 90_000,
      },
    ).catch(() => {});
  const port = await availablePort();
  await rm(log, { force: true });
  try {
    await execute(
      pgCtl,
      [
        'start',
        '--pgdata',
        data,
        '--log',
        log,
        '--wait',
        '--timeout',
        '120',
        '--options',
        `-p ${port}`,
      ],
      { env, signal, timeout: 150_000 },
    );
  } catch (cause) {
    signal?.throwIfAborted();
    throw Object.assign(new Error('Nod could not start its database.', { cause }), {
      code: 'NOD_DATABASE_START_FAILED',
      details: [cause.details, await logTail(log)].filter(Boolean).join('\n'),
    });
  }
  const close = () =>
    execute(pgCtl, ['stop', '--pgdata', data, '--mode', 'fast', '--wait', '--timeout', '60'], {
      env,
      timeout: 90_000,
    });
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    host: '127.0.0.1',
    port,
    user: 'nod',
    password: state.password,
    database: 'postgres',
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
    if (!(await client.query("SELECT 1 FROM pg_database WHERE datname='nod'")).rowCount)
      await client.query('CREATE DATABASE nod');
  } catch (cause) {
    await close().catch(() => {});
    throw Object.assign(new Error('Nod could not open its database.', { cause }), {
      code: 'NOD_DATABASE_CONNECTION_FAILED',
      details: [cause.stack || cause.message, await logTail(log)].filter(Boolean).join('\n'),
    });
  } finally {
    await client.end().catch(() => {});
  }
  return {
    url: `postgresql://nod:${state.password}@127.0.0.1:${port}/nod`,
    password: state.password,
    get pendingMove() {
      return !state.ready;
    },
    async moved() {
      state = { ...state, ready: true };
      await writeState(statePath, state);
    },
    close,
  };
}

const restrictLine = /^\\(?:un)?restrict [A-Za-z0-9]+$/gm;

export async function moveDatabase({ source, target, schema, signal }) {
  const { default: pg } = await import('pg');
  const { from: copyFrom, to: copyTo } = await import('pg-copy-streams');
  const [pre, post] = await Promise.all([schema('pre-data'), schema('post-data')]);
  const legacy = new pg.Client({ connectionString: source, connectionTimeoutMillis: 10_000 });
  const host = new pg.Client({ connectionString: target, connectionTimeoutMillis: 10_000 });
  await legacy.connect();
  try {
    await host.connect();
    try {
      await legacy.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await host.query('BEGIN');
      try {
        await host.query(pre.replace(restrictLine, ''));
        const tables = (
          await legacy.query(`
            SELECT format('%I.%I', n.nspname, c.relname) AS name,
              string_agg(format('%I', a.attname), ',' ORDER BY a.attnum) AS columns
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
              AND NOT a.attisdropped AND a.attgenerated = ''
            WHERE c.relkind = 'r'
              AND n.nspname NOT IN ('pg_catalog', 'information_schema')
              AND n.nspname NOT LIKE 'pg\\_%'
              AND NOT EXISTS (
                SELECT 1 FROM pg_depend d
                WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
              )
            GROUP BY 1 ORDER BY 1`)
        ).rows;
        for (const { name, columns } of tables) {
          signal?.throwIfAborted();
          await pipeline(
            legacy.query(copyTo(`COPY ${name} (${columns}) TO STDOUT (FORMAT binary)`)),
            host.query(copyFrom(`COPY ${name} (${columns}) FROM STDIN (FORMAT binary)`)),
            { signal },
          );
          const [copied, original] = await Promise.all([
            host.query(`SELECT count(*)::text AS count FROM ${name}`),
            legacy.query(`SELECT count(*)::text AS count FROM ${name}`),
          ]);
          if (copied.rows[0].count !== original.rows[0].count)
            throw new Error(
              `The copy of ${name} has ${copied.rows[0].count} rows instead of ${original.rows[0].count}.`,
            );
        }
        const sequences = (
          await legacy.query(`
            SELECT format('%I.%I', schemaname, sequencename) AS name, last_value::text AS value
            FROM pg_sequences
            WHERE last_value IS NOT NULL AND schemaname NOT IN ('pg_catalog', 'information_schema')`)
        ).rows;
        for (const { name, value } of sequences)
          await host.query('SELECT pg_catalog.setval($1::regclass, $2::bigint, true)', [
            name,
            value,
          ]);
        await host.query(post.replace(restrictLine, ''));
        await host.query('COMMIT');
      } catch (error) {
        await host.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        await legacy.query('ROLLBACK').catch(() => {});
      }
    } finally {
      await host.end().catch(() => {});
    }
  } finally {
    await legacy.end().catch(() => {});
  }
}
