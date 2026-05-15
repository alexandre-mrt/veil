import type { Metadata } from "next";
import dynamic from "next/dynamic";
import "./globals.css";

const Providers = dynamic(
  () => import("./providers").then((m) => m.Providers),
  { ssr: false },
);

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
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
