/** @type {import('next').NextConfig} */
const nextConfig = {
  // WebLLM loads WASM + (optionally threaded) workers and needs cross-origin
  // isolation for SharedArrayBuffer. These headers are safe defaults for a
  // fully client-side inference app.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};

export default nextConfig;
