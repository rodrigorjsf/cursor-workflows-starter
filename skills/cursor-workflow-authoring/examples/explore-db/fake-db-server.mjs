import { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MAX_ROWS = 100;

const database = new DatabaseSync(":memory:");
database.exec(`
  CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    city TEXT,
    country TEXT
  );
  CREATE INDEX idx_customers_email ON customers (email);
  CREATE TABLE Orders (
    OrderID INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers (id),
    customer_city TEXT,
    total_cents INTEGER NOT NULL,
    placedAt TEXT NOT NULL
  );
  CREATE TABLE order_items (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES Orders (OrderID),
    sku TEXT NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price_cents INTEGER NOT NULL
  );
  INSERT INTO customers (name, email, city, country) VALUES
    ('Ada Lovelace', 'ada@example.com', 'London', 'UK'),
    ('Grace Hopper', 'grace@example.com', 'New York', 'US');
  INSERT INTO Orders (customer_id, customer_city, total_cents, placedAt) VALUES
    (1, 'London', 4200, '2026-01-04'),
    (2, 'New York', 1800, '2026-01-05'),
    (1, 'London', 900, '2026-01-09');
  INSERT INTO order_items (order_id, sku, product_name, quantity, unit_price_cents) VALUES
    (1, 'BK-1', 'Analytical Engine Manual', 1, 4200),
    (2, 'BK-2', 'Compiler Handbook', 2, 900),
    (3, 'BK-2', 'Compiler Handbook', 1, 900);
`);

const server = new McpServer({ name: "fake-db", version: "1" }, { capabilities: { tools: {} } });
const answer = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const failure = (message) => ({ isError: true, content: [{ type: "text", text: message }] });
const tableNames = () =>
  database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
const quoted = (identifier) => `"${identifier.replaceAll('"', '""')}"`;

server.registerTool("list_tables", { description: "Lists the tables of the database, by name.", inputSchema: z.strictObject({}) }, async () => answer(tableNames()));

server.registerTool(
  "describe_table",
  { description: "Describes the columns, indexes and foreign keys of one table.", inputSchema: z.strictObject({ table: z.string() }) },
  async ({ table }) => {
    if (!tableNames().includes(table)) return failure(`no such table: ${table}`);
    const columns = database.prepare(`PRAGMA table_info(${quoted(table)})`).all().map((column) => ({
      name: column.name,
      type: column.type,
      notNull: column.notnull === 1,
      primaryKey: column.pk > 0,
    }));
    const indexes = database.prepare(`PRAGMA index_list(${quoted(table)})`).all().map((index) => ({
      name: index.name,
      unique: index.unique === 1,
      columns: database.prepare(`PRAGMA index_info(${quoted(index.name)})`).all().map((part) => part.name),
    }));
    const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${quoted(table)})`).all().map((key) => ({ from: key.from, table: key.table, to: key.to }));
    return answer({ table, columns, indexes, foreignKeys });
  },
);

server.registerTool(
  "query",
  { description: "Runs one read-only SELECT statement and answers with its columns and at most 100 rows.", inputSchema: z.strictObject({ sql: z.string() }) },
  async ({ sql }) => {
    const statement = sql.trim().replace(/;$/, "");
    if (!/^select\s/i.test(statement) || statement.includes(";")) return failure("only one SELECT statement is allowed");
    try {
      const rows = database.prepare(statement).all();
      return answer({ rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS });
    } catch (error) {
      return failure(error.message);
    }
  },
);

await server.connect(new StdioServerTransport());
