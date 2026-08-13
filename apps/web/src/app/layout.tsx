import type { Metadata } from "next";

import { StoreProvider } from "@/store/provider";

import "./globals.css";

export const metadata: Metadata = {
  title: "AURA",
  description: "Self-Hosted Multilingual Autonomous Voice Agent",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <StoreProvider>{children}</StoreProvider>
      </body>
    </html>
  );
}
