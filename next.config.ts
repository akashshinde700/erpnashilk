import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Opt-in escape hatch for offline/sandbox builds: `NEXT_SKIP_TYPECHECK=1 next build`.
  // Never set in a normal or production build.
  typescript: process.env.NEXT_SKIP_TYPECHECK === "1" ? { ignoreBuildErrors: true } : undefined,
  poweredByHeader: false,
  reactStrictMode: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // Nothing in the app is meant to be framed: refuse clickjacking. (No X-Frame-Options here: the
          // CloudPanel vhost already sends SAMEORIGIN, and a second, different value makes browsers drop
          // both; CSP frame-ancestors takes precedence over it anyway.)
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          // Browsers ignore this on plain http (local runs); production is served over https only
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
      {
        // API responses carry tenant data — never cache them in shared caches.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
