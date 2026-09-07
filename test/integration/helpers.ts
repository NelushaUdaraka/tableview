/**
 * Shared setup for integration tests that run against a real SQL Server.
 *
 * Start one with:
 *   docker run -d --name beekeeper-mssql -e ACCEPT_EULA=Y \
 *     -e 'MSSQL_SA_PASSWORD=Beekeeper#2024!' -p 11433:1433 \
 *     mcr.microsoft.com/mssql/server:2022-latest
 */
import {
  ConnectionConfig,
  DEFAULT_SQLSERVER_OPTIONS,
  DEFAULT_SSH_CONFIG,
  DEFAULT_SSM_CONFIG
} from '../../src/shared/types'
import { SqlServerClient } from '../../src/main/db/sqlserver/client'

export const TEST_HOST = process.env.MSSQL_TEST_HOST ?? '127.0.0.1'
export const TEST_PORT = Number(process.env.MSSQL_TEST_PORT ?? 11433)
export const TEST_USER = process.env.MSSQL_TEST_USER ?? 'sa'
export const TEST_PASSWORD = process.env.MSSQL_TEST_PASSWORD ?? 'Beekeeper#2024!'
export const TEST_DATABASE = process.env.MSSQL_TEST_DATABASE ?? 'beekeeper_test'

export function makeConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  const now = new Date().toISOString()
  return {
    id: 'test-connection',
    name: 'Integration test',
    engine: 'sqlserver',
    host: TEST_HOST,
    port: TEST_PORT,
    database: TEST_DATABASE,
    authType: 'sql',
    username: TEST_USER,
    password: TEST_PASSWORD,
    savePassword: false,
    options: {
      ...DEFAULT_SQLSERVER_OPTIONS,
      encrypt: true,
      trustServerCertificate: true,
      connectTimeoutMs: 30000,
      requestTimeoutMs: 60000
    },
    ssh: { ...DEFAULT_SSH_CONFIG },
    ssm: { ...DEFAULT_SSM_CONFIG },
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

/** DDL + data covering the type and constraint surface the app introspects. */
export const SEED_SQL = `
IF OBJECT_ID('sales.order_items', 'U') IS NOT NULL DROP TABLE sales.order_items;
IF OBJECT_ID('sales.orders', 'U') IS NOT NULL DROP TABLE sales.orders;
IF OBJECT_ID('dbo.wide_types', 'U') IS NOT NULL DROP TABLE dbo.wide_types;
IF OBJECT_ID('dbo.customers', 'U') IS NOT NULL DROP TABLE dbo.customers;
IF OBJECT_ID('dbo.no_pk', 'U') IS NOT NULL DROP TABLE dbo.no_pk;
IF OBJECT_ID('[odd name].[weird ]] table]', 'U') IS NOT NULL DROP TABLE [odd name].[weird ]] table];
IF OBJECT_ID('dbo.customer_summary', 'V') IS NOT NULL DROP VIEW dbo.customer_summary;
GO

IF SCHEMA_ID('sales') IS NULL EXEC('CREATE SCHEMA sales');
IF SCHEMA_ID('odd name') IS NULL EXEC('CREATE SCHEMA [odd name]');
GO

CREATE TABLE dbo.customers (
  customer_id   int IDENTITY(1,1) NOT NULL,
  email         nvarchar(255)     NOT NULL,
  display_name  nvarchar(100)     NULL,
  credit_limit  decimal(18,2)     NOT NULL CONSTRAINT DF_customers_credit DEFAULT (0),
  is_active     bit               NOT NULL DEFAULT (1),
  created_at    datetime2(3)      NOT NULL DEFAULT (SYSUTCDATETIME()),
  notes         nvarchar(max)     NULL,
  CONSTRAINT PK_customers PRIMARY KEY CLUSTERED (customer_id),
  CONSTRAINT UQ_customers_email UNIQUE (email),
  CONSTRAINT CK_customers_credit CHECK (credit_limit >= 0)
);
GO

CREATE INDEX IX_customers_name ON dbo.customers (display_name DESC) INCLUDE (email) WHERE is_active = 1;
GO

CREATE TABLE sales.orders (
  order_id     int IDENTITY(100,5) NOT NULL,
  customer_id  int NOT NULL,
  placed_on    date NOT NULL,
  total        money NOT NULL DEFAULT (0),
  status       varchar(20) NOT NULL DEFAULT ('new'),
  CONSTRAINT PK_orders PRIMARY KEY (order_id),
  CONSTRAINT FK_orders_customers FOREIGN KEY (customer_id)
    REFERENCES dbo.customers (customer_id) ON DELETE CASCADE
);
GO

CREATE TABLE sales.order_items (
  order_id  int NOT NULL,
  line_no   int NOT NULL,
  sku       varchar(40) NOT NULL,
  qty       int NOT NULL,
  CONSTRAINT PK_order_items PRIMARY KEY (order_id, line_no),
  CONSTRAINT FK_items_orders FOREIGN KEY (order_id)
    REFERENCES sales.orders (order_id) ON DELETE CASCADE
);
GO

CREATE TABLE dbo.wide_types (
  id                int IDENTITY(1,1) PRIMARY KEY,
  c_bigint          bigint NULL,
  c_smallint        smallint NULL,
  c_tinyint         tinyint NULL,
  c_bit             bit NULL,
  c_decimal         decimal(18,4) NULL,
  c_float           float NULL,
  c_real            real NULL,
  c_money           money NULL,
  c_date            date NULL,
  c_time            time(3) NULL,
  c_datetime        datetime NULL,
  c_datetime2       datetime2(7) NULL,
  c_datetimeoffset  datetimeoffset(3) NULL,
  c_char            char(5) NULL,
  c_varchar         varchar(50) NULL,
  c_varchar_max     varchar(max) NULL,
  c_nchar           nchar(5) NULL,
  c_nvarchar        nvarchar(50) NULL,
  c_nvarchar_max    nvarchar(max) NULL,
  c_binary          binary(4) NULL,
  c_varbinary       varbinary(50) NULL,
  c_varbinary_max   varbinary(max) NULL,
  c_uniqueidentifier uniqueidentifier NULL,
  c_xml             xml NULL,
  c_computed        AS (c_bigint * 2),
  c_rowversion      rowversion NOT NULL
);
GO

CREATE TABLE dbo.no_pk (
  a int NULL,
  b nvarchar(50) NULL
);
GO

CREATE TABLE [odd name].[weird ]] table] (
  [id ]] col] int NOT NULL PRIMARY KEY,
  [value's] nvarchar(50) NULL
);
GO

CREATE VIEW dbo.customer_summary AS
  SELECT c.customer_id, c.email, COUNT(o.order_id) AS order_count
  FROM dbo.customers c
  LEFT JOIN sales.orders o ON o.customer_id = c.customer_id
  GROUP BY c.customer_id, c.email;
GO

CREATE TRIGGER dbo.trg_customers_audit ON dbo.customers AFTER INSERT, UPDATE
AS BEGIN SET NOCOUNT ON; END;
GO

INSERT INTO dbo.customers (email, display_name, credit_limit, is_active, notes) VALUES
  (N'ada@example.com',   N'Ada Lovelace',   1500.00, 1, N'first'),
  (N'alan@example.com',  N'Alan Turing',     250.50, 1, NULL),
  (N'grace@example.com', N'Grace Hopper',      0.00, 0, N'line1
line2'),
  (N'quote@example.com', N'O''Brien, "Q"',   99.99, 1, N'comma, and "quotes"');
GO

INSERT INTO sales.orders (customer_id, placed_on, total, status) VALUES
  (1, '2024-01-15', 120.00, 'shipped'),
  (1, '2024-02-20', 300.25, 'new'),
  (2, '2024-03-01',  75.00, 'cancelled');
GO

INSERT INTO sales.order_items (order_id, line_no, sku, qty) VALUES
  (100, 1, 'SKU-1', 2),
  (100, 2, 'SKU-2', 1),
  (105, 1, 'SKU-3', 5);
GO

INSERT INTO dbo.wide_types (
  c_bigint, c_smallint, c_tinyint, c_bit, c_decimal, c_float, c_real, c_money,
  c_date, c_time, c_datetime, c_datetime2, c_datetimeoffset,
  c_char, c_varchar, c_varchar_max, c_nchar, c_nvarchar, c_nvarchar_max,
  c_binary, c_varbinary, c_varbinary_max, c_uniqueidentifier, c_xml
) VALUES (
  9007199254740993, 32767, 255, 1, 12345.6789, 3.5, 1.5, 99.99,
  '2024-06-01', '12:34:56.789', '2024-06-01T12:34:56', '2024-06-01T12:34:56.1234567',
  '2024-06-01T12:34:56.123+05:30',
  'abcde', 'varchar value', REPLICATE('x', 100), N'nchar', N'nvarchar ünïcodé', N'big text',
  0xDEADBEEF, 0x0102030405, 0xFFEE, '6F9619FF-8B86-D011-B42D-00C04FC964FF', '<root a="1"/>'
);
GO

INSERT INTO dbo.wide_types (c_bigint) VALUES (NULL);
GO

INSERT INTO dbo.no_pk (a, b) VALUES (1, N'one'), (2, N'two'), (2, N'two');
GO

INSERT INTO [odd name].[weird ]] table] ([id ]] col], [value's]) VALUES (1, N'ok');
GO
`

/** Creates the test database (idempotent) and returns a connected client. */
export async function createTestDatabase(): Promise<void> {
  const master = new SqlServerClient(makeConfig({ database: 'master' }))
  await master.connect()
  try {
    const results = await master.runScript(
      `IF DB_ID('${TEST_DATABASE}') IS NULL CREATE DATABASE [${TEST_DATABASE}];`
    )
    const failed = results.find((r) => r.error)
    if (failed) throw new Error(failed.error!.message)
  } finally {
    await master.disconnect()
  }
}

export async function seedTestDatabase(client: SqlServerClient): Promise<void> {
  const results = await client.runScript(SEED_SQL)
  const failed = results.find((result) => result.error)
  if (failed) {
    throw new Error(`Seed failed on statement:\n${failed.sql}\n\n${failed.error!.message}`)
  }
}

export async function connectedClient(
  overrides: Partial<ConnectionConfig> = {}
): Promise<SqlServerClient> {
  const client = new SqlServerClient(makeConfig(overrides))
  await client.connect()
  return client
}
