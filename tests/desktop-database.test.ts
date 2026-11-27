import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';

const { moveDatabase } = (await import('../desktop/runtime/database.mjs' as string)) as {
  moveDatabase(options: {
    source: string;
    target: string;
    schema(section: string): Promise<string>;
    signal?: AbortSignal;
  }): Promise<void>;
};

const url = process.env.TEST_DATABASE_URL;

function databaseUrl(name: string) {
  const address = new URL(url!);
  address.pathname = `/${name}`;
  return address.toString();
}

const pre = `\\restrict synthetic
CREATE SCHEMA jobs;
CREATE TABLE public.threads (
  id bigint GENERATED ALWAYS AS IDENTITY,
  title text NOT NULL,
  meta jsonb,
  at timestamptz NOT NULL,
  raw bytea
);
CREATE TABLE jobs.queue (id serial, thread_id bigint NOT NULL, state text);
\\unrestrict synthetic`;
const post = `ALTER TABLE ONLY public.threads ADD CONSTRAINT threads_pkey PRIMARY KEY (id);
ALTER TABLE ONLY jobs.queue ADD CONSTRAINT queue_pkey PRIMARY KEY (id);
ALTER TABLE ONLY jobs.queue ADD CONSTRAINT queue_thread FOREIGN KEY (thread_id) REFERENCES public.threads(id);
CREATE INDEX threads_at ON public.threads (at);`;

const snapshot = `SELECT
  (SELECT md5(string_agg(concat_ws('|', id, title, meta::text, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'), encode(raw, 'hex')), ',' ORDER BY id)) FROM public.threads) AS threads,
  (SELECT md5(string_agg(concat_ws('|', id, thread_id, state), ',' ORDER BY id)) FROM jobs.queue) AS queue,
  (SELECT count(*)::int FROM pg_indexes WHERE indexname = 'threads_at') AS indexes`;

test(
  'moving the database copies every row, sequence and constraint, or nothing',
  { skip: !url },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const [source, target, busy] = ['from', 'to', 'busy'].map((name) => `move_${name}_${suffix}`);
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    for (const name of [source, target, busy]) await admin.query(`CREATE DATABASE ${name}`);
    const clients: pg.Client[] = [];
    const open = async (name: string) => {
      const client = new pg.Client({ connectionString: databaseUrl(name) });
      await client.connect();
      clients.push(client);
      return client;
    };
    t.after(async () => {
      await Promise.all(clients.map((client) => client.end()));
      for (const name of [source, target, busy])
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    });
    const original = await open(source);
    await original.query(pre.replace(/^\\(?:un)?restrict .+$/gm, ''));
    await original.query(post);
    for (let index = 0; index < 40; index++)
      await original.query(
        `INSERT INTO public.threads (title, meta, at, raw)
         VALUES ($1, $2, '2026-11-27T09:00:00Z'::timestamptz + make_interval(secs => $3), $4)`,
        [
          `Synthetic thread ${index}\nwith ünïcödé, a tab\tand a \\ backslash`,
          { index, nested: { list: [index, null, 'x'] } },
          index * 1.234567,
          Buffer.from([0, index, 255, 0]),
        ],
      );
    await original.query(
      'INSERT INTO jobs.queue (thread_id, state) SELECT id, $1 FROM public.threads WHERE id % 3 = 0',
      ['queued'],
    );
    const expected = (await original.query(snapshot)).rows[0];
    const schema = async (section: string) => (section === 'pre-data' ? pre : post);

    await moveDatabase({ source: databaseUrl(source), target: databaseUrl(target), schema });

    const moved = await open(target);
    assert.deepEqual((await moved.query(snapshot)).rows[0], expected);
    assert.equal(
      (
        await moved.query(
          "INSERT INTO public.threads (title, at) VALUES ('next', now()) RETURNING id::int",
        )
      ).rows[0].id,
      41,
    );
    assert.equal(
      (await moved.query('INSERT INTO jobs.queue (thread_id) VALUES (1) RETURNING id')).rows[0].id,
      14,
    );
    await assert.rejects(
      moved.query('INSERT INTO jobs.queue (thread_id) VALUES (999)'),
      /queue_thread/,
    );

    const occupied = await open(busy);
    await occupied.query('CREATE TABLE public.threads (id bigint)');
    await assert.rejects(
      moveDatabase({ source: databaseUrl(source), target: databaseUrl(busy), schema }),
      /already exists/,
    );
    assert.deepEqual(
      (
        await occupied.query(
          "SELECT nspname FROM pg_namespace WHERE nspname = 'jobs' UNION ALL SELECT relname FROM pg_class WHERE relname = 'queue'",
        )
      ).rows,
      [],
    );
  },
);
