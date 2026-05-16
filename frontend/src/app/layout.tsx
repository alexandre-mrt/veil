import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Veil — Private Payments on Sui",
  description:
    "Anonymous below threshold. Compliant above. Zero-knowledge proofs protect your spending.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
