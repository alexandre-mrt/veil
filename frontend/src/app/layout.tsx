import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Veil — Private Payments on Sui",
  description:
    "Confidential compliance proofs on Sui: amounts hidden, spending threshold proven in zero-knowledge. Sender remains visible on-chain.",
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
