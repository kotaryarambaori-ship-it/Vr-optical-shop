
const WHATSAPP_NUMBER = "918840729301";

let products = [];
let gallery = [];
let cart = [];
let token = localStorage.getItem("vr_token") || "";
let currentUser = null;

const $ = id => document.getElementById(id);

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };

  if (token) headers.Authorization = "Bearer " + token;

  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "कुछ गड़बड़ हो गई");
  }

  return data;
}

function toast(message) {
  const box = $("toast");
  box.textContent = message;
  box.classList.add("show");
  setTimeout(() => box.classList.remove("show"), 3000);
}

function toggleMenu() {
  $("nav").classList.toggle("open");
}

function closeMenu() {
  $("nav").classList.remove("open");
}

function money(value) {
  return "₹" + Number(value || 0).toLocaleString("en-IN");
}

function imageURL(image) {
  if (!image) return "https://placehold.co/600x400?text=V%2BR+Optical";
  return image.startsWith("http")
    ? image
    : image;
}

// Load products
async function loadProducts() {
  try {
    products = await api("/api/products");
    renderProducts();
  } catch (error) {
    $("productsList").innerHTML =
      "<p>प्रोडक्ट लोड नहीं हो पाए। " + escapeHTML(error.message) + "</p>";
  }
}

function renderProducts() {
  const search = ($("search")?.value || "").toLowerCase();
  const category = $("category")?.value || "";

  const filtered = products.filter(product => {
    const matchesSearch =
      (product.name || "").toLowerCase().includes(search) ||
      (product.description || "").toLowerCase().includes(search);

    const matchesCategory = !category || product.category === category;

    return matchesSearch && matchesCategory;
  });

  if (!filtered.length) {
    $("productsList").innerHTML = "<p>कोई प्रोडक्ट नहीं मिला।</p>";
    return;
  }

  $("productsList").innerHTML = filtered.map(product => {
    const price = Number(product.discount_price || product.price);

    return `
      <article class="product-card">
        <img class="product-image"
          src="${escapeHTML(imageURL(product.image))}"
          alt="${escapeHTML(product.name)}"
          loading="lazy"
          onerror="this.src='https://placehold.co/600x400?text=V%2BR+Optical'">

        <div class="product-info">
          <h3>${escapeHTML(product.name)}</h3>
          <p>${escapeHTML(product.description || product.category || "")}</p>
          <div class="price">
            ${money(price)}
            ${product.discount_price
              ? `<span class="old-price">${money(product.price)}</span>`
              : ""}
          </div>
          <small>स्टॉक: ${Number(product.stock)}</small>
          <button onclick="addToCart(${Number(product.id)})"
            ${Number(product.stock) < 1 ? "disabled" : ""}>
            ${Number(product.stock) < 1 ? "Out of Stock" : "🛒 Cart में डालें"}
          </button>
          <button style="margin-top:7px;background:#20bd65"
            onclick="buyOnWhatsApp(${Number(product.id)})">
            WhatsApp से पूछें
          </button>
          ${currentUser?.role === "admin"
            ? `<button style="margin-top:7px;background:#b42d38"
                 onclick="deleteProduct(${Number(product.id)})">
                 प्रोडक्ट हटाएं
               </button>`
            : ""}
        </div>
      </article>
    `;
  }).join("");
}

function buyOnWhatsApp(id) {
  const product = products.find(p => Number(p.id) === Number(id));
  if (!product) return;

  const message = `नमस्ते, मुझे ${product.name} के बारे में जानकारी चाहिए।`;
  window.open(
    "https://wa.me/" + WHATSAPP_NUMBER + "?text=" + encodeURIComponent(message),
    "_blank"
  );
}

// Cart
function addToCart(id) {
  const product = products.find(p => Number(p.id) === Number(id));
  if (!product) return;

  const existing = cart.find(item => item.id === id);
  const qty = existing ? existing.quantity : 0;

  if (qty >= Number(product.stock)) {
    return toast("इतना स्टॉक उपलब्ध नहीं है");
  }

  if (existing) {
    existing.quantity++;
  } else {
    cart.push({ id, quantity: 1 });
  }

  updateCart();
  toast("प्रोडक्ट Cart में जुड़ गया");
}

function updateCart() {
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  $("cartCount").textContent = count;

  let total = 0;

  $("cartItems").innerHTML = cart.map(item => {
    const product = products.find(p => Number(p.id) === Number(item.id));
    if (!product) return "";

    const price = Number(product.discount_price || product.price);
    total += price * item.quantity;

    return `
      <div class="cart-row">
        <div>
          <b>${escapeHTML(product.name)}</b><br>
          ${money(price)} × ${item.quantity}
        </div>
        <div>
          <button onclick="changeQty(${item.id},-1)">−</button>
          <button onclick="changeQty(${item.id},1)">+</button>
          <button onclick="removeFromCart(${item.id})">×</button>
        </div>
      </div>
    `;
  }).join("") || "<p>आपका Cart खाली है।</p>";

  $("cartTotal").textContent = "Total: " + money(total);
}

function changeQty(id, change) {
  const item = cart.find(x => x.id === id);
  const product = products.find(x => Number(x.id) === Number(id));
  if (!item || !product) return;

  const next = item.quantity + change;

  if (next < 1) {
    removeFromCart(id);
    return;
  }

  if (next > Number(product.stock)) {
    return toast("स्टॉक उपलब्ध नहीं है");
  }

  item.quantity = next;
  updateCart();
}

function removeFromCart(id) {
  cart = cart.filter(item => item.id !== id);
  updateCart();
}

function showCart() {
  updateCart();
  $("cartModal").classList.add("show");
}

function hideCart() {
  $("cartModal").classList.remove("show");
}

function closeModalOutside(event, id) {
  if (event.target.id === id) {
    event.target.classList.remove("show");
  }
}

// Register
async function registerUser(event) {
  event.preventDefault();

  try {
    const data = await api("/api/register", {
      method: "POST",
      body: JSON.stringify({
        name: $("regName").value,
        email: $("regEmail").value,
        password: $("regPassword").value
      })
    });

    saveLogin(data);
    toast("अकाउंट बन गया");
  } catch (error) {
    toast(error.message);
  }
}

// Login
async function loginUser(event) {
  event.preventDefault();

  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        email: $("loginEmail").value,
        password: $("loginPassword").value
      })
    });

    saveLogin(data);
    toast("Login सफल हुआ");
  } catch (error) {
    toast(error.message);
  }
}

function saveLogin(data) {
  token = data.token;
  currentUser = data.user;

  localStorage.setItem("vr_token", token);
  updateAccount();
  renderProducts();
}

async function checkLogin() {
  if (!token) return;

  try {
    currentUser = await api("/api/me");
    updateAccount();
  } catch {
    logout(false);
  }
}

function updateAccount() {
  if (!currentUser) return;

  $("accountInfo").innerHTML = `
    <div class="account-info">
      <h3>नमस्ते ${escapeHTML(currentUser.name)}</h3>
      <p>${escapeHTML(currentUser.email)}</p>
      <p>Account: ${escapeHTML(currentUser.role)}</p>
      <button class="primary-btn" onclick="loadMyOrders()">मेरे ऑर्डर</button>
      <button class="primary-btn" onclick="logout()">Logout</button>
    </div>
  `;

  $("admin").hidden = currentUser.role !== "admin";
}

function showAccount() {
  document.getElementById("account").scrollIntoView({ behavior: "smooth" });
  closeMenu();
}

function logout(showMessage = true) {
  token = "";
  currentUser = null;

  localStorage.removeItem("vr_token");
  $("accountInfo").innerHTML = "";
  $("admin").hidden = true;

  renderProducts();

  if (showMessage) toast("आप Logout हो गए");
}

async function loadMyOrders() {
  try {
    const orders = await api("/api/my-orders");

    $("accountInfo").innerHTML += `
      <h3>आपके ऑर्डर</h3>
      ${orders.map(order => `
        <div class="order-card">
          <b>Order #${order.id}</b>
          <p>Total: ${money(order.total)}</p>
          <p>Status: ${escapeHTML(order.status)}</p>
          <p>${new Date(order.created_at).toLocaleString("en-IN")}</p>
        </div>
      `).join("") || "<p>अभी कोई ऑर्डर नहीं है।</p>"}
    `;
  } catch (error) {
    toast(error.message);
  }
}

// Place order
async function placeOrder(event) {
  event.preventDefault();

  if (!token || !currentUser) {
    toast("ऑर्डर करने से पहले Login करें");
    hideCart();
    showAccount();
    return;
  }

  if (!cart.length) return toast("आपका Cart खाली है");

  try {
    const order = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        customer_name: $("orderName").value,
        mobile: $("orderMobile").value,
        address: $("orderAddress").value,
        items: cart
      })
    });

    cart = [];
    updateCart();
    hideCart();
    event.target.reset();

    await loadProducts();

    toast("ऑर्डर बुक हो गया! Order #" + order.id);

    const message =
      `नया ऑर्डर #${order.id}\nनाम: ${$("orderName").value}\nकृपया ऑर्डर कन्फर्म करें।`;

    window.open(
      "https://wa.me/" + WHATSAPP_NUMBER + "?text=" +
      encodeURIComponent(message),
      "_blank"
    );
  } catch (error) {
    toast(error.message);
  }
}

// Gallery
async function loadGallery() {
  try {
    gallery = await api("/api/gallery");

    $("galleryList").innerHTML = gallery.map(item => `
      <div class="gallery-card">
        <img src="${escapeHTML(imageURL(item.image))}"
          alt="${escapeHTML(item.title)}"
          loading="lazy"
          onerror="this.src='https://placehold.co/600x400?text=V%2BR+Optical'">
        <p>${escapeHTML(item.title)}</p>
        ${currentUser?.role === "admin"
          ? `<button onclick="deleteGallery(${Number(item.id)})">हटाएं</button>`
          : ""}
      </div>
    `).join("") || "<p>गैलरी में अभी फोटो नहीं हैं।</p>";
  } catch (error) {
    $("galleryList").innerHTML = "<p>गैलरी लोड नहीं हो सकी।</p>";
  }
}

// Admin: add product
async function addProduct(event) {
  event.preventDefault();

  try {
    const form = new FormData(event.target);

    await api("/api/products", {
      method: "POST",
      body: form
    });

    event.target.reset();
    await loadProducts();
    toast("प्रोडक्ट सफलतापूर्वक जुड़ गया");
  } catch (error) {
    toast(error.message);
  }
}

// Admin: delete product
async function deleteProduct(id) {
  if (!confirm("क्या आप यह प्रोडक्ट हटाना चाहते हैं?")) return;

  try {
    await api("/api/products/" + id, { method: "DELETE" });
    await loadProducts();
    toast("प्रोडक्ट हटा दिया गया");
  } catch (error) {
    toast(error.message);
  }
}

// Admin: gallery
async function addGallery(event) {
  event.preventDefault();

  try {
    await api("/api/gallery", {
      method: "POST",
      body: new FormData(event.target)
    });

    event.target.reset();
    await loadGallery();
    toast("फोटो अपलोड हो गई");
  } catch (error) {
    toast(error.message);
  }
}

async function deleteGallery(id) {
  if (!confirm("क्या फोटो हटानी है?")) return;

  try {
    await api("/api/gallery/" + id, { method: "DELETE" });
    await loadGallery();
    toast("फोटो हटा दी गई");
  } catch (error) {
    toast(error.message);
  }
}

// Admin: orders
async function loadAdminOrders() {
  try {
    const orders = await api("/api/orders");

    $("adminOrders").innerHTML = orders.map(order => `
      <div class="order-card">
        <b>Order #${order.id}</b>
        <p>ग्राहक: ${escapeHTML(order.customer_name)}</p>
        <p>मोबाइल: ${escapeHTML(order.mobile)}</p>
        <p>पता: ${escapeHTML(order.address)}</p>
        <p>Total: ${money(order.total)}</p>
        <p>Items: ${escapeHTML(JSON.stringify(order.items))}</p>
        <select onchange="changeOrderStatus(${order.id},this.value)">
          ${["Pending","Confirmed","Shipped","Delivered","Cancelled"].map(status =>
            `<option value="${status}" ${order.status === status ? "selected" : ""}>${status}</option>`
          ).join("")}
        </select>
      </div>
    `).join("") || "<p>अभी कोई ऑर्डर नहीं है।</p>";
  } catch (error) {
    toast(error.message);
  }
}

async function changeOrderStatus(id, status) {
  try {
    await api("/api/orders/" + id, {
      method: "PATCH",
      body: JSON.stringify({ status })
    });
    toast("ऑर्डर का स्टेटस बदल गया");
  } catch (error) {
    toast(error.message);
  }
}

// Admin: enquiries
async function loadEnquiries() {
  try {
    const enquiries = await api("/api/enquiries");

    $("enquiriesList").innerHTML = enquiries.map(item => `
      <div class="enquiry-card">
        <b>${escapeHTML(item.name)}</b>
        <p>मोबाइल: ${escapeHTML(item.mobile)}</p>
        <p>${escapeHTML(item.message)}</p>
      </div>
    `).join("") || "<p>अभी कोई पूछताछ नहीं है।</p>";
  } catch (error) {
    toast(error.message);
  }
}

// Contact form
async function sendEnquiry(event) {
  event.preventDefault();

  try {
    await api("/api/enquiries", {
      method: "POST",
      body: JSON.stringify({
        name: $("enqName").value,
        mobile: $("enqMobile").value,
        message: $("enqMessage").value
      })
    });

    event.target.reset();
    toast("आपका मैसेज भेज दिया गया");
  } catch (error) {
    toast(error.message);
  }
}

// Start website
async function startWebsite() {
  $("year").textContent = new Date().getFullYear();

  await checkLogin();

  await Promise.all([
    loadProducts(),
    loadGallery()
  ]);

  updateCart();
}

startWebsite();
