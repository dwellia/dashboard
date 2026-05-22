export const config = {
  matcher: [
    '/((?!api/login|login\\.html|_next|favicon\\.ico).*)'
  ]
};

export default function middleware(req) {
  const { pathname } = new URL(req.url);

  // Always allow login page and login API
  if (pathname === '/login.html' || pathname === '/api/login') {
    return Response.next?.() ?? new Response(null, { status: 200 });
  }

  // Check auth cookie
  const cookies = req.headers.get('cookie') || '';
  const authCookie = cookies
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith('dwellia_auth='));

  if (!authCookie) {
    return Response.redirect(new URL('/login.html', req.url));
  }

  const cookieValue = authCookie.split('=')[1];
  if (cookieValue !== process.env.COOKIE_SECRET) {
    return Response.redirect(new URL('/login.html', req.url));
  }

  return new Response(null, { status: 200, headers: { 'x-middleware-next': '1' } });
}
