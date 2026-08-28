/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Un esborrany aprovat pot portar fins a 3 MB de documents adjunts
    // (`reply-attachments.ts`); el límit per defecte d'un Server Action és
    // 1 MB, que rebutjaria l'enviament abans no arribi a l'acció.
    serverActions: { bodySizeLimit: "4mb" },
  },
};

export default nextConfig;
