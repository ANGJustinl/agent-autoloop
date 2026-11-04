// The hub on this machine: its database, the view kept from the log, the rules file, and one way to apply an input.
// Importing this opens them all, which is why the checks that must survive a bad rules file import it late.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { HOME, RULES_FILE } from "./home.ts";
import { credential, digest, whose as keyHolder } from "../kernel/credentials.ts";
import { decide } from "../kernel/decide.ts";
import { AuthError, NotFound } from "../kernel/errors.ts";
import { evolve, rows, keyOf, statement, type Fact, type Row, type Table } from "../kernel/evolve.ts";
import * as query from "../kernel/query.ts";
import { eventRule, typeMatches } from "../kernel/rules.ts";
import { stateOf as state } from "../kernel/state.ts";
import { commitLatest, openView } from "../kernel/store.ts";
import type { Job } from "../protocol/job.ts";
import { parseRules as checkRules, RulesError } from "../protocol/rules.ts";
import type { Rejected } from "../protocol/validate.ts";

mkdirSync(HOME, { recursive: true, mode: 0o700 });
chmodSync(HOME, 0o700);
const masterKeyFile = join(HOME, "master.key");
if (!existsSync(masterKeyFile)) {
  writeFileSync(masterKeyFile, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
}
const masterKey = readFileSync(masterKeyFile, "utf8").trim();
// An empty or cut-short key would still sign links, and card links derive from what channels see. Replacing it would
// void every link and token, so that is left to the owner.
if (!/^[A-Za-z0-9_-]{43}$/.test(masterKey)) {
  throw new Error(
    `${masterKeyFile} 坏了（应该是 43 个字符），中台不启动。从备份恢复这个文件；没有备份就删掉它，` +
      "重启会生成新的，但已经发出的卡片链接和正在跑的轮次会失效。",
  );
}
export const environment = {
  secret: masterKey,
  publicUrl: process.env.AGENT_AUTOLOOP_PUBLIC_URL ?? "",
};

export const db = new DatabaseSync(join(HOME, "hub.db"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get()) {
  throw new Error("这是旧版数据库；本轮未提供导入工具，请使用新的 AGENT_AUTOLOOP_HOME");
}
db.exec(`
  CREATE TABLE IF NOT EXISTS facts(seq INTEGER PRIMARY KEY, fact TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS projections(collection TEXT, key TEXT, data TEXT NOT NULL, PRIMARY KEY(collection, key));
`);
db.function("card_token", { deterministic: true }, (id, at) => credential(environment, "card", id, at));
db.function("card_hash", { deterministic: true }, (id, at) => digest(credential(environment, "card", id, at)));

const schema = readFileSync(new URL("../kernel/schema.sql", import.meta.url), "utf8");
const views: string[] = [];
for (const [, table, body] of schema.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
  const columns = [...body.matchAll(/^  (\w+) (?:INTEGER|TEXT)/gm)].map(([, column]) => column);
  const selected = columns.map((column) =>
    column === "token"
      ? "card_token(json_extract(data,'$.id'),json_extract(data,'$.created_at')) AS token"
      : `json_extract(data,'$.${column}') AS ${column}`,
  );
  views.push(
    `DROP VIEW IF EXISTS ${table}; CREATE VIEW ${table} AS SELECT ${selected.join(",")} FROM projections WHERE collection='${table}'`,
  );
}

// Other processes must see either the old views or the new ones, never the gap between DROP and CREATE.
db.exec(`BEGIN IMMEDIATE; ${views.join(";")}; COMMIT`);

// The persisted projection is expendable; the log alone rebuilds it.
const format = digest(
  ["../kernel/evolve.ts", "../kernel/schema.sql", "../kernel/credentials.ts", "./runtime.ts"]
    .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
    .join("\n") + digest(environment.secret),
);
let current = openView(db, format);
db.exec(
  "CREATE INDEX IF NOT EXISTS projection_card_hash ON projections(card_hash(json_extract(data,'$.id'),json_extract(data,'$.created_at'))) WHERE collection='cards'",
);

export const all = <T>(sql: string, params: SQLInputValue[] = []) =>
  db
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row }) as T);

export const one = <T>(sql: string, params: SQLInputValue[] = []) => {
  const row = db.prepare(sql).get(...params);
  return row ? ({ ...row } as T) : undefined;
};

export function getView() {
  current = openView(db, format);
  return current;
}

type Listener = (type: string, facts: Fact[]) => void;
const listeners = new Set<Listener>();

export const onChange = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function execute(type: string, args: any[], now = Date.now()) {
  let facts: Fact[] = [];
  let value: any;
  current = commitLatest(db, format, (latest) => {
    ({ facts, value } = decide(latest, { type, args }, now, environment));
    return facts;
  });
  if (facts.length) for (const listener of listeners) listener(type, facts);
  return value;
}

export const parseRules = (json: string, now = Date.now()) =>
  checkRules(json, now, Intl.DateTimeFormat().resolvedOptions().timeZone);
export { RulesError, typeMatches };
export let rules = query.configuration(current);
let loaded = { file: "", mtime: 0 };

export function reloadRules(file = RULES_FILE) {
  let mtime: number;
  let text: string;
  try {
    mtime = statSync(file).mtimeMs;
    if (loaded.file === file && loaded.mtime === mtime) return { changed: false };
    text = readFileSync(file, "utf8");
  } catch (error) {
    // Forget the last read: a file moved back keeps its old mtime and must still be read again.
    loaded = { file: "", mtime: 0 };
    return { changed: false, problem: unreadable(file, error as NodeJS.ErrnoException) };
  }
  loaded = { file, mtime };
  try {
    const next = parseRules(text);
    const differs = JSON.stringify(next) !== JSON.stringify(query.configuration(getView()));
    const reportedBroken = (card: Row) => card.key.startsWith("rules:") && card.state === "open";
    if (differs || rows(current, "cards", { state: "open" }).some(reportedBroken)) execute("rules", [next]);
    rules = next;
    return { changed: true };
  } catch (error) {
    if (error instanceof RulesError) return { changed: false, problem: error.message };
    throw error;
  }
}

function unreadable(file: string, error: NodeJS.ErrnoException) {
  if (error.code === "ENOENT") return `找不到 ${file}，被删掉或移走了？放回去就会接着用`;
  if (error.code === "EACCES" || error.code === "EPERM") return `没有权限读 ${file}，改回能读的权限就会接着用`;
  return `读不到 ${file}：${error.code ?? error.message}`;
}

const initial = reloadRules();
if (!rules) throw new Error(initial.problem ?? "缺少规则");

export const ruleNamed = (name: string) => rules.rules.find((rule) => rule.name === name);
export const rulesFor = (source: string, type: string) =>
  rules.rules.filter((rule) => eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, type));
export const workers = () => [...new Set(Object.values(rules.agents).map((agent) => agent.worker))];
export const agentsOf = (worker: string) => query.agentsOf(getView(), worker);
export const limitOf = (group: string) => rules.rules.find((rule) => rule.group === group)?.parallel ?? 1;

type EventAck = { event: number; duplicate: boolean; routed: string[] };
export const ingest = (source: string, input: unknown, now = Date.now()): EventAck =>
  execute("ingest", [source, input], now);
export const claimNext = (worker: string, claim: string, now = Date.now()): Job | null =>
  execute("claimNext", [worker, claim], now);
export const heartbeat = (worker: string, running: number[], now = Date.now()) =>
  execute("heartbeat", [worker, running], now);
export const started = (run: number, token: string, input: unknown, now = Date.now()) =>
  execute("started", [run, token, input], now);
type ReceiptAck = { rejected: Rejected[]; duplicate?: boolean };
export const finish = (run: number, token: string, input: unknown, now = Date.now()): ReceiptAck =>
  execute("finish", [run, token, input], now);
export const cancel = (run: number, now = Date.now()) => execute("cancel", [run], now);
export const cancels = (worker: string) => query.cancels(getView(), worker);
export const sweep = (now = Date.now()) => execute("sweep", [], now);

export function tick(now = Date.now()) {
  const { problem } = reloadRules();
  if (problem) execute("rulesError", [problem], now);
  execute("tick", [], now);
}

export const createCard = (spec: Row, now = Date.now()) => execute("createCard", [spec], now);
type CardAck = { card: number; duplicate: boolean };
export const tell = (key: string, title: string, text: string, now = Date.now()): CardAck =>
  execute("tell", [key, title, text], now);
export type Answer = { choice?: number; text?: string; by?: string; channel?: string; ref?: string };
export const answer = (id: number, given: Answer, now = Date.now()): { changed: boolean; state: string } =>
  execute("answer", [id, given], now);
export const resolve = (id: number, reason: string, by: string, now = Date.now()): boolean =>
  execute("resolve", [id, reason, by], now);
export const nextCard = (channel: string, now = Date.now()): ReturnType<typeof query.cardView> | null =>
  execute("nextCard", [channel], now);
export const delivered = (channel: string, id: number, version: number, ref: string | null, now = Date.now()) =>
  execute("delivered", [channel, id, version, ref], now);
export const failed = (channel: string, id: number, version: number, error: string, now = Date.now()) =>
  execute("failed", [channel, id, version, error], now);

export function cardByToken(token: string) {
  const row = statement(
    db,
    "SELECT data FROM projections WHERE collection='cards' AND card_hash(json_extract(data,'$.id'),json_extract(data,'$.created_at'))=?",
  ).get(digest(token));
  return row ? (JSON.parse(String(row.data)) as Row) : undefined;
}

export function cardAtLink(token: string) {
  const card = cardByToken(token);
  if (!card || !Object.values(rules.channels).some((channel) => channel.links)) throw new NotFound("没有这张卡片");
  return card;
}

export function answerByLink(token: string, given: Answer, now = Date.now()) {
  const card = cardAtLink(token);
  if (now - Date.parse(card.created_at) > 7 * 86400_000) {
    throw new AuthError(`这个链接过期了。在装它的电脑上运行 agent-autoloop answer ${card.id} 回答`);
  }
  return answer(card.id, { ...given, by: "链接" }, now);
}

export const view = (card: Row, ref: string | null = null, links = false) =>
  query.cardView(card, environment, ref, links);
export const unrouted = (limit = 20) => query.unrouted(getView(), limit);
export function stateOf(now = Date.now(), before?: number) {
  // A CLI may commit between these queries. The cursor and every returned row must share the same WAL snapshot.
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN");
  try {
    const snapshot = getView();
    const result = {
      ...state(now, before, query.configuration(snapshot), { all, view, unrouted }),
      cursor: snapshot.seq,
    };
    if (ownsTransaction) db.exec("COMMIT");
    return result;
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export type KeyKind = "source" | "worker" | "channel" | "owner";
export const keepKeyHash = (kind: KeyKind, name: string, hash: string, now = Date.now()) =>
  execute("key", [kind, name, hash], now);

export function addKey(kind: KeyKind, name: string, now = Date.now()) {
  const key = randomBytes(32).toString("base64url");
  keepKeyHash(kind, name, digest(key), now);
  return key;
}

export const removeKey = (kind: KeyKind, name: string) => execute("removeKey", [kind, name]) as boolean;
export const listKeys = () =>
  all<{ kind: string; name: string; created_at: string }>("SELECT kind,name,created_at FROM keys ORDER BY kind,name");
export const whose = (kind: string, key: string) => keyHolder(getView(), kind, key);
export const logAfter = (after = 0, limit = -1) =>
  db
    .prepare("SELECT fact FROM facts WHERE seq > ? ORDER BY seq LIMIT ?")
    .all(after, limit)
    .map((row) => query.safeFact(JSON.parse(String(row.fact))));

/** The part of the log that explains one run: its events, cards and receipts, and the rules it ran under. */
export function why(id: number) {
  const latest = getView();
  if (!latest.get("runs", id)) throw new NotFound("没有这一轮");
  const events = query.eventsOf(latest, id).map((event) => event.id);
  const cards = [...rows(latest, "cards", { run_id: id }), ...rows(latest, "cards", { answer_event: events })];
  const sequences = new Set<number>();
  const include = (table: Table, key: string | number) => {
    for (const row of statement(db, "SELECT seq FROM projection_refs WHERE collection=? AND key=?").all(
      table,
      String(key),
    ))
      sequences.add(Number(row.seq));
  };
  include("runs", id);
  const read = (seq: number): Fact =>
    JSON.parse(String(statement(db, "SELECT fact FROM facts WHERE seq=?").get(seq)!.fact));
  for (const seq of [...sequences])
    for (const change of read(seq).changes)
      if (change.table === "runs" && change.key === String(id) && change.row?.rules_version)
        sequences.add(change.row.rules_version);
  for (const event of events) include("events", event);
  for (const card of cards) include("cards", card.id);
  return [...sequences].sort((a, b) => a - b).map((seq) => query.safeFact(read(seq)));
}

// Test fixtures use this to discard rows without changing the behavioral assertions inherited from the SQL kernel.
export function fixtureClear(table: Table) {
  const latest = getView();
  const changes = rows(latest, table)
    .map((row) => keyOf(table, row))
    .map((key) => ({ table, key, row: null }));
  current = evolve(latest, [{ version: 1, seq: latest.seq, at: 0, type: "fixture", changes }], db);
}
