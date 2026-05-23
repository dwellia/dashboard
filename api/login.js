export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try { body = await req.json(); }
  catch { return new Response('Bad request', { status: 400 }); }

  const { password } = body;

  if (!password || password !== process.env.DASHBOARD_PASSWORD) {
    return new Response(JSON.stringify({ error: 'Invalid password' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const maxAge = 60 * 60 * 24 * 30; // 30 days
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `dwellia_auth=${process.env.COOKIE_SECRET}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
    }
  });
}
