import type { ReactNode } from "react";
import { APP_NAME } from "@correu-agent/shared";

export const metadata = {
  title: APP_NAME,
  description: "Automatització de correu per a empreses.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ca">
      <body>{children}</body>
    </html>
  );
}
