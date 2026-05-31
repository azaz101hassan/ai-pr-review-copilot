/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Local-dev CORS avoidance: proxy /api/* to the NestJS API on port 3001.
  // This lets the browser hit same-origin /api/... URLs so EventSource and
  // fetch calls require no CORS preflight. Day-10 Vercel deployment will
  // replace this with a real cross-origin setup.
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:3001/:path*',
      },
    ];
  },
};

module.exports = nextConfig;
