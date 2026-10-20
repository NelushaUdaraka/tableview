/**
 * The database the README's recordings are made against: a small, made-up
 * coffee roaster. Enough rows to sort and page through, data that reads like a
 * real shop's, and the same every run (the randomness is seeded), so a new
 * recording only differs where the app does.
 */

import sql from 'mssql'

export const DEMO_DATABASE = 'acme_coffee'

/**
 * The login the production connection signs in with. It may read and write:
 * what refuses a write there is the connection being read-only in TableView,
 * not the server.
 */
export const APP_LOGIN = { user: 'app', password: 'Acme#Coffee2026' }

/** mulberry32: a tiny seeded generator, so every run makes the same rows. */
function seeded(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FIRST_NAMES = [
  'Amara', 'Ben', 'Chen', 'Dilani', 'Elena', 'Farah', 'Gabriel', 'Hana', 'Ivan', 'Jonas',
  'Kavya', 'Liam', 'Maya', 'Nikhil', 'Olivia', 'Pedro', 'Quinn', 'Ravi', 'Sofia', 'Tomás',
  'Uma', 'Viktor', 'Wen', 'Ximena', 'Yusuf', 'Zara', 'Aiko', 'Bruno', 'Chloé', 'Dmitri',
  'Emeka', 'Freya', 'Giulia', 'Hiroshi', 'Ingrid', 'Jamal', 'Kiri', 'Lucas', 'Mei', 'Noah',
  'Oskar', 'Priya', 'Rosa', 'Samir', 'Thandi', 'Ulla', 'Valentina', 'Will', 'Yara', 'Zoe',
  'Ashan', 'Nimali', 'Kasun', 'Tharushi', 'Mateo', 'Leila', 'Arjun', 'Sakura', 'Erik', 'Nadia'
]

const LAST_NAMES = [
  'Perera', 'Silva', 'Fernando', 'Jayasinghe', 'Smith', 'Müller', 'García', 'Rossi', 'Kim',
  'Nguyen', 'Okafor', 'Johansson', 'Novak', 'Kowalski', 'Haddad', 'Tanaka', 'Wright', 'Costa',
  'Dubois', 'Schmidt', 'Patel', 'Ivanova', 'Mendes', 'Lindqvist', 'Murphy', 'Bianchi', 'Sato',
  'Chowdhury', 'Adeyemi', 'Larsen', 'Moreau', 'Kaur', 'Brown', 'Álvarez', 'Wójcik', 'Yamamoto',
  'Hughes', 'Rahman', 'Bakker', 'Nielsen', 'Popescu', 'Santos', 'Weber', 'Ali', 'Reyes',
  'Wickramasinghe', 'Bandara', 'Dissanayake', 'Herrera', "O'Connor"
]

const CITIES = [
  ['Colombo', 'Sri Lanka'], ['Kandy', 'Sri Lanka'], ['Galle', 'Sri Lanka'],
  ['London', 'United Kingdom'], ['Manchester', 'United Kingdom'], ['Dublin', 'Ireland'],
  ['Berlin', 'Germany'], ['Munich', 'Germany'], ['Paris', 'France'], ['Lyon', 'France'],
  ['Amsterdam', 'Netherlands'], ['Stockholm', 'Sweden'], ['Oslo', 'Norway'], ['Madrid', 'Spain'],
  ['Lisbon', 'Portugal'], ['Milan', 'Italy'], ['Warsaw', 'Poland'], ['Toronto', 'Canada'],
  ['Vancouver', 'Canada'], ['Austin', 'United States'], ['Seattle', 'United States'],
  ['New York', 'United States'], ['Mexico City', 'Mexico'], ['São Paulo', 'Brazil'],
  ['Bogotá', 'Colombia'], ['Lagos', 'Nigeria'], ['Cape Town', 'South Africa'],
  ['Bengaluru', 'India'], ['Mumbai', 'India'], ['Singapore', 'Singapore'], ['Tokyo', 'Japan'],
  ['Seoul', 'South Korea'], ['Sydney', 'Australia'], ['Melbourne', 'Australia'],
  ['Auckland', 'New Zealand']
]

const CATEGORIES = [
  ['Coffee beans', 'Single-origin and blended whole beans, roasted weekly'],
  ['Tea', 'Loose-leaf black, green and herbal teas'],
  ['Brewing gear', 'Pour-over, French press and stovetop brewers'],
  ['Grinders', 'Hand and electric burr grinders'],
  ['Cups & mugs', 'Stoneware, glass and travel mugs'],
  ['Accessories', 'Filters, scales and cleaning supplies'],
  ['Gift sets', 'Boxes put together for giving']
]

const SUPPLIERS = [
  ['Highland Growers Co-op', 'Ethiopia', 'orders@highland-growers.example'],
  ['Cerrado Estates', 'Brazil', 'sales@cerrado-estates.example'],
  ['Huila Farmers Union', 'Colombia', 'export@huila-union.example'],
  ['Kandy Hills Tea', 'Sri Lanka', 'trade@kandyhills.example'],
  ['Uji Leaf Traders', 'Japan', 'info@uji-leaf.example'],
  ['Nordic Brewware', 'Sweden', 'b2b@nordicbrew.example'],
  ['Alpine Grind Works', 'Switzerland', 'dealers@alpinegrind.example'],
  ['Stoneware Studio', 'Portugal', 'hello@stoneware.example']
]

// sku, name, category, supplier, price, stock, discontinued, attributes
const PRODUCTS = [
  ['CB-ETH-250', 'Ethiopia Yirgacheffe 250 g', 1, 1, 14.5, 120, 0, { origin: 'Ethiopia', process: 'washed', roast: 'light', notes: ['jasmine', 'bergamot', 'honey'] }],
  ['CB-ETH-1K', 'Ethiopia Yirgacheffe 1 kg', 1, 1, 49, 18, 0, { origin: 'Ethiopia', process: 'washed', roast: 'light', notes: ['jasmine', 'bergamot', 'honey'] }],
  ['CB-COL-250', 'Colombia Huila 250 g', 1, 3, 12.9, 96, 0, { origin: 'Colombia', process: 'washed', roast: 'medium', notes: ['caramel', 'red apple'] }],
  ['CB-BRA-250', 'Brazil Cerrado 250 g', 1, 2, 11.5, 140, 0, { origin: 'Brazil', process: 'natural', roast: 'medium-dark', notes: ['cocoa', 'hazelnut'] }],
  ['CB-KEN-250', 'Kenya Nyeri AA 250 g', 1, 1, 16, 42, 0, { origin: 'Kenya', process: 'washed', roast: 'light', notes: ['blackcurrant', 'grapefruit'] }],
  ['CB-GUA-250', 'Guatemala Antigua 250 g', 1, 3, 13.5, 64, 0, { origin: 'Guatemala', process: 'washed', roast: 'medium', notes: ['milk chocolate', 'orange'] }],
  ['CB-HOU-250', 'House espresso blend 250 g', 1, 2, 11, 210, 0, { origin: 'Brazil, Colombia', process: 'mixed', roast: 'dark', notes: ['dark chocolate', 'molasses'] }],
  ['CB-HOU-1K', 'House espresso blend 1 kg', 1, 2, 38, 35, 0, { origin: 'Brazil, Colombia', process: 'mixed', roast: 'dark', notes: ['dark chocolate', 'molasses'] }],
  ['CB-DEC-250', 'Swiss water decaf 250 g', 1, 3, 13, 50, 0, { origin: 'Colombia', process: 'swiss water', roast: 'medium', notes: ['toffee', 'almond'] }],
  ['TE-CEY-100', 'Ceylon orange pekoe 100 g', 2, 4, 8.5, 88, 0, { origin: 'Sri Lanka', type: 'black', estate: 'Kandy Hills' }],
  ['TE-MAT-030', 'Ceremonial matcha 30 g', 2, 5, 24, 30, 0, { origin: 'Japan', type: 'green', grade: 'ceremonial' }],
  ['TE-SEN-100', 'Sencha 100 g', 2, 5, 11, 45, 0, { origin: 'Japan', type: 'green' }],
  ['TE-EAR-100', 'Earl grey 100 g', 2, 4, 9, 70, 0, { origin: 'Sri Lanka', type: 'black', flavour: 'bergamot' }],
  ['TE-CHA-100', 'Masala chai 100 g', 2, 4, 9.5, 58, 0, { origin: 'Sri Lanka', type: 'black', spices: ['cardamom', 'ginger', 'clove'] }],
  ['TE-CAM-050', 'Chamomile 50 g', 2, 4, 6.5, 40, 0, { type: 'herbal', caffeine: false }],
  ['BG-DRP-02', 'Pour-over dripper, size 02', 3, 6, 22, 60, 0, { material: 'ceramic', colour: 'white' }],
  ['BG-FRP-08', 'French press, 8 cup', 3, 6, 34, 28, 0, { material: 'glass', capacity_ml: 1000 }],
  ['BG-TRP-01', 'Travel press', 3, 6, 39, 22, 0, { material: 'polypropylene', capacity_ml: 250 }],
  ['BG-MOK-06', 'Stovetop espresso pot, 6 cup', 3, 6, 29, 19, 0, { material: 'aluminium', capacity_ml: 300 }],
  ['BG-KET-10', 'Gooseneck kettle, 1 L', 3, 6, 59, 15, 0, { material: 'stainless steel', capacity_ml: 1000, induction: true }],
  ['BG-CBR-15', 'Cold brew jar, 1.5 L', 3, 6, 27, 12, 1, { material: 'glass', capacity_ml: 1500 }],
  ['GR-HND-01', 'Hand burr grinder', 4, 7, 79, 25, 0, { burr: 'conical steel', settings: 40 }],
  ['GR-ELC-01', 'Electric burr grinder', 4, 7, 189, 9, 0, { burr: 'flat steel', settings: 55, watts: 150 }],
  ['CM-STO-35', 'Stoneware mug, 350 ml', 5, 8, 18, 75, 0, { colour: 'speckled sand', dishwasher_safe: true }],
  ['CM-GLS-20', 'Double-wall glass, 200 ml', 5, 6, 16, 54, 0, { material: 'borosilicate glass' }],
  ['CM-TRV-45', 'Insulated travel mug, 450 ml', 5, 6, 26, 48, 0, { material: 'stainless steel', keeps_hot_hours: 6 }],
  ['CM-ESP-02', 'Espresso cups, set of 2', 5, 8, 21, 33, 0, { colour: 'charcoal', capacity_ml: 80 }],
  ['AC-FLT-100', 'Paper filters 02, 100 pack', 6, 6, 6, 300, 0, { size: '02', bleached: false }],
  ['AC-SCL-01', 'Brew scale with timer', 6, 6, 45, 21, 0, { max_g: 2000, precision_g: 0.1 }],
  ['AC-CLN-01', 'Espresso machine cleaner', 6, 6, 12, 80, 0, { tablets: 60 }],
  ['AC-TMP-58', 'Tamper, 58 mm', 6, 7, 32, 17, 0, { diameter_mm: 58, base: 'flat' }],
  ['GS-ORI-03', 'Origins tasting set', 7, 1, 39, 26, 0, { contains: ['CB-ETH-250', 'CB-COL-250', 'CB-KEN-250'] }],
  ['GS-TEA-04', 'Tea discovery box', 7, 4, 29, 31, 0, { contains: ['TE-CEY-100', 'TE-SEN-100', 'TE-EAR-100', 'TE-CHA-100'] }],
  ['GS-BRW-01', 'Pour-over starter kit', 7, 6, 64, 0, 1, { contains: ['BG-DRP-02', 'AC-FLT-100', 'CB-ETH-250'] }]
]

const EMPLOYEES = [
  ['Nimal', 'Perera', 'Managing director', null, '2019-03-01'],
  ['Clara', 'Jensen', 'Head roaster', 1, '2019-05-13'],
  ['Kofi', 'Mensah', 'Roaster', 2, '2021-02-08'],
  ['Laura', 'Becker', 'Roaster', 2, '2023-09-18'],
  ['Hiro', 'Watanabe', 'Operations manager', 1, '2020-01-06'],
  ['Sara', 'Lindgren', 'Fulfilment lead', 5, '2020-06-22'],
  ['Mateus', 'Oliveira', 'Packer', 6, '2022-04-11'],
  ['Ananya', 'Rao', 'Packer', 6, '2024-01-15'],
  ['Tom', 'Fletcher', 'Customer service', 5, '2021-08-30'],
  ['Isuri', 'Gunawardena', 'Customer service', 5, '2025-02-03'],
  ['Marco', 'Ricci', 'Head of sales', 1, '2020-10-12'],
  ['Elif', 'Yilmaz', 'Wholesale accounts', 11, '2022-07-04'],
  ['Daniel', 'Okoro', 'Wholesale accounts', 11, '2024-05-20'],
  ['Grace', 'Tan', 'Finance', 1, '2021-11-01']
]

const quote = (value) =>
  value === null || value === undefined ? 'NULL' : `N'${String(value).replace(/'/g, "''")}'`

const ascii = (text) =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z]/g, '').toLowerCase()

const pad = (n) => String(n).padStart(2, '0')
const isoDate = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
const isoDateTime = (date) =>
  `${isoDate(date)}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`

/** INSERT statements for `rows`, a few hundred to a batch (SQL Server takes at most 1000). */
function inserts(table, columns, rows, { identity = false } = {}) {
  const batches = []
  for (let start = 0; start < rows.length; start += 400) {
    const values = rows.slice(start, start + 400).map((row) => `(${row.join(', ')})`)
    const insert = `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${values.join(',\n')};`
    batches.push(
      identity
        ? `SET IDENTITY_INSERT ${table} ON;\n${insert}\nSET IDENTITY_INSERT ${table} OFF;`
        : insert
    )
  }
  return batches
}

const SCHEMA = [
  `IF SCHEMA_ID('sales') IS NULL EXEC('CREATE SCHEMA sales');
IF SCHEMA_ID('hr') IS NULL EXEC('CREATE SCHEMA hr');`,

  `CREATE TABLE dbo.categories (
  category_id  int IDENTITY(1,1) NOT NULL CONSTRAINT PK_categories PRIMARY KEY,
  name         nvarchar(60)      NOT NULL CONSTRAINT UQ_categories_name UNIQUE,
  description  nvarchar(200)     NULL
);`,

  `CREATE TABLE dbo.suppliers (
  supplier_id    int IDENTITY(1,1) NOT NULL CONSTRAINT PK_suppliers PRIMARY KEY,
  name           nvarchar(100)     NOT NULL,
  country        nvarchar(60)      NOT NULL,
  contact_email  nvarchar(255)     NULL
);`,

  `CREATE TABLE dbo.products (
  product_id      int IDENTITY(1,1) NOT NULL CONSTRAINT PK_products PRIMARY KEY,
  sku             varchar(20)       NOT NULL CONSTRAINT UQ_products_sku UNIQUE,
  name            nvarchar(120)     NOT NULL,
  category_id     int               NOT NULL CONSTRAINT FK_products_categories REFERENCES dbo.categories (category_id),
  supplier_id     int               NOT NULL CONSTRAINT FK_products_suppliers REFERENCES dbo.suppliers (supplier_id),
  unit_price      decimal(10,2)     NOT NULL CONSTRAINT CK_products_price CHECK (unit_price >= 0),
  units_in_stock  int               NOT NULL CONSTRAINT DF_products_stock DEFAULT (0),
  discontinued    bit               NOT NULL CONSTRAINT DF_products_discontinued DEFAULT (0),
  attributes      nvarchar(max)     NULL CONSTRAINT CK_products_attributes CHECK (ISJSON(attributes) = 1)
);`,

  `CREATE TABLE dbo.customers (
  customer_id   int IDENTITY(1,1) NOT NULL CONSTRAINT PK_customers PRIMARY KEY,
  first_name    nvarchar(50)      NOT NULL,
  last_name     nvarchar(50)      NOT NULL,
  email         nvarchar(255)     NOT NULL CONSTRAINT UQ_customers_email UNIQUE,
  city          nvarchar(60)      NULL,
  country       nvarchar(60)      NULL,
  loyalty_tier  varchar(10)       NOT NULL CONSTRAINT DF_customers_tier DEFAULT ('bronze'),
  credit_limit  decimal(10,2)     NOT NULL CONSTRAINT DF_customers_credit DEFAULT (0),
  is_active     bit               NOT NULL CONSTRAINT DF_customers_active DEFAULT (1),
  created_at    datetime2(0)      NOT NULL CONSTRAINT DF_customers_created DEFAULT (SYSUTCDATETIME()),
  preferences   nvarchar(max)     NULL CONSTRAINT CK_customers_preferences CHECK (ISJSON(preferences) = 1)
);`,

  `CREATE INDEX IX_customers_name ON dbo.customers (last_name, first_name);`,

  `CREATE TABLE sales.orders (
  order_id     int IDENTITY(10001,1) NOT NULL CONSTRAINT PK_orders PRIMARY KEY,
  customer_id  int                   NOT NULL CONSTRAINT FK_orders_customers REFERENCES dbo.customers (customer_id),
  placed_at    datetime2(0)          NOT NULL,
  channel      varchar(10)           NOT NULL CONSTRAINT DF_orders_channel DEFAULT ('web'),
  status       varchar(12)           NOT NULL CONSTRAINT DF_orders_status DEFAULT ('new'),
  total        decimal(12,2)         NOT NULL CONSTRAINT DF_orders_total DEFAULT (0),
  shipped_on   date                  NULL,
  notes        nvarchar(400)         NULL
);`,

  `CREATE INDEX IX_orders_customer ON sales.orders (customer_id) INCLUDE (placed_at, total);`,

  `CREATE TABLE sales.order_items (
  order_id    int           NOT NULL CONSTRAINT FK_order_items_orders REFERENCES sales.orders (order_id) ON DELETE CASCADE,
  line_no     smallint      NOT NULL,
  product_id  int           NOT NULL CONSTRAINT FK_order_items_products REFERENCES dbo.products (product_id),
  quantity    int           NOT NULL CONSTRAINT CK_order_items_quantity CHECK (quantity > 0),
  unit_price  decimal(10,2) NOT NULL,
  discount    decimal(4,2)  NOT NULL CONSTRAINT DF_order_items_discount DEFAULT (0),
  CONSTRAINT PK_order_items PRIMARY KEY (order_id, line_no)
);`,

  `CREATE TABLE hr.employees (
  employee_id  int IDENTITY(1,1) NOT NULL CONSTRAINT PK_employees PRIMARY KEY,
  first_name   nvarchar(50)      NOT NULL,
  last_name    nvarchar(50)      NOT NULL,
  title        nvarchar(60)      NOT NULL,
  manager_id   int               NULL CONSTRAINT FK_employees_manager REFERENCES hr.employees (employee_id),
  hired_on     date              NOT NULL
);`
]

const ROUTINES = [
  `CREATE VIEW sales.monthly_revenue AS
SELECT
  DATEFROMPARTS(YEAR(placed_at), MONTH(placed_at), 1) AS month,
  COUNT(*)                                            AS orders,
  SUM(total)                                          AS revenue
FROM sales.orders
WHERE status NOT IN ('cancelled', 'refunded')
GROUP BY DATEFROMPARTS(YEAR(placed_at), MONTH(placed_at), 1);`,

  `CREATE VIEW dbo.customer_lifetime_value AS
SELECT
  c.customer_id,
  c.first_name,
  c.last_name,
  c.country,
  COUNT(o.order_id)         AS orders,
  COALESCE(SUM(o.total), 0) AS lifetime_value
FROM dbo.customers c
LEFT JOIN sales.orders o
  ON o.customer_id = c.customer_id AND o.status NOT IN ('cancelled', 'refunded')
GROUP BY c.customer_id, c.first_name, c.last_name, c.country;`,

  `CREATE FUNCTION dbo.order_total (@order_id int)
RETURNS decimal(12,2)
AS
BEGIN
  RETURN (
    SELECT SUM(quantity * unit_price * (1 - discount))
    FROM sales.order_items
    WHERE order_id = @order_id
  );
END;`,

  `CREATE PROCEDURE sales.top_customers
  @since date,
  @limit int = 10
AS
BEGIN
  SET NOCOUNT ON;

  SELECT TOP (@limit)
    c.customer_id,
    c.first_name,
    c.last_name,
    COUNT(*)     AS orders,
    SUM(o.total) AS revenue
  FROM sales.orders o
  JOIN dbo.customers c ON c.customer_id = o.customer_id
  WHERE o.placed_at >= @since
    AND o.status NOT IN ('cancelled', 'refunded')
  GROUP BY c.customer_id, c.first_name, c.last_name
  ORDER BY revenue DESC;
END;`,

  `CREATE PROCEDURE sales.refund_order
  @order_id int,
  @reason nvarchar(200)
AS
BEGIN
  SET NOCOUNT ON;

  UPDATE sales.orders
  SET status = 'refunded',
      notes = CONCAT(notes, CASE WHEN notes IS NULL THEN '' ELSE ' ' END, 'Refunded: ', @reason)
  WHERE order_id = @order_id
    AND status IN ('paid', 'shipped', 'delivered');

  IF @@ROWCOUNT = 0
    THROW 50001, 'Only a paid, shipped or delivered order can be refunded.', 1;
END;`
]

/**
 * Every batch that builds the demo database, in order. Run them against an
 * empty database: they create its tables rather than replace them.
 */
export function demoBatches() {
  const random = seeded(20261020)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const between = (low, high) => low + Math.floor(random() * (high - low + 1))

  const categories = CATEGORIES.map(([name, description], i) => [i + 1, quote(name), quote(description)])
  const suppliers = SUPPLIERS.map(([name, country, email], i) => [i + 1, quote(name), quote(country), quote(email)])
  const products = PRODUCTS.map(([sku, name, category, supplier, price, stock, discontinued, attributes], i) => [
    i + 1, quote(sku), quote(name), category, supplier, price.toFixed(2), stock, discontinued, quote(JSON.stringify(attributes))
  ])

  const customers = []
  const emails = new Set()
  const firstOrder = Date.UTC(2025, 0, 2)
  const lastOrder = Date.UTC(2026, 9, 19, 18)
  for (let id = 1; id <= 320; id += 1) {
    const first = pick(FIRST_NAMES)
    const last = pick(LAST_NAMES)
    let email = `${ascii(first)}.${ascii(last)}@example.com`
    for (let n = 2; emails.has(email); n += 1) email = `${ascii(first)}.${ascii(last)}${n}@example.com`
    emails.add(email)
    const [city, country] = pick(CITIES)
    const tier = random() < 0.12 ? 'gold' : random() < 0.35 ? 'silver' : 'bronze'
    const credit = tier === 'gold' ? 2500 : tier === 'silver' ? 1000 : pick([0, 250, 500])
    const created = new Date(Date.UTC(2023, 0, 9) + Math.floor(random() * (lastOrder - Date.UTC(2023, 0, 9))))
    const preferences =
      random() < 0.3
        ? null
        : {
            newsletter: random() < 0.6,
            roast: pick(['light', 'medium', 'dark']),
            brew_methods: [pick(['pour-over', 'espresso', 'French press']), pick(['cold brew', 'stovetop', 'drip'])],
            grind: pick(['whole bean', 'filter', 'espresso'])
          }
    customers.push([
      id, quote(first), quote(last), quote(email), quote(city), quote(country), quote(tier),
      credit.toFixed(2), random() < 0.92 ? 1 : 0, quote(isoDateTime(created)),
      quote(preferences && JSON.stringify(preferences))
    ])
  }

  // Orders in the order they were placed, so later ids are later orders; what
  // has happened to one depends on how long ago it was placed.
  const placedTimes = Array.from({ length: 1800 }, () =>
    firstOrder + Math.floor(random() * (lastOrder - firstOrder))
  ).sort((a, b) => a - b)
  const orders = []
  const items = []
  placedTimes.forEach((time, index) => {
    const orderId = 10001 + index
    const placed = new Date(time)
    const ageDays = (lastOrder - time) / 86400000
    let status
    if (random() < 0.04) status = 'cancelled'
    else if (ageDays < 1.5) status = random() < 0.5 ? 'new' : 'paid'
    else if (ageDays < 4) status = 'paid'
    else if (ageDays < 9) status = 'shipped'
    else status = random() < 0.03 ? 'refunded' : 'delivered'
    const shipped =
      ['shipped', 'delivered', 'refunded'].includes(status)
        ? quote(isoDate(new Date(time + between(1, 3) * 86400000)))
        : 'NULL'
    const channel = random() < 0.72 ? 'web' : random() < 0.8 ? 'store' : 'phone'
    const notes =
      status === 'refunded'
        ? 'Refunded: arrived damaged'
        : random() < 0.06
          ? pick(['Gift wrap, please', 'Leave with the neighbour', 'Ring the bell twice', 'Grind for filter'])
          : null

    let total = 0
    const lines = random() < 0.5 ? 1 : random() < 0.7 ? 2 : between(3, 4)
    const used = new Set()
    for (let line = 1; line <= lines; line += 1) {
      let product
      do product = between(1, PRODUCTS.length)
      while (used.has(product))
      used.add(product)
      const price = PRODUCTS[product - 1][4]
      const quantity = product <= 9 && random() < 0.3 ? between(2, 4) : random() < 0.15 ? 2 : 1
      const discount = random() < 0.1 ? 0.1 : 0
      total += quantity * price * (1 - discount)
      items.push([orderId, line, product, quantity, price.toFixed(2), discount.toFixed(2)])
    }
    orders.push([
      orderId, between(1, customers.length), quote(isoDateTime(placed)), quote(channel), quote(status),
      total.toFixed(2), shipped, quote(notes)
    ])
  })

  const employees = EMPLOYEES.map(([first, last, title, manager, hired], i) => [
    i + 1, quote(first), quote(last), quote(title), manager ?? 'NULL', quote(hired)
  ])

  return [
    ...SCHEMA,
    ...inserts('dbo.categories', ['category_id', 'name', 'description'], categories, { identity: true }),
    ...inserts('dbo.suppliers', ['supplier_id', 'name', 'country', 'contact_email'], suppliers, { identity: true }),
    ...inserts(
      'dbo.products',
      ['product_id', 'sku', 'name', 'category_id', 'supplier_id', 'unit_price', 'units_in_stock', 'discontinued', 'attributes'],
      products,
      { identity: true }
    ),
    ...inserts(
      'dbo.customers',
      ['customer_id', 'first_name', 'last_name', 'email', 'city', 'country', 'loyalty_tier', 'credit_limit', 'is_active', 'created_at', 'preferences'],
      customers,
      { identity: true }
    ),
    ...inserts(
      'sales.orders',
      ['order_id', 'customer_id', 'placed_at', 'channel', 'status', 'total', 'shipped_on', 'notes'],
      orders,
      { identity: true }
    ),
    ...inserts('sales.order_items', ['order_id', 'line_no', 'product_id', 'quantity', 'unit_price', 'discount'], items),
    ...inserts(
      'hr.employees',
      ['employee_id', 'first_name', 'last_name', 'title', 'manager_id', 'hired_on'],
      employees,
      { identity: true }
    ),
    ...ROUTINES
  ]
}

/**
 * Builds the demo database afresh on `server`, dropping the one a previous run
 * left, and gives the production connection's login its way in.
 */
export async function seedDemoDatabase(server) {
  const config = {
    server: server.host,
    port: server.port,
    user: server.user,
    password: server.password,
    options: { encrypt: true, trustServerCertificate: true },
    requestTimeout: 120000
  }

  const master = await new sql.ConnectionPool({ ...config, database: 'master' }).connect()
  try {
    await master.request().batch(`
      IF DB_ID('${DEMO_DATABASE}') IS NOT NULL
      BEGIN
        ALTER DATABASE [${DEMO_DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
        DROP DATABASE [${DEMO_DATABASE}];
      END;
      CREATE DATABASE [${DEMO_DATABASE}];
      IF SUSER_ID('${APP_LOGIN.user}') IS NULL
        CREATE LOGIN [${APP_LOGIN.user}] WITH PASSWORD = '${APP_LOGIN.password}', CHECK_POLICY = OFF;
    `)
  } finally {
    await master.close()
  }

  const demo = await new sql.ConnectionPool({ ...config, database: DEMO_DATABASE }).connect()
  try {
    for (const batch of demoBatches()) await demo.request().batch(batch)
    await demo.request().batch(`
      CREATE USER [${APP_LOGIN.user}] FOR LOGIN [${APP_LOGIN.user}];
      ALTER ROLE db_datareader ADD MEMBER [${APP_LOGIN.user}];
      ALTER ROLE db_datawriter ADD MEMBER [${APP_LOGIN.user}];
      GRANT EXECUTE, VIEW DEFINITION TO [${APP_LOGIN.user}];
    `)
  } finally {
    await demo.close()
  }
}
