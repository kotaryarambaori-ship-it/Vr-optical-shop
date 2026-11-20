require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const app = express();

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || "uploads");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing");
}

if (JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters");
}

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD are required");
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const isLocalDatabase =
  /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalDatabase ? false : { rejectUnauthorized: false }
});

app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, crypto.randomUUID() + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("केवल JPG, PNG और WEBP फोटो स्वीकार हैं"));
    }

    cb(null, true);
  }
});

const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

// DATABASE SETUP AND SAFE MIGRATION
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT,
      email TEXT,
      password_hash TEXT,
      role TEXT DEFAULT 'customer',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'customer';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'Glasses',
      description TEXT DEFAULT '',
      price NUMERIC(10,2) NOT NULL DEFAULT 0,
      discount_price NUMERIC(10,2),
      stock INTEGER NOT NULL DEFAULT 0,
      image TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS gallery (
      id SERIAL PRIMARY KEY,
      title TEXT DEFAULT '',
      image TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      customer_name TEXT NOT NULL,
      mobile TEXT NOT NULL,
      address TEXT NOT NULL,
      items JSONB NOT NULL,
      total NUMERIC(10,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS enquiries (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      mobile TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // पुराने डेटा में duplicate email होने पर सर्वर बंद न हो।
  const duplicates = await pool.query(`
    SELECT email
    FROM users
    WHERE email IS NOT NULL
    GROUP BY email
    HAVING COUNT(*) > 1
  `);

  if (duplicates.rows.length === 0) {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
      ON users (email)
      WHERE email IS NOT NULL
    `);
  } else {
    console.warn("पुराने users डेटा में duplicate email मिले।");
  }

  // Admin account को हर startup पर सही password के साथ सेट करें।
  const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  const existingAdmin = await pool.query(
    "SELECT id FROM users WHERE LOWER(email) = $1 ORDER BY id LIMIT 1",
    [ADMIN_EMAIL]
  );

  if (existingAdmin.rows.length) {
    await pool.query(
      `UPDATE users
       SET name=$1, password_hash=$2, role='admin'
       WHERE id=$3`,
      ["V+R Admin", adminHash, existingAdmin.rows[0].id]
    );
  } else {
    await pool.query(
      `INSERT INTO users (name,email,password_hash,role)
       VALUES ($1,$2,$3,'admin')`,
      ["V+R Admin", ADMIN_EMAIL, adminHash]
    );
  }

  console.log("Database ready");
}

function makeToken(user) {
  return jwt.sign(
    {
      id: user.id,
      role: user.role,
      email: user.email
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : "";

  if (!token) {
    return res.status(401).json({ error: "पहले Login करें" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Login समाप्त हो गया, फिर से Login करें" });
  }
}

function admin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "केवल Admin अनुमति है" });
  }

  next();
}

function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function removeUpload(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith("/uploads/")) return;

  const filename = path.basename(imageUrl);
  const file = path.join(UPLOAD_DIR, filename);

  fs.unlink(file, () => {});
}

// HEALTH CHECK
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch (error) {
    console.error("Health error:", error.message);
    res.status(500).json({ ok: false, database: "error" });
  }
});

// REGISTER
app.post("/api/register", loginLimit, async (req, res) => {
  try {
    const name = cleanText(req.body.name, 100);
    const email = cleanText(req.body.email, 150).toLowerCase();
    const password = String(req.body.password || "");

    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "सही नाम और Email डालें" });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "Password कम से कम 8 अक्षर का होना चाहिए"
      });
    }

    const oldUser = await pool.query(
      "SELECT id FROM users WHERE LOWER(email)=$1 LIMIT 1",
      [email]
    );

    if (oldUser.rows.length) {
      return res.status(409).json({ error: "यह Email पहले से रजिस्टर है" });
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (name,email,password_hash,role)
       VALUES ($1,$2,$3,'customer')
       RETURNING id,name,email,role`,
      [name, email, hash]
    );

    const user = result.rows[0];

    res.json({
      token: makeToken(user),
      user
    });
  } catch (error) {
    console.error("Register error:", error.message);

    if (error.code === "23505") {
      return res.status(409).json({ error: "यह Email पहले से रजिस्टर है" });
    }

    res.status(500).json({ error: "Registration नहीं हो पाया" });
  }
});

// LOGIN
app.post("/api/login", loginLimit, async (req, res) => {
  try {
    const email = cleanText(req.body.email, 150).toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query(
      "SELECT * FROM users WHERE LOWER(email)=$1 LIMIT 1",
      [email]
    );

    const user = result.rows[0];

    if (
      !user ||
      !user.password_hash ||
      !(await bcrypt.compare(password, user.password_hash))
    ) {
      return res.status(401).json({ error: "Email या Password गलत है" });
    }

    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    };

    res.json({
      token: makeToken(safeUser),
      user: safeUser
    });
  } catch (error) {
    console.error("Login error:", error.message);
    res.status(500).json({ error: "Login नहीं हो पाया" });
  }
});

// CURRENT USER
app.get("/api/me", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id,name,email,role FROM users WHERE id=$1",
      [req.user.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "User नहीं मिला" });
    }

    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: "Account नहीं खुल पाया" });
  }
});

// PRODUCTS
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products ORDER BY created_at DESC"
    );

    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Products लोड नहीं हुए" });
  }
});

app.post("/api/products", auth, admin, upload.single("image"), async (req, res) => {
  try {
    const name = cleanText(req.body.name, 150);
    const price = Number(req.body.price);
    const stock = Number.parseInt(req.body.stock || "0", 10);
    const discount = req.body.discount_price === ""
      ? null
      : Number(req.body.discount_price);

    if (!name || !Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: "Product का नाम और सही कीमत डालें" });
    }

    if (!Number.isInteger(stock) || stock < 0) {
      return res.status(400).json({ error: "सही Stock डालें" });
    }

    if (discount !== null && (!Number.isFinite(discount) || discount < 0)) {
      return res.status(400).json({ error: "Discount कीमत सही डालें" });
    }

    const image = req.file ? "/uploads/" + req.file.filename : "";

    const result = await pool.query(
      `INSERT INTO products
       (name,category,description,price,discount_price,stock,image)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        name,
        cleanText(req.body.category, 80) || "Other",
        cleanText(req.body.description, 1000),
        price,
        discount,
        stock,
        image
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Add product error:", error.message);
    res.status(500).json({ error: "Product सेव नहीं हुआ" });
  }
});

app.put("/api/products/:id", auth, admin, upload.single("image"), async (req, res) => {
  try {
    const old = await pool.query(
      "SELECT * FROM products WHERE id=$1",
      [req.params.id]
    );

    if (!old.rows[0]) {
      return res.status(404).json({ error: "Product नहीं मिला" });
    }

    const p = old.rows[0];
    const price = req.body.price === undefined ? Number(p.price) : Number(req.body.price);
    const stock = req.body.stock === undefined
      ? Number(p.stock)
      : Number.parseInt(req.body.stock, 10);

    if (!Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) {
      return res.status(400).json({ error: "कीमत या Stock सही नहीं है" });
    }

    const discount = req.body.discount_price === undefined
      ? p.discount_price
      : (req.body.discount_price === "" ? null : Number(req.body.discount_price));

    if (discount !== null && (!Number.isFinite(Number(discount)) || Number(discount) < 0)) {
      return res.status(400).json({ error: "Discount कीमत सही डालें" });
    }

    const image = req.file ? "/uploads/" + req.file.filename : p.image;

    const result = await pool.query(
      `UPDATE products SET
       name=$1,category=$2,description=$3,price=$4,
       discount_price=$5,stock=$6,image=$7
       WHERE id=$8 RETURNING *`,
      [
        cleanText(req.body.name || p.name, 150),
        cleanText(req.body.category || p.category, 80),
        cleanText(req.body.description ?? p.description, 1000),
        price,
        discount,
        stock,
        image,
        req.params.id
      ]
    );

    if (req.file) removeUpload(p.image);

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Update product error:", error.message);
    res.status(500).json({ error: "Product अपडेट नहीं हुआ" });
  }
});

app.delete("/api/products/:id", auth, admin, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM products WHERE id=$1 RETURNING image",
      [req.params.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Product नहीं मिला" });
    }

    removeUpload(result.rows[0].image);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Product हटाया नहीं जा सका" });
  }
});

// GALLERY
app.get("/api/gallery", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM gallery ORDER BY created_at DESC"
    );

    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Gallery लोड नहीं हुई" });
  }
});

app.post("/api/gallery", auth, admin, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "फोटो चुनें" });
    }

    const result = await pool.query(
      "INSERT INTO gallery (title,image) VALUES ($1,$2) RETURNING *",
      [
        cleanText(req.body.title, 150),
        "/uploads/" + req.file.filename
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Gallery upload error:", error.message);
    res.status(500).json({ error: "फोटो सेव नहीं हुई" });
  }
});

app.delete("/api/gallery/:id", auth, admin, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM gallery WHERE id=$1 RETURNING image",
      [req.params.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "फोटो नहीं मिली" });
    }

    removeUpload(result.rows[0].image);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "फोटो हटाई नहीं जा सकी" });
  }
});

// PLACE ORDER
app.post("/api/orders", auth, async (req, res) => {
  const customer = cleanText(req.body.customer_name, 100);
  const mobile = cleanText(req.body.mobile, 15);
  const address = cleanText(req.body.address, 500);
  const items = req.body.items;

  if (!customer || !/^[0-9]{10}$/.test(mobile) || !address) {
    return res.status(400).json({
      error: "नाम, 10 अंकों का मोबाइल और पूरा पता डालें"
    });
  }

  if (!Array.isArray(items) || items.length < 1 || items.length > 30) {
    return res.status(400).json({ error: "Cart सही नहीं है" });
  }

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    let total = 0;
    const finalItems = [];

    for (const item of items) {
      const id = Number(item.id);
      const qty = Number(item.quantity);

      if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 20) {
        throw new Error("Product या Quantity सही नहीं है");
      }

      const found = await client.query(
        "SELECT * FROM products WHERE id=$1 FOR UPDATE",
        [id]
      );

      const product = found.rows[0];

      if (!product || Number(product.stock) < qty) {
        throw new Error("Product उपलब्ध नहीं है या Stock कम है");
      }

      const price = Number(product.discount_price || product.price);
      total += price * qty;

      finalItems.push({
        id: product.id,
        name: product.name,
        price,
        quantity: qty
      });

      await client.query(
        "UPDATE products SET stock=stock-$1 WHERE id=$2",
        [qty, id]
      );
    }

    const result = await client.query(
      `INSERT INTO orders
       (user_id,customer_name,mobile,address,items,total)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        req.user.id,
        customer,
        mobile,
        address,
        JSON.stringify(finalItems),
        total
      ]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    res.json(result.rows[0]);
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK");
    }

    console.error("Order error:", error.message);
    res.status(400).json({ error: error.message || "Order नहीं हुआ" });
  } finally {
    client.release();
  }
});

// MY ORDERS
app.get("/api/my-orders", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC",
      [req.user.id]
    );

    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Orders नहीं खुल पाए" });
  }
});

// ADMIN ORDERS
app.get("/api/orders", auth, admin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders ORDER BY created_at DESC"
    );

    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Orders नहीं खुल पाए" });
  }
});

app.patch("/api/orders/:id", auth, admin, async (req, res) => {
  try {
    const allowed = [
      "Pending",
      "Confirmed",
      "Shipped",
      "Delivered",
      "Cancelled"
    ];

    const status = cleanText(req.body.status, 30);

    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "Order Status सही नहीं है" });
    }

    const result = await pool.query(
      "UPDATE orders SET status=$1 WHERE id=$2 RETURNING *",
      [status, req.params.id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Order नहीं मिला" });
    }

    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: "Order अपडेट नहीं हुआ" });
  }
});

// CUSTOMER ENQUIRY
app.post("/api/enquiries", async (req, res) => {
  try {
    const name = cleanText(req.body.name, 100);
    const mobile = cleanText(req.body.mobile, 15);
    const message = cleanText(req.body.message, 1000);

    if (!name || !/^[0-9]{10}$/.test(mobile) || !message) {
      return res.status(400).json({ error: "सही जानकारी भरें" });
    }

    await pool.query(
      "INSERT INTO enquiries (name,mobile,message) VALUES ($1,$2,$3)",
      [name, mobile, message]
    );

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "मैसेज नहीं भेजा जा सका" });
  }
});

// ADMIN ENQUIRIES
app.get("/api/enquiries", auth, admin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM enquiries ORDER BY created_at DESC"
    );

    res.json(result.rows);
  } catch {
    res.status(500).json({ error: "Enquiries नहीं खुलीं" });
  }
});

// ERROR HANDLER
app.use((err, req, res, next) => {
  console.error("Request error:", err.message);
  res.status(400).json({ error: err.message || "Request failed" });
});

// START SERVER
async function start() {
  await initDatabase();

  app.listen(PORT, () => {
    console.log("V+R Optical Shop running on port " + PORT);
  });
}

start().catch(error => {
  console.error("Server startup failed:", error);
  process.exit(1);
});
