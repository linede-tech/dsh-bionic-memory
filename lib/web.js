/**
 * Local HTTP data plane for the brain monitor panel.
 *
 * These routes are same-origin only: the request must come from loopback or a
 * private LAN address, must not be a cross-site fetch, and must pass the
 * Harness connection check when that service is mounted.
 */

const ROUTE_PREFIX = '/dsh-bionic-memory';

function header(request, name) {
  const value = request?.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function remoteAddress(request) {
  return request?.socket?.remoteAddress || request?.connection?.remoteAddress || '';
}

function isLoopback(value) {
  const address = String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
  return (
    address === 'localhost' ||
    address === 'localhost.' ||
    address === '::1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
  );
}

function isPrivateLan(value) {
  const address = String(value || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!address) return false;
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  return (
    /^192\.168\./.test(ipv4) ||
    ipv4.startsWith('10.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ipv4)
  );
}

function isTrusted(ctx, request) {
  const site = header(request, 'sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') return false;

  const address = remoteAddress(request);
  const loopback = isLoopback(address);
  if (!loopback && !isPrivateLan(address)) return false;

  const origin = header(request, 'origin');
  if (origin !== undefined) {
    if (origin === 'null') return false;
    try {
      const url = new URL(origin);
      const host = header(request, 'host');
      if (host && url.host.toLowerCase() === String(host).toLowerCase()) {
        // same-origin page request
      } else if (!(isLoopback(url.hostname) && loopback)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  try {
    const connection = ctx.get?.('connection');
    if (connection && typeof connection.requestRejection === 'function') {
      if (connection.requestRejection(request) !== undefined) return false;
    }
  } catch {
    return false;
  }
  return true;
}

function writeJson(response, status, body) {
  try {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(JSON.stringify(body));
  } catch {
    /* socket already closed */
  }
}

function readBody(request, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('invalid json'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

/**
 * Register the monitor routes.
 * @returns {() => void} disposer
 */
export function registerWebRoutes({ ctx, getEngine, logger }) {
  const disposers = [];

  const handle = (method, path, handler) => {
    disposers.push(
      ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}${path}`,
        handler: async (request, response) => {
          if (request.method !== method) {
            writeJson(response, 405, { ok: false, error: `Method ${method} required` });
            return;
          }
          if (!isTrusted(ctx, request)) {
            writeJson(response, 403, { ok: false, error: 'Forbidden' });
            return;
          }
          try {
            await handler(request, response);
          } catch (error) {
            logger?.warn?.(`[bionic-memory] route ${path} failed: ${error?.message || error}`);
            writeJson(response, error?.statusCode || 500, {
              ok: false,
              error: String(error?.message || error),
            });
          }
        },
      }),
    );
  };

  handle('GET', '/state', async (_request, response) => {
    const engine = await getEngine();
    writeJson(response, 200, engine.state());
  });

  handle('POST', '/dream', async (_request, response) => {
    const engine = await getEngine();
    const result = await engine.dream({ trigger: 'manual' });
    writeJson(response, result.ok ? 200 : 500, result);
  });

  handle('POST', '/forget', async (request, response) => {
    const engine = await getEngine();
    const body = await readBody(request);
    const target = String(body?.target || 'faded');
    if (target === 'all' && body?.confirm !== 'all') {
      writeJson(response, 400, { ok: false, error: 'Forgetting everything requires {"confirm":"all"}' });
      return;
    }
    const result = engine.forget(target);
    writeJson(response, result.ok ? 200 : 400, result);
  });

  handle('POST', '/curiosity/resolve', async (request, response) => {
    const engine = await getEngine();
    const body = await readBody(request);
    const remaining = engine.resolveCuriosity(String(body?.id || body?.text || ''));
    writeJson(response, 200, { ok: true, remaining });
  });

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* registration already gone */
      }
    }
  };
}

export { ROUTE_PREFIX };
