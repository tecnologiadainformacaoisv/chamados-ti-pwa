// =====================================================================
// CHAMADOS TI – PUSH NOTIFICATION WORKER
// Cloudflare Worker — cola este arquivo no editor do dashboard
//
// Variáveis de ambiente (Settings → Variables → Add):
//   VAPID_PUBLIC_KEY  → chave pública gerada (PUBLIC_KEY)
//   VAPID_PRIVATE_JWK → chave privada em JSON (PRIVATE_JWK)
//   CLICKUP_API_KEY   → chave da API do ClickUp (marcar como secret)
//
// KV Namespace (Settings → KV Namespace Bindings → Add):
//   Nome da variável: SUBSCRIPTIONS
// =====================================================================

const SOLICITANTE_FIELD_ID = '9f111ee8-923a-4080-bf8f-1c03eee2f7cb';
const VAPID_SUBJECT        = 'mailto:henrique.krvalho@gmail.com';

const NOTIFY_STATUSES = {
  'em atendimento': 'Em Atendimento',
  'pendente':       'Pendente',
  'encerrado':      'Encerrado'
};

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// =====================================================================
// ROUTER
// =====================================================================
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'POST') {
      return new Response('Chamados TI – Push Worker OK', { status: 200 });
    }

    const { pathname } = new URL(request.url);

    if (pathname === '/subscribe') return handleSubscribe(request, env);
    if (pathname === '/webhook')   return handleWebhook(request, env);

    return new Response('Not Found', { status: 404 });
  }
};

// =====================================================================
// /subscribe — salva subscription do usuário no KV
// Body: { user_idx: number, subscription: PushSubscription }
// =====================================================================
async function handleSubscribe(request, env) {
  try {
    const { user_idx, subscription } = await request.json();

    if (user_idx == null || !subscription?.endpoint) {
      return jsonRes({ error: 'user_idx ou subscription ausente' }, 400);
    }

    await env.SUBSCRIPTIONS.put(`u_${user_idx}`, JSON.stringify(subscription));
    return jsonRes({ ok: true });
  } catch (err) {
    return jsonRes({ error: err.message }, 500);
  }
}

// =====================================================================
// /webhook — recebe evento taskStatusUpdated do ClickUp
// =====================================================================
async function handleWebhook(request, env) {
  try {
    const body = await request.json();

    if (body.event !== 'taskStatusUpdated') {
      return new Response('ignored', { status: 200 });
    }

    const newStatus = (body.history_items?.[0]?.after?.status ?? '').toLowerCase();
    const label     = NOTIFY_STATUSES[newStatus];

    if (!label) return new Response(`status "${newStatus}" ignorado`, { status: 200 });

    // Busca detalhes da tarefa para identificar o solicitante
    const taskResp = await fetch(
      `https://api.clickup.com/api/v2/task/${body.task_id}`,
      { headers: { Authorization: env.CLICKUP_API_KEY } }
    );
    if (!taskResp.ok) return new Response('task fetch error', { status: 200 });

    const task    = await taskResp.json();
    const cf      = task.custom_fields?.find(f => f.id === SOLICITANTE_FIELD_ID);
    const userIdx = cf?.value?.orderindex ?? cf?.value;

    if (userIdx == null) return new Response('sem solicitante', { status: 200 });

    const subJson = await env.SUBSCRIPTIONS.get(`u_${userIdx}`);
    if (!subJson)  return new Response(`sem subscription para user ${userIdx}`, { status: 200 });

    await sendWebPush(JSON.parse(subJson), JSON.stringify({
      title: 'Chamados de TI – ISV',
      body:  `"${task.name}" está agora: ${label}`,
      data:  { task_id: task.id, status: newStatus }
    }), env);

    return new Response('ok', { status: 200 });
  } catch (err) {
    console.error('Webhook error:', err);
    return new Response('error: ' + err.message, { status: 500 });
  }
}

// =====================================================================
// WEB PUSH — RFC 8030 + RFC 8291 (aes128gcm) + RFC 8292 (VAPID)
// =====================================================================
async function sendWebPush(sub, payloadStr, env) {
  const receiverPub  = urlB64ToBytes(sub.keys.p256dh);
  const authSecret   = urlB64ToBytes(sub.keys.auth);
  const enc          = new TextEncoder();

  // Ephemeral sender key pair
  const senderPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']
  );
  const senderPubBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', senderPair.publicKey)
  );

  // ECDH shared secret
  const receiverKey = await crypto.subtle.importKey(
    'raw', receiverPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const sharedBits  = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: receiverKey }, senderPair.privateKey, 256
  );
  const sharedSecret = new Uint8Array(sharedBits);

  // Random salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // RFC 8291 §3.3 key derivation
  const prkCombine = await hkdfExtract(authSecret, sharedSecret);
  const keyInfo    = concat(enc.encode('WebPush: info'), new Uint8Array([0]), receiverPub, senderPubBytes);
  const ikm        = await hkdfExpand(prkCombine, keyInfo, 32);

  const prk       = await hkdfExtract(salt, ikm);
  const cek       = await hkdfExpand(prk, concat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce     = await hkdfExpand(prk, concat(enc.encode('Content-Encoding: nonce'),     new Uint8Array([0])), 12);

  // Encrypt
  const plaintext = concat(enc.encode(payloadStr), new Uint8Array([0x02]));
  const cekKey    = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, plaintext)
  );

  // aes128gcm binary frame: salt(16) | rs(4) | keyid_len(1) | keyid(65) | ciphertext
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const body = concat(salt, rs, new Uint8Array([senderPubBytes.length]), senderPubBytes, ciphertext);

  // VAPID JWT
  const { token, publicKey } = await createVapidJwt(sub.endpoint, env);

  const resp = await fetch(sub.endpoint, {
    method:  'POST',
    headers: {
      'Authorization':    `vapid t=${token},k=${publicKey}`,
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '86400',
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Push endpoint ${resp.status}: ${text}`);
  }
}

// =====================================================================
// VAPID JWT (ES256)
// =====================================================================
async function createVapidJwt(endpoint, env) {
  const audience = new URL(endpoint).origin;
  const now      = Math.floor(Date.now() / 1000);
  const header   = urlSafeB64Encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload  = urlSafeB64Encode(JSON.stringify({ aud: audience, exp: now + 43200, sub: VAPID_SUBJECT }));
  const sigInput = `${header}.${payload}`;

  const privateKey = await crypto.subtle.importKey(
    'jwk',
    JSON.parse(env.VAPID_PRIVATE_JWK),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(sigInput))
  );

  return { token: `${sigInput}.${bytesToUrlB64(sig)}`, publicKey: env.VAPID_PUBLIC_KEY };
}

// =====================================================================
// HKDF (RFC 5869)
// =====================================================================
async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm));
}

async function hkdfExpand(prk, info, length) {
  const key  = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  let T      = new Uint8Array(0);
  let result = new Uint8Array(0);
  for (let i = 1; i <= Math.ceil(length / 32); i++) {
    T      = new Uint8Array(await crypto.subtle.sign('HMAC', key, concat(T, info, new Uint8Array([i]))));
    result = concat(result, T);
  }
  return result.slice(0, length);
}

// =====================================================================
// UTILS
// =====================================================================
function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let i = 0;
  for (const a of arrays) { out.set(a, i); i += a.length; }
  return out;
}

function urlB64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function bytesToUrlB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function urlSafeB64Encode(str) {
  return bytesToUrlB64(new TextEncoder().encode(str));
}

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}
