import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GUMBALL Blitz",
  description: "Arcade-style gumball machine match-3 game made with Next.js and Phaser.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
