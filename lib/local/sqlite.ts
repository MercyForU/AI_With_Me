/**
 * 手机版（APK）的本地 SQLite 连接。
 *
 * 为什么用 @capacitor-community/sqlite 而不是自己写文件：
 * 消息、记忆块会长期增长，SQLite 的索引和事务比「整包 JSON 读写」可靠得多，
 * 而且能和电脑端共用同一套表结构，将来做同步时字段不用再改一遍。
 */
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';

const DB_NAME = 'nuan';
const DB_VERSION = 1;

let conn: SQLiteDBConnection | null = null;
let opening: Promise<SQLiteDBConnection> | null = null;

async function open(): Promise<SQLiteDBConnection> {
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  // 热更新 / 页面重载后可能残留连接，先做一致性检查再决定新建还是复用
  try {
    await sqlite.checkConnectionsConsistency();
  } catch {
    /* 忽略：不同版本插件行为略有差异 */
  }
  let exists = false;
  try {
    exists = Boolean((await sqlite.isConnection(DB_NAME, false)).result);
  } catch {
    exists = false;
  }
  const c = exists
    ? await sqlite.retrieveConnection(DB_NAME, false)
    : await sqlite.createConnection(DB_NAME, false, 'no-encryption', DB_VERSION, false);
  await c.open();
  return c;
}

export async function db(): Promise<SQLiteDBConnection> {
  if (conn) return conn;
  if (!opening) {
    opening = open().then((c) => {
      conn = c;
      return c;
    });
  }
  return opening;
}

export async function exec(sql: string): Promise<void> {
  const c = await db();
  await c.execute(sql);
}

export async function run(
  sql: string,
  values: unknown[] = [],
): Promise<{ changes: number; lastId: number }> {
  const c = await db();
  const r = await c.run(sql, values as never[]);
  return { changes: r.changes?.changes ?? 0, lastId: r.changes?.lastId ?? 0 };
}

export async function all<T = Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const c = await db();
  const r = await c.query(sql, values as never[]);
  return (r.values ?? []) as T[];
}

export async function get<T = Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<T | null> {
  const rows = await all<T>(sql, values);
  return rows[0] ?? null;
}

export async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await all<{ name: string }>(`PRAGMA table_info(${table})`);
  return rows.some((r) => r.name === column);
}

export async function ensureColumn(table: string, column: string, ddl: string): Promise<void> {
  if (!(await columnExists(table, column))) {
    await exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
