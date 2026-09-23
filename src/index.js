// ============================================
// KEP Payment Worker
// Secure bridge between the KEP site and eSewa + Khalti
// ============================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Helper: unique transaction ID
function generateTxnId() {
  return `KEP-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

// Helper: JSON response
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ============================================
// MAIN FETCH HANDLER
// ============================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check
    if (path === "/" || path === "/health") {
      return jsonResponse({
        status: "ok",
        service: "KEP Payment Worker",
        endpoints: ["/api/esewa/initiate", "/api/khalti/initiate"],
      });
    }

    // eSewa initiation
    if (path === "/api/esewa/initiate" && request.method === "POST") {
      return handleEsewa(request, env);
    }

    // Khalti initiation
    if (path === "/api/khalti/initiate" && request.method === "POST") {
      return handleKhalti(request, env);
    }

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

    if (!amount || amount <= 0) {
      return jsonResponse({ error: "Invalid amount" }, 400);
    }

    const tax_amount = 0;
    const product_service_charge = 0;
    const product_delivery_charge = 0;
    const total_amount = amount + tax_amount + product_service_charge + product_delivery_charge;

    const transaction_uuid = generateTxnId();
    const product_code = env.ESEWA_PRODUCT_CODE;
    const secret_key = env.ESEWA_SECRET_KEY;

    if (!product_code || !secret_key) {
      return jsonResponse({ error: "eSewa credentials not configured" }, 500);
    }

    // eSewa signature: HMAC-SHA256 of the specified fields
    const message = `total_amount=${total_amount},transaction_uuid=${transaction_uuid},product_code=${product_code}`;

    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret_key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      encoder.encode(message)
    );
    const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

    const payload = {
      amount: String(amount),
      tax_amount: String(tax_amount),
      total_amount: String(total_amount),
      transaction_uuid: transaction_uuid,
      product_code: product_code,
      product_service_charge: String(product_service_charge),
      product_delivery_charge: String(product_delivery_charge),
      success_url: env.ESEWA_SUCCESS_URL,
      failure_url: env.ESEWA_FAILURE_URL,
      signed_field_names: "total_amount,transaction_uuid,product_code",
      signature: signature,
    };

    return jsonResponse({
      action_url: env.ESEWA_GATEWAY_URL || "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
      payload: payload,
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

    if (!amount || amount <= 0) {
      return jsonResponse({ error: "Invalid amount" }, 400);
    }

    const secret_key = env.KHALTI_SECRET_KEY;
    const gateway_url = env.KHALTI_GATEWAY_URL || "https://a.khalti.com/api/v2/epayment/initiate/";
    const return_url = env.KHALTI_RETURN_URL;
    const website_url = env.KHALTI_WEBSITE_URL;

    if (!secret_key) {
      return jsonResponse({ error: "Khalti secret key not configured" }, 500);
    }

    // Khalti expects amount in paisa (NPR * 100)
    const amountInPaisa = Math.round(amount * 100);

    const payload = {
      return_url: return_url,
      website_url: website_url,
      amount: amountInPaisa,
      purchase_order_id: generateTxnId(),
      purchase_order_name: "Kingdom Expansion Partnership",
    };

    const khaltiRes = await fetch(gateway_url, {
      method: "POST",
      headers: {
        "Authorization": `Key ${secret_key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await khaltiRes.json();

    if (!khaltiRes.ok) {
      return jsonResponse(
        { error: data.detail || data.error_key || "Khalti initiation failed", raw: data },
        khaltiRes.status
      );
    }

    return jsonResponse({
      payment_url: data.payment_url,
      pidx: data.pidx,
    });
  } catch (err) {
    return jsonResponse({ error: err.message || "Khalti initiation failed" }, 500);
  }
}