/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  images: {
    // Posters/backdrops are arbitrary user-provided URLs; skip the optimizer.
    unoptimized: true,
  },
};

export default nextConfig;
