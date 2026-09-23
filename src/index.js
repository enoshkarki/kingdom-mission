// ============================================
// KEP Worker — Payments + Blog Publisher
// ============================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function generateTxnId() {
  return `KEP-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Base64-encode UTF-8 safely (supports Nepali + emojis)
function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ============================================
// MAIN HANDLER
// ============================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (path === "/" || path === "/health") {
      return jsonResponse({
        status: "ok",
        service: "KEP Worker",
        endpoints: [
          "/api/esewa/initiate",
          "/api/khalti/initiate",
          "/api/blog/list",
          "/api/blog/create",
          "/api/blog/delete",
        ],
      });
    }

    if (path === "/api/esewa/initiate" && request.method === "POST") return handleEsewa(request, env);
    if (path === "/api/khalti/initiate" && request.method === "POST") return handleKhalti(request, env);

    // Blog endpoints
    if (path === "/api/blog/list" && request.method === "GET") return handleBlogList(request, env);
    if (path === "/api/blog/create" && request.method === "POST") return handleBlogCreate(request, env);
    if (path === "/api/blog/delete" && request.method === "POST") return handleBlogDelete(request, env);

    return jsonResponse({ error: "Not found" }, 404);
  },
};

// ============================================
// ESEWA
// ============================================
async function handleEsewa(request, env) {
  try {
    const body = await request.json();
    const amount = Number(body.amount);
    if (!amount || amount <= 0) return jsonResponse({ error: "Invalid amount" }, 400);

    const tax_amount = 0, product_service_charge = 0, product_delivery_charge = 0;
    const total_amount = amount + tax_amount + product_service_charge + product_delivery_charge;
    const transaction_uuid = generateTxnId();
    const product_code = env.ESEWA_PRODUCT_CODE;
    const secret_key = env.ESEWA_SECRET_KEY;

    if (!product_code || !secret_key) return jsonResponse({ error: "eSewa credentials not configured" }, 500);

    const message = `total_amount=${total_amount},transaction_uuid=${transaction_uuid},product_code=${product_code}`;
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(secret_key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
    const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

    const payload = {
      amount: String(amount),
      tax_amount: String(tax_amount),
      total_amount: String(total_amount),
      transaction_uuid,
      product_code,
      product_service_charge: String(product_service_charge),
      product_delivery_charge: String(product_delivery_charge),
      success_url: env.ESEWA_SUCCESS_URL,
      failure_url: env.ESEWA_FAILURE_URL,
      signed_field_names: "total_amount,transaction_uuid,product_code",
      signature,
    };

    return jsonResponse({
      action_url: env.ESEWA_GATEWAY_URL || "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
      payload,
    });
  } catch (err) {
    return jsonResponse({ error: err.message || "eSewa initiation failed" }, 500);
  }
}

// ============================================
// KHALTI
// ============================================
async function handleKhalti(request, env) {
  try {
    const body = await request.json();
    const amount = Number(body.amount);
    if (!amount || amount <= 0) return jsonResponse({ error: "Invalid amount" }, 400);

    const secret_key = env.KHALTI_SECRET_KEY;
    const gateway_url = env.KHALTI_GATEWAY_URL || "https://a.khalti.com/api/v2/epayment/initiate/";
    if (!secret_key) return jsonResponse({ error: "Khalti secret key not configured" }, 500);

    const amountInPaisa = Math.round(amount * 100);
    const payload = {
      return_url: env.KHALTI_RETURN_URL,
      website_url: env.KHALTI_WEBSITE_URL,
      amount: amountInPaisa,
      purchase_order_id: generateTxnId(),
      purchase_order_name: "Kingdom Expansion Partnership",
    };

    const khaltiRes = await fetch(gateway_url, {
      method: "POST",
      headers: { "Authorization": `Key ${secret_key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await khaltiRes.json();
    if (!khaltiRes.ok) return jsonResponse({ error: data.detail || data.error_key || "Khalti initiation failed", raw: data }, khaltiRes.status);

    return jsonResponse({ payment_url: data.payment_url, pidx: data.pidx });
  } catch (err) {
    return jsonResponse({ error: err.message || "Khalti initiation failed" }, 500);
  }
}

// ============================================
// BLOG — helpers
// ============================================
function githubHeaders(env) {
  return {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "KEP-Blog-Admin",
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json",
  };
}

function blogPath(env, slug) {
  return `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/src/content/blog/${slug}.md`;
}

// GET — list all posts
async function handleBlogList(request, env) {
  try {
    if (!env.GITHUB_TOKEN) return jsonResponse({ error: "GITHUB_TOKEN not configured" }, 500);

    const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/src/content/blog?ref=main`;
    const res = await fetch(url, { headers: githubHeaders(env) });

    if (!res.ok) {
      const err = await res.json();
      return jsonResponse({ error: err.message || "Failed to list posts" }, res.status);
    }

    const files = await res.json();
    const posts = Array.isArray(files)
      ? files
          .filter(f => f.name.endsWith(".md"))
          .map(f => ({
            name: f.name,
            slug: f.name.replace(/\.md$/, ""),
            sha: f.sha,
            size: f.size,
          }))
      : [];

    return jsonResponse({ posts });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// POST — create or update a post
async function handleBlogCreate(request, env) {
  try {
    if (!env.GITHUB_TOKEN) return jsonResponse({ error: "GITHUB_TOKEN not configured" }, 500);

    const body = await request.json();
    const { title, description, body: content, author, slug: providedSlug } = body;

    if (!title || !content) return jsonResponse({ error: "Title and body are required" }, 400);

    const finalSlug = providedSlug ? slugify(providedSlug) : slugify(title);
    if (!finalSlug) return jsonResponse({ error: "Could not generate a valid slug from the title" }, 400);

    const date = new Date().toISOString().split("T")[0];
    const escTitle = String(title).replace(/"/g, '\\"');
    const escDesc = String(description || "").replace(/"/g, '\\"');
    const finalAuthor = author || "Kingdom Expansion Partnership";

    const markdown = `---
title: "${escTitle}"
description: "${escDesc}"
pubDate: ${date}
author: "${finalAuthor}"
---

${content}
`;

    // Check if file already exists
    const checkRes = await fetch(blogPath(env, finalSlug), { headers: githubHeaders(env) });
    let sha = undefined;
    if (checkRes.ok) {
      const existing = await checkRes.json();
      sha = existing.sha;
    }

    const payload = {
      message: sha ? `Update post: ${title}` : `New post: ${title}`,
      content: b64EncodeUtf8(markdown),
      branch: "main",
    };
    if (sha) payload.sha = sha;

    const res = await fetch(blogPath(env, finalSlug), {
      method: "PUT",
      headers: githubHeaders(env),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json();
      return jsonResponse({ error: err.message || "GitHub commit failed" }, res.status);
    }

    const data = await res.json();

    return jsonResponse({
      success: true,
      slug: finalSlug,
      url: `${env.SITE_URL || ""}/blog/${finalSlug}/`,
      commit: data.commit?.sha,
      mode: sha ? "updated" : "created",
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// POST — delete a post
async function handleBlogDelete(request, env) {
  try {
    if (!env.GITHUB_TOKEN) return jsonResponse({ error: "GITHUB_TOKEN not configured" }, 500);

    const { slug } = await request.json();
    if (!slug) return jsonResponse({ error: "Slug is required" }, 400);

    // Get current file to find its sha
    const checkRes = await fetch(blogPath(env, slug), { headers: githubHeaders(env) });
    if (!checkRes.ok) return jsonResponse({ error: "Post not found" }, 404);
    const existing = await checkRes.json();

    const res = await fetch(blogPath(env, slug), {
      method: "DELETE",
      headers: githubHeaders(env),
      body: JSON.stringify({
        message: `Delete post: ${slug}`,
        sha: existing.sha,
        branch: "main",
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      return jsonResponse({ error: err.message || "Delete failed" }, res.status);
    }

    return jsonResponse({ success: true, slug });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}