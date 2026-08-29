/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `pg` is a native-ish dependency; keep it external so the serverless bundle
  // does not try to inline it.
  serverExternalPackages: ['pg'],
  // The migration route reads these at runtime; without tracing them in they
  // are not bundled into the serverless function.
  outputFileTracingIncludes: {
    '/api/admin/migrate': ['./supabase/**/*.sql']
  }
};
export default nextConfig;
