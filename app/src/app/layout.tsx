import type { ReactNode } from "react";
import { IBM_Plex_Mono, Source_Sans_3, Space_Grotesk } from "next/font/google";
import { APP_NAME } from "@correu-agent/shared";
import "./globals.css";

// Three-role type system (design brief): Space Grotesk carries the product's
// voice in headings/nav/buttons, Source Sans 3 does the reading work in body
// copy and tables, IBM Plex Mono sets category stamps, dates and addresses —
// the "typewritten" metadata layer of a piece of mail.
const displayFont = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-space-grotesk",
});

const bodyFont = Source_Sans_3({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-source-sans",
});

const monoFont = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-plex-mono",
});

export const metadata = {
  title: APP_NAME,
  description: "Automatització de correu per a empreses.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="ca"
      className={`${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
