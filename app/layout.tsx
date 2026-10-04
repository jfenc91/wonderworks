import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wonderworks · Requirements Studio",
  description: "Think Big. Imagine Built. Shape ideas into clear requirements, connected decisions, and products that work.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
