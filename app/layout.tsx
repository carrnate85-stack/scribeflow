import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ScribeFlow — Clinical Dictation",
  description:
    "A focused medical dictation workspace with reusable quicktext and clinical note templates.",
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
