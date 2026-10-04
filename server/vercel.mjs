import proxy from './proxy.js';
import guard from './guard.js';

function clientIp(request) {
  const fwd = request.headers.get('x-forwarded-for') || '';
  return fwd.split(',')[0].trim() || request.headers.get('x-real-ip') || 'unknown';
}

function text(body, status) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

function methodNotAllowed(allowed) {
  return new Response('method not allowed', {
    status: 405,
    headers: { allow: allowed, 'content-type': 'text/plain' }
  });
}

function health(request) {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const info = proxy.health();
  return Response.json(info, { status: info.ok ? 200 : 503 });
}

function llmHandler(name, call) {
  return async function (request) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    if (!proxy.health().ok) {
      return new Response('no key', {
        status: 503,
        headers: { 'content-type': 'text/plain' }
      });
    }

    if (!guard.allow(clientIp(request))) return text('rate limited', 429);

    const raw = await request.text();
    if (raw.length > guard.MAX_BODY) return text('too large', 413);

    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch (err) {
      return text('bad json', 400);
    }

    try {
      return Response.json(await call(body));
    } catch (err) {
      console.error('[' + name + '] ' + err.message);
      return Response.json({ error: err.message }, { status: 502 });
    }
  };
}

export const handleHealth = health;
export const handleIntent = llmHandler('intent', proxy.callIntent);
export const handleDoctrine = llmHandler('doctrine', proxy.callDoctrine);
