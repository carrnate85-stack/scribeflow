import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ScribeFlow — Clinical Notes",
  description:
    "A private-in-browser clinical note workspace with PDF imports, HST tools, Quicktext, and reusable templates.",
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
