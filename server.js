
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
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing");
}

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters");
}

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD are required");
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

app.use("/uploads", express.static(path.resolve(UPLOAD_DIR)));
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
      return cb(new Error("Only JPG, PNG and WEBP images are allowed"));
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

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'customer',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

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

  const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (email) DO UPDATE SET role = 'admin'`,
    ["V+R Admin", ADMIN_EMAIL, hash]
  );

  console.log("Database ready");
}

function makeToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) {
    return res.status(401).json({ error: "Please login first" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired login" });
  }
}

function admin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function removeUpload(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith("/uploads/")) return;
  const filename = path.basename(imageUrl);
  const file = path.join(path.resolve(UPLOAD_DIR), filename);
  fs.unlink(file, () => {});
}

// Health check
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch {
    res.status(500).json({ ok: false, database: "error" });
  }
});

// Register
app.post("/api/register", loginLimit, async (req, res) => {
  try {
    const name = cleanText(req.body.name, 100);
    const email = cleanText(req.body.email, 150).toLowerCase();
    const password = String(req.body.password || "");

    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter valid name and email" });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, role`,
      [name, email, hash]
    );

    const user = result.rows[0];
    res.json({ token: makeToken(user), user });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Email already registered" });
    }
    res.status(500).json({ error: "Registration failed" });
  }
});

// Login
app.post("/api/login", loginLimit, async (req, res) => {
  try {
    const email = cleanText(req.body.email, 150).toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Wrong email or password" });
    }

    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    };

    res.json({ token: makeToken(safeUser), user: safeUser });
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});

// Current user
app.get("/api/me", auth, async (req, res) => {
  const result = await pool.query(
    "SELECT id, name, email, role FROM users WHERE id = $1",
    [req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "User not found" });
  res.json(result.rows[0]);
});

// Products
app.get("/api/products", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM products ORDER BY created_at DESC"
  );
  res.json(result.rows);
});

app.post("/api/products", auth, admin, upload.single("image"), async (req, res) => {
  try {
    const name = cleanText(req.body.name, 150);
    const price = Number(req.body.price);
    const stock = Math.max(0, parseInt(req.body.stock || "0", 10));

    if (!name || !Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: "Enter valid product details" });
    }

    const image = req.file ? "/uploads/" + req.file.filename : "";

    const result = await pool.query(
      `INSERT INTO products
       (name, category, description, price, discount_price, stock, image)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        name,
        cleanText(req.body.category, 80),
        cleanText(req.body.description, 1000),
        price,
        req.body.discount_price ? Number(req.body.discount_price) : null,
        stock,
        image
      ]
    );

    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: "Could not add product" });
  }
});

app.put("/api/products/:id", auth, admin, upload.single("image"), async (req, res) => {
  try {
    const old = await pool.query(
      "SELECT * FROM products WHERE id=$1",
      [req.params.id]
    );
    if (!old.rows[0]) return res.status(404).json({ error: "Product not found" });

    const p = old.rows[0];
    const image = req.file ? "/uploads/" + req.file.filename : p.image;

    const result = await pool.query(
      `UPDATE products SET
       name=$1, category=$2, description=$3, price=$4,
       discount_price=$5, stock=$6, image=$7
       WHERE id=$8 RETURNING *`,
      [
        cleanText(req.body.name || p.name, 150),
        cleanText(req.body.category || p.category, 80),
        cleanText(req.body.description || p.description, 1000),
        req.body.price === undefined ? p.price : Number(req.body.price),
        req.body.discount_price === undefined
          ? p.discount_price
          : (req.body.discount_price ? Number(req.body.discount_price) : null),
        req.body.stock === undefined ? p.stock : Math.max(0, parseInt(req.body.stock, 10)),
        image,
        req.params.id
      ]
    );

    if (req.file) removeUpload(p.image);
    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: "Could not update product" });
  }
});

app.delete("/api/products/:id", auth, admin, async (req, res) => {
  const result = await pool.query(
    "DELETE FROM products WHERE id=$1 RETURNING image",
    [req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
  removeUpload(result.rows[0].image);
  res.json({ ok: true });
});

// Gallery
app.get("/api/gallery", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM gallery ORDER BY created_at DESC"
  );
  res.json(result.rows);
});

app.post("/api/gallery", auth, admin, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose an image" });

  const result = await pool.query(
    "INSERT INTO gallery (title,image) VALUES ($1,$2) RETURNING *",
    [cleanText(req.body.title, 150), "/uploads/" + req.file.filename]
  );
  res.json(result.rows[0]);
});

app.delete("/api/gallery/:id", auth, admin, async (req, res) => {
  const result = await pool.query(
    "DELETE FROM gallery WHERE id=$1 RETURNING image",
    [req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
  removeUpload(result.rows[0].image);
  res.json({ ok: true });
});

// Place an order
app.post("/api/orders", auth, async (req, res) => {
  const client = await pool.connect();

  try {
    const customer = cleanText(req.body.customer_name, 100);
    const mobile = cleanText(req.body.mobile, 15);
    const address = cleanText(req.body.address, 500);
    const items = req.body.items;

    if (!customer || !/^[0-9]{10}$/.test(mobile) || !address) {
      return res.status(400).json({ error: "Enter name, 10 digit mobile and address" });
    }

    if (!Array.isArray(items) || items.length < 1 || items.length > 30) {
      return res.status(400).json({ error: "Invalid cart" });
    }

    await client.query("BEGIN");

    let total = 0;
    const finalItems = [];

    for (const item of items) {
      const id = Number(item.id);
      const qty = Math.max(1, Math.min(20, parseInt(item.quantity, 10)));

      const found = await client.query(
        "SELECT * FROM products WHERE id=$1 FOR UPDATE",
        [id]
      );

      const product = found.rows[0];

      if (!product || product.stock < qty) {
        throw new Error("Product unavailable or stock insufficient");
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
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, customer, mobile, address, JSON.stringify(finalItems), total]
    );

    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message || "Order failed" });
  } finally {
    client.release();
  }
});

// My orders
app.get("/api/my-orders", auth, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC",
    [req.user.id]
  );
  res.json(result.rows);
});

// Admin orders
app.get("/api/orders", auth, admin, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM orders ORDER BY created_at DESC"
  );
  res.json(result.rows);
});

app.patch("/api/orders/:id", auth, admin, async (req, res) => {
  const allowed = ["Pending", "Confirmed", "Shipped", "Delivered", "Cancelled"];
  const status = cleanText(req.body.status, 30);

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const result = await pool.query(
    "UPDATE orders SET status=$1 WHERE id=$2 RETURNING *",
    [status, req.params.id]
  );

  if (!result.rows[0]) return res.status(404).json({ error: "Order not found" });
  res.json(result.rows[0]);
});

// Enquiry
app.post("/api/enquiries", async (req, res) => {
  const name = cleanText(req.body.name, 100);
  const mobile = cleanText(req.body.mobile, 15);
  const message = cleanText(req.body.message, 1000);

  if (!name || !/^[0-9]{10}$/.test(mobile) || !message) {
    return res.status(400).json({ error: "Enter valid details" });
  }

  await pool.query(
    "INSERT INTO enquiries (name,mobile,message) VALUES ($1,$2,$3)",
    [name, mobile, message]
  );

  res.json({ ok: true });
});

// Admin enquiries
app.get("/api/enquiries", auth, admin, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM enquiries ORDER BY created_at DESC"
  );
  res.json(result.rows);
});

// Upload and database errors
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(400).json({ error: err.message || "Request failed" });
});

async function start() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log("V+R Optical Shop running on port " + PORT);
  });
}

start().catch(err => {
  console.error("Server startup failed:", err);
  process.exit(1);
});
