import proxy from './proxy.js';

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

    let body;
    try {
      body = await request.json();
    } catch (err) {
      return new Response('bad json', {
        status: 400,
        headers: { 'content-type': 'text/plain' }
      });
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
