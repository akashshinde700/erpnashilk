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
