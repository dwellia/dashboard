export const config = { runtime: 'edge' };

export default async function handler(req) {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/login.html',
      'Set-Cookie': 'dwellia_auth=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
    }
  });
}
