/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A stray lockfile above this directory makes Next infer the wrong workspace
  // root, so file tracing differs between a laptop and the build server. Pin it.
  outputFileTracingRoot: import.meta.dirname,
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
