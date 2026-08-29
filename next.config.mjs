/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `pg` is a native-ish dependency; keep it external so the serverless bundle
  // does not try to inline it.
  serverExternalPackages: ['pg']
};
export default nextConfig;
